import { describe, expect, it } from "vitest";
import { SubtitleHistoryAlignment } from "./subtitle-history-alignment";

describe("SubtitleHistoryAlignment", () => {
  it("pairs sentences after independently arriving fragments complete", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("For our purposes ");
    alignment.appendTranslation("就我们的目的而言，");
    alignment.appendOriginal("here, the system is a protein bound to a small molecule drug.");
    alignment.appendTranslation("这里，系统是一个结合了小分子药物的蛋白质。");

    expect(alignment.hist).toEqual([
      {
        id: 1,
        o: "For our purposes here, the system is a protein bound to a small molecule drug.",
        t: "就我们的目的而言，这里，系统是一个结合了小分子药物的蛋白质。",
      },
    ]);
  });

  it("does not pair an extra completed source sentence with the next translation", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("First sentence. Second sentence.");
    alignment.appendTranslation("第一句。");

    expect(alignment.hist).toEqual([{ id: 1, o: "First sentence.", t: "第一句。" }]);
    expect(alignment.snapshot().curO).toBe("Second sentence.");
    expect(alignment.snapshot().curT).toBe("");
    expect(alignment.snapshot().curId).toBe(2);
  });

  it("treats Chinese and English semicolons as sentence endings", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("First part; Second part.");
    alignment.appendTranslation("第一部分；第二部分。");

    expect(alignment.hist).toEqual([
      { id: 1, o: "First part;", t: "第一部分；" },
      { id: 2, o: "Second part.", t: "第二部分。" },
    ]);
    expect(alignment.snapshot().curO).toBe("");
    expect(alignment.snapshot().curT).toBe("");
  });

  it("keeps unfinished source and translation text visible", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("The next sentence is still");
    alignment.appendTranslation("下一句还在进行");

    expect(alignment.snapshot()).toEqual({
      history: [],
      curO: "The next sentence is still",
      curT: "下一句还在进行",
      curId: 1,
    });
  });

  it("flushes unpaired turn tails without moving them onto another sentence", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("One sentence.");
    alignment.appendTranslation("一句。第二句。 ");
    alignment.completeTurn();

    expect(alignment.hist).toEqual([
      { id: 1, o: "One sentence.", t: "一句。" },
      { id: 3, o: "", t: "第二句。" },
    ]);
  });

  it("assigns a stable id to the sentence currently being produced", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("Hello");
    expect(alignment.snapshot().curId).toBe(1);

    alignment.appendTranslation("你好");
    alignment.appendOriginal(" there.");
    alignment.appendTranslation("呀。");

    expect(alignment.hist).toEqual([{ id: 1, o: "Hello there.", t: "你好呀。" }]);
    expect(alignment.snapshot().curId).toBeNull();
  });

  it("keeps the current id until the pair is committed, then moves to the next sentence", () => {
    const alignment = new SubtitleHistoryAlignment();

    alignment.appendOriginal("First sentence. Second");
    expect(alignment.snapshot().curId).toBe(1);
    expect(alignment.snapshot().curO).toBe("First sentence. Second");

    alignment.appendOriginal(" sentence.");
    expect(alignment.snapshot().curId).toBe(1);

    alignment.appendTranslation("第一句。");
    expect(alignment.hist).toEqual([{ id: 1, o: "First sentence.", t: "第一句。" }]);
    expect(alignment.snapshot().curId).toBe(2);
    expect(alignment.snapshot().curO).toBe("Second sentence.");
  });

  it("preserves ids for unchanged records when replacing aligned history", () => {
    const alignment = new SubtitleHistoryAlignment();
    alignment.appendOriginal("First sentence.");
    alignment.appendTranslation("第一句。");
    alignment.replaceHistory([
      { o: "First sentence.", t: "第一句。" },
      { o: "Second sentence.", t: "第二句。" },
    ]);

    expect(alignment.hist.map((item) => item.id)).toEqual([1, 3]);
  });

  it("updates selected records without dropping the rest of history", () => {
    const alignment = new SubtitleHistoryAlignment();
    alignment.replaceHistoryItems([
      { id: 1, o: "First sentence.", t: "第一句。" },
      { id: 2, o: "Second sentence.", t: "第二句。" },
      { id: 3, o: "Third sentence.", t: "第三句。" },
      { id: 4, o: "Fourth sentence.", t: "第四句。" },
    ]);

    alignment.updateHistoryItems([{ id: 2, o: "Updated second sentence.", t: "更新后的第二句。" }]);

    expect(alignment.hist).toEqual([
      { id: 1, o: "First sentence.", t: "第一句。" },
      { id: 2, o: "Updated second sentence.", t: "更新后的第二句。" },
      { id: 3, o: "Third sentence.", t: "第三句。" },
      { id: 4, o: "Fourth sentence.", t: "第四句。" },
    ]);
  });

  it("keeps manual edits separate from AI-aligned row metadata", () => {
    const alignment = new SubtitleHistoryAlignment();
    alignment.replaceHistoryItems([
      { id: 1, o: "A. B.", t: "甲。乙。" },
      { id: 2, o: "C.", t: "丙。" },
    ]);
    alignment.markEdited([1]);
    alignment.updateHistoryItems([{ id: 1, o: "A.", t: "甲。" }]);

    expect(alignment.hist[0]).toEqual({ id: 1, o: "A.", t: "甲。", edited: true });

    alignment.replaceHistoryItems([
      { id: 1, o: "A. B.", t: "甲。乙。" },
      { id: 2, o: "C.", t: "丙。" },
    ], { markAligned: true });

    expect(alignment.hist).toEqual([
      { id: 1, o: "A. B.", t: "甲。乙。", aligned: true },
      { id: 2, o: "C.", t: "丙。", aligned: true },
    ]);
  });
});