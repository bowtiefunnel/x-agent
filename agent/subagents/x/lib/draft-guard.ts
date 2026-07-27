import { checkContent } from "../../../lib/guardrails";

/**
 * Per-segment guardrail loop (Gate 3: the LLM never self-reports compliance — code
 * measures). A draft is one tweet (texts.length === 1) or a thread; ANY violating
 * segment drops the whole draft, surviving drafts pass through untouched.
 */

export interface XDraft {
  texts: string[];
  angle: string;
}

export const TWEET_MAX_CHARS = 280;

export function filterDrafts(drafts: XDraft[]): {
  kept: XDraft[];
  dropped: Array<{ draft: XDraft; violations: string[] }>;
} {
  const kept: XDraft[] = [];
  const dropped: Array<{ draft: XDraft; violations: string[] }> = [];

  for (const draft of drafts) {
    const violations: string[] = [];
    if (!draft.texts.length) violations.push("empty draft (no segments)");
    draft.texts.forEach((segment, i) => {
      if (!segment.trim()) {
        violations.push(`segment ${i + 1}: empty`);
        return;
      }
      const check = checkContent(segment, { maxChars: TWEET_MAX_CHARS });
      if (!check.ok) violations.push(...check.violations.map((v) => `segment ${i + 1}: ${v}`));
    });
    if (violations.length) dropped.push({ draft, violations });
    else kept.push(draft);
  }

  return { kept, dropped };
}
