import { describe, expect, it } from "vitest";
import { filterDrafts, type XDraft } from "./draft-guard";

const single = (text: string, angle = "insight"): XDraft => ({ texts: [text], angle });

describe("filterDrafts", () => {
  it("keeps clean drafts", () => {
    const { kept, dropped } = filterDrafts([single("A perfectly fine tweet.")]);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("drops a thread when ONE segment is over 280 chars; other drafts survive", () => {
    const thread: XDraft = { texts: ["ok segment", "x".repeat(300), "closing segment"], angle: "insight" };
    const { kept, dropped } = filterDrafts([single("fine"), thread, single("also fine", "promo")]);
    expect(kept.map((d) => d.texts[0])).toEqual(["fine", "also fine"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.violations.join(" ")).toMatch(/segment 2/i);
    expect(dropped[0]!.violations.join(" ")).toMatch(/300 chars/);
  });

  it("drops drafts with no segments", () => {
    const { kept, dropped } = filterDrafts([{ texts: [], angle: "insight" }]);
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.violations.join(" ")).toMatch(/empty/i);
  });

  it("drops blank segments", () => {
    const { dropped } = filterDrafts([{ texts: ["real text", "   "], angle: "insight" }]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.violations.join(" ")).toMatch(/segment 2/i);
  });
});
