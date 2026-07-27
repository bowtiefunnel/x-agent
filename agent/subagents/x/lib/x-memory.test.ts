import { describe, expect, it } from "vitest";
import { foldXMemory, memoryBlock, hasCardForDay, type XCardRow } from "./x-memory";

const row = (over: Partial<XCardRow> & { status: string }): XCardRow => ({
  payload: {},
  created_at: "2026-07-14T13:00:00Z",
  ...over,
});

describe("foldXMemory", () => {
  it("collects rejected drafts with angle and deny reason", () => {
    const mem = foldXMemory([
      row({ status: "rejected", payload: { texts: ["Hot take about CRMs"], angle: "contrarian", denyReason: "too spicy" } }),
      row({ status: "pending", payload: { texts: ["Undecided"], angle: "insight" } }),
    ]);
    expect(mem.rejected).toEqual([{ text: "Hot take about CRMs", angle: "contrarian", reason: "too spicy" }]);
  });

  it("collects approved drafts (done counts as approved) capped at 15", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ status: i % 2 ? "approved" : "done", payload: { texts: [`tweet ${i}`], angle: "insight" } }),
    );
    const mem = foldXMemory(rows);
    expect(mem.approved).toHaveLength(15);
    expect(mem.approved[0]).toEqual({ text: "tweet 0", angle: "insight" });
  });

  it("normalizes legacy single-text payloads and joins thread segments", () => {
    const mem = foldXMemory([
      row({ status: "approved", payload: { text: "legacy tweet", angle: "promo" } }),
      row({ status: "rejected", payload: { texts: ["seg one", "seg two"], angle: "insight", denyReason: "" } }),
    ]);
    expect(mem.approved[0]!.text).toBe("legacy tweet");
    expect(mem.rejected[0]!.text).toBe("seg one\nseg two");
  });

  it("computes confidence from decided rows only, null before any decision", () => {
    expect(foldXMemory([row({ status: "pending", payload: { texts: ["x"] } })]).confidence.rate).toBeNull();
    const mem = foldXMemory([
      row({ status: "approved", payload: { texts: ["a"] } }),
      row({ status: "done", payload: { texts: ["b"] } }),
      row({ status: "rejected", payload: { texts: ["c"] } }),
      row({ status: "pending", payload: { texts: ["d"] } }),
    ]);
    expect(mem.confidence).toEqual({ approved: 2, denied: 1, decided: 3, rate: 2 / 3 });
  });

  it("skips rows without usable text", () => {
    const mem = foldXMemory([row({ status: "approved", payload: { angle: "insight" } })]);
    expect(mem.approved).toHaveLength(0);
    expect(mem.confidence.decided).toBe(0);
  });
});

describe("memoryBlock", () => {
  it("is empty when there is no history", () => {
    expect(memoryBlock(foldXMemory([]))).toBe("");
  });

  it("renders rejected with reasons and approved as do-not-repeat", () => {
    const block = memoryBlock(
      foldXMemory([
        row({ status: "rejected", payload: { texts: ["Bad tweet"], angle: "promo", denyReason: "too salesy" } }),
        row({ status: "approved", payload: { texts: ["Good tweet"], angle: "insight" } }),
      ]),
    );
    expect(block).toContain("REJECTED");
    expect(block).toContain('“Bad tweet” — reason: "too salesy"');
    expect(block).toContain("[promo]");
    expect(block).toContain("APPROVED");
    expect(block).toContain("Good tweet");
  });
});

describe("hasCardForDay", () => {
  it("detects an existing card on the given UTC day", () => {
    const rows = [row({ status: "pending", payload: { texts: ["x"] }, created_at: "2026-07-15T02:11:00Z" })];
    expect(hasCardForDay(rows, "2026-07-15")).toBe(true);
    expect(hasCardForDay(rows, "2026-07-14")).toBe(false);
    expect(hasCardForDay([row({ status: "pending", payload: {}, created_at: undefined })], "2026-07-15")).toBe(false);
  });
});
