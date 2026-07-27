import {
  foldDraftMemory,
  draftMemoryBlock,
  hasCardForDay,
  type DraftCardRow,
  type DraftMemory,
} from "../../../lib/draft-memory";

/**
 * X agent learning ledger — the shared draft ledger (`shared/lib/draft-memory`) bound
 * to `X Post` payloads. The fold/block/idempotency logic moved there when the LinkedIn
 * twin landed; what stays X-specific is reading a thread out of the payload.
 */

export type XCardRow = DraftCardRow;
export type XMemory = DraftMemory;
export { hasCardForDay };

/** Normalize `{texts: string[]}` (current) or `{text: string}` (legacy) to one string. */
function draftText(payload: Record<string, unknown>): string | null {
  if (Array.isArray(payload.texts) && payload.texts.every((t) => typeof t === "string") && payload.texts.length) {
    return (payload.texts as string[]).join("\n");
  }
  if (typeof payload.text === "string" && payload.text) return payload.text;
  return null;
}

export function foldXMemory(rows: XCardRow[]): XMemory {
  return foldDraftMemory(rows, draftText);
}

/** Render the ledger as the PRIOR CONTEXT prompt block ("" when there's no history). */
export function memoryBlock(mem: XMemory): string {
  return draftMemoryBlock(mem, "tweets");
}
