import { logger, schemaTask, schedules } from "@trigger.dev/sdk";
import { generateStructured } from "../../connections/openrouter";
import { insertCards, auditLog, listProjects, listRecentCards } from "../../connections/supabase";
import { postMessage } from "../../connections/slack";
import { perFixReviewCard } from "../../lib/blocks";
import { brandSystemPreamble } from "../../lib/company-context";
import { AgentPayload, type Project } from "../../schemas";
import { langfuse, flushLangfuse } from "../../connections/langfuse";
import { runWithObservability, currentObs } from "../../lib/trace";
import { foldXMemory, memoryBlock, hasCardForDay, type XCardRow } from "./lib/x-memory";
import { filterDrafts, TWEET_MAX_CHARS, type XDraft } from "./lib/draft-guard";

/**
 * Daily X (Twitter) Agent — draft-only (replaces the retired waitpoint-era stub).
 * Once a day per project:
 *   1. same-day idempotency check (a crashed re-run must not duplicate cards or
 *      re-ping Slack), then fold prior decisions into the learning ledger;
 *   2. ONE LLM call drafts 4 single tweets + 1 thread across varied angles, steered
 *      by the ledger (rejected angles never return; approved texts aren't repeated);
 *   3. deterministic per-segment guardrails (280 chars, brand rules) — violators
 *      dropped and logged, never self-reported by the model;
 *   4. one pending card per draft → ONE Slack message with an Approve/Deny pair PER
 *      draft (bare card ids — the gateway PATCHes `cards`), confidence rate in the
 *      header. Post-and-finish; Approve records "I'll post this" (operator
 *      copy-pastes to X — no OAuth by design, see the spec's trust model).
 */

const ANGLES = "insight, contrarian opinion, engagement question, trend take, soft promo";

const DRAFTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    drafts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          texts: { type: "array", items: { type: "string" } },
          angle: { type: "string" },
        },
        required: ["texts", "angle"],
      },
    },
  },
  required: ["drafts"],
} as const;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runDailyX(project: Project): Promise<{ staged: number; skipped?: true }> {
  // 1. One cards read serves idempotency + memory + confidence.
  let rows: XCardRow[] = [];
  try {
    rows = await listRecentCards(project.projectId, "X Post", 60);
  } catch (err) {
    // Graceful degradation: a repeat-ish draft beats no drafts. (If cards reads are
    // down, the insert below will fail loudly anyway — no duplicate risk.)
    logger.warn("X memory unavailable — running memory-less", { err: String(err) });
  }
  const today = dayKey();
  if (hasCardForDay(rows, today)) {
    logger.info("X drafts already staged today — skipping (idempotent re-run)", { projectId: project.projectId, day: today });
    return { staged: 0, skipped: true };
  }
  const memory = foldXMemory(rows);
  const priorBlock = memoryBlock(memory);

  // 2. ONE structured call → 4 singles + 1 thread. (The only neural step.)
  const result = await generateStructured<{ drafts: XDraft[] }>({
    system:
      brandSystemPreamble(project) +
      "\n\nYou are the brand's X (Twitter) voice. Draft tweets that sound like a sharp " +
      "operator, not a marketing department: specific, concrete, no hashtag spam, no hype. " +
      `Each tweet ≤ ${TWEET_MAX_CHARS} characters.`,
    prompt:
      (priorBlock ? `PRIOR CONTEXT (honor this):\n${priorBlock}\n\n` : "") +
      `Draft exactly 5 tweets for today across these angles (one each, vary the topics): ${ANGLES}.\n` +
      `- 4 must be SINGLE tweets: texts is an array with ONE string.\n` +
      `- 1 must be a THREAD of 3-6 tweets: texts is an array with one string per tweet, ` +
      `first tweet hooks, last tweet lands the point. Do not number the tweets — the ` +
      `platform shows position.\n` +
      `- angle: which of the five angles this draft takes.`,
    schema: DRAFTS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1800,
  });

  const drafts = Array.isArray(result?.drafts) ? result.drafts : [];
  if (!drafts.length) throw new Error("X draft generation returned no drafts");

  // 3. Deterministic guardrails, per segment.
  const { kept, dropped } = filterDrafts(drafts);
  for (const d of dropped) {
    logger.warn("X draft dropped by guardrails", { angle: d.draft.angle, violations: d.violations });
  }
  if (!kept.length) throw new Error("All X drafts violated guardrails — nothing to stage");

  // 4. Stage cards, then ONE Slack message with a per-draft Approve/Deny pair.
  const obs = currentObs();
  const cardIds = await insertCards(
    kept.map((d) => ({
      projectId: project.projectId,
      agent: "x-agent",
      type: "X Post" as const,
      status: "pending" as const,
      payload: { texts: d.texts, angle: d.angle, traceId: obs?.traceId },
    })),
  );

  const channel = process.env.SLACK_REVIEW_CHANNEL;
  if (channel) {
    const confLine =
      memory.confidence.rate !== null
        ? `*Confidence:* ${Math.round(memory.confidence.rate * 100)}% accepted over ${memory.confidence.decided} decided drafts`
        : "*Confidence:* no decisions yet — first runs are always fully reviewed";
    const card = perFixReviewCard({
      headerText: `🐦 Daily X drafts — ${project.name}`,
      introLines: [
        `*Date:* ${today}   ·   ${confLine}`,
        `Draft-only: *Approve = "I'll post this"* (copy-paste to X). Decide each draft below:`,
      ],
      fixes: kept.map((d, i) => ({
        title: d.texts.length > 1 ? `Thread (${d.texts.length} tweets) — ${d.angle}` : `Tweet — ${d.angle}`,
        summary: d.texts.length > 1 ? d.texts.map((t, j) => `${j + 1}/ ${t}`).join("\n") : (d.texts[0] ?? ""),
        metaLine: d.texts.map((t) => `${t.length}/${TWEET_MAX_CHARS}`).join(" · "),
        value: cardIds[i] ?? "", // bare card id → gateway PATCHes `cards`; insertCards returns 1 id per card
      })),
    });
    try {
      await postMessage({ channel, text: card.text, blocks: card.blocks });
    } catch (err) {
      logger.warn("X Slack card failed to post (cards already staged)", { err: String(err) });
    }
  }

  await auditLog({
    agent: "x-agent",
    projectId: project.projectId,
    action: "daily_x_drafts",
    detail: { staged: kept.length, dropped: dropped.length, day: today },
  });
  return { staged: kept.length };
}

export const dailyXDrafts = schemaTask({
  id: "daily-x-drafts",
  schema: AgentPayload,
  maxDuration: 300,
  run: async (payload, { ctx }) => {
    const lf = langfuse();
    if (!lf) return runDailyX(payload.project); // Langfuse disabled → run untraced
    const trace = lf.trace({
      id: ctx.run.id,
      name: "daily-x-drafts",
      metadata: { projectId: payload.project.projectId, url: payload.project.url },
    });
    try {
      return await runWithObservability(
        { traceId: ctx.run.id, trace, cost: { usd: 0, promptTokens: 0, completionTokens: 0 } },
        () => runDailyX(payload.project),
      );
    } finally {
      await flushLangfuse(); // short-lived container — flush before it dies
    }
  },
});

/** Daily schedule (13:00 UTC) — per-project fan-out. */
export const dailyXDraftsScheduled = schedules.task({
  id: "daily-x-drafts-scheduled",
  cron: "0 13 * * *",
  run: async (_payload, { ctx }) => {
    const projects = await listProjects();
    logger.info("Daily X fan-out", { count: projects.length, runId: ctx.run.id });
    for (const project of projects) await dailyXDrafts.trigger({ project });
    return { dispatched: projects.length };
  },
});
