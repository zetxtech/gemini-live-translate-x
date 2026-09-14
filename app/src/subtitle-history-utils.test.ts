import { describe, expect, it } from "vitest";
import { buildHistoryRows, historyRowCopyValue, isHistoryRevisionFresh, splitSentences } from "./subtitle-history-utils";

describe("subtitle history display modes", () => {
  const history = [
    { id: 1, o: "First sentence.", t: "第一句。" },
    { id: 2, o: "Second sentence.", t: "第二句。" },
    { id: 3, o: "Third sentence.", t: "第三句。" },
  ];

  it("rejects stale history event revisions", () => {
    expect(isHistoryRevisionFresh(0, undefined)).toBe(true);
    expect(isHistoryRevisionFresh(4, 3)).toBe(false);
    expect(isHistoryRevisionFresh(4, 4)).toBe(true);
    expect(isHistoryRevisionFresh(4, 5)).toBe(true);
    expect(isHistoryRevisionFresh(4, undefined)).toBe(false);
  });

  it("splits Chinese and English sentences by their sentence punctuation", () => {
    expect(splitSentences("第一句。第二句。", "zh")).toEqual(["第一句。", "第二句。"]);
    expect(splitSentences("First sentence. Second sentence.", "en")).toEqual(["First sentence.", "Second sentence."]);
    expect(splitSentences("第一句；第二句。", "zh")).toEqual(["第一句；", "第二句。"]);
    expect(splitSentences("First sentence; Second sentence.", "en")).toEqual(["First sentence;", "Second sentence."]);
  });

  it("keeps ordinary modes grouped by incoming history records", () => {
    expect(buildHistoryRows(history, "zh").map((row) => row.zh)).toEqual(["第一句。第二句。第三句。"]);
    expect(buildHistoryRows(history, "en").map((row) => row.en)).toEqual(["First sentence. Second sentence. Third sentence."]);
  });

  it("creates one row per sentence and pairs bilingual rows by order", () => {
    expect(buildHistoryRows(history, "zh-sentence").map((row) => row.zh)).toEqual(["第一句。", "第二句。", "第三句。"]);
    expect(buildHistoryRows(history, "en-sentence").map((row) => row.en)).toEqual(["First sentence.", "Second sentence.", "Third sentence."]);
    expect(buildHistoryRows(history, "bilingual")).toEqual([
      { id: 1, zh: "第一句。", en: "First sentence." },
      { id: 2, zh: "第二句。", en: "Second sentence." },
      { id: 3, zh: "第三句。", en: "Third sentence." },
    ]);
  });

  it("re-aligns a record that contains multiple source sentences", () => {
    const malformedRecords = [
      { id: 1, o: "First sentence. Second sentence.", t: "第一句。" },
      { id: 2, o: "Third sentence.", t: "第二句。" },
      { id: 3, o: "Fourth sentence.", t: "第三句。" },
    ];

    expect(buildHistoryRows(malformedRecords, "bilingual")).toEqual([
      { id: 1, sourceIds: [1], zh: "第一句。", en: "First sentence." },
      { id: 2, sourceIds: [2, 1], zh: "第二句。", en: "Second sentence." },
      { id: 3, sourceIds: [3, 2], zh: "第三句。", en: "Third sentence." },
      { id: 4, sourceIds: [3], zh: "", en: "Fourth sentence." },
    ]);
  });

  it("keeps an unfinished sentence visible as the transcript grows", () => {
    const activeTranscript = [...history, { id: 3, o: "Still speaking", t: "正在进行" }];
    expect(buildHistoryRows(activeTranscript, "zh-sentence").at(-1)?.zh).toBe("正在进行");
    expect(buildHistoryRows(activeTranscript, "en-sentence").at(-1)?.en).toBe("Still speaking");
  });

  it("copies rows without display line breaks", () => {
    const rows = buildHistoryRows(history, "zh-sentence");
    expect(rows.map((row) => historyRowCopyValue(row, "zh-sentence")).join("")).toBe("第一句。第二句。第三句。");
  });

  it("keeps manually edited records as one line instead of re-splitting them", () => {
    const edited = [
      { id: 1, o: "The connection is a bit laggy today. We still need more details though.", t: "今天的连接有点卡。不过我们还需要更多细节。" },
      { id: 2, o: "Third sentence.", t: "第二句。" },
      { id: 3, o: "Fourth sentence.", t: "第三句。" },
    ];
    const editedIds = new Set([1]);

    // Without the edited mark the record triggers sentence splitting.
    expect(buildHistoryRows(edited, "bilingual")).toHaveLength(4);

    // With the mark the record stays whole; no other record needs splitting, so rows mirror records.
    expect(buildHistoryRows(edited, "bilingual", editedIds)).toEqual([
      { id: 1, zh: "今天的连接有点卡。不过我们还需要更多细节。", en: "The connection is a bit laggy today. We still need more details though." },
      { id: 2, zh: "第二句。", en: "Third sentence." },
      { id: 3, zh: "第三句。", en: "Fourth sentence." },
    ]);

    // Mixed: the edited record stays whole while other multi-sentence records still split.
    const mixed = [
      { id: 1, o: "A. B.", t: "甲。" },
      { id: 2, o: "C. D.", t: "乙。" },
    ];
    expect(buildHistoryRows(mixed, "bilingual", new Set([2]))).toEqual([
      { id: 1, sourceIds: [1], zh: "甲。", en: "A." },
      { id: 2, sourceIds: [2, 1], zh: "乙。", en: "B." },
      { id: 3, sourceIds: [2], zh: "", en: "C. D." },
    ]);

    // Sentence modes also keep the edited record as one row.
    const singleEdited = [{ id: 1, o: "A. B.", t: "甲。" }];
    expect(buildHistoryRows(singleEdited, "bilingual", new Set([1]))).toEqual([
      { id: 1, zh: "甲。", en: "A. B." },
    ]);
    expect(buildHistoryRows(singleEdited, "zh-sentence", new Set([1]))).toEqual([
      { id: 1, sourceIds: [1], zh: "甲。", en: "" },
    ]);
  });

  it("renders AI-aligned rows exactly as returned instead of re-pairing sentences", () => {
    const aligned = [
      { id: 6, o: "The connection is a bit laggy today.", t: "不过还需要更多细节。", aligned: true },
      { id: 7, o: "The connection is a bit laggy today. We still need more details though.", t: "今天网络有点卡。", aligned: true },
      { id: 8, o: "We still need more details though.", t: "", aligned: true },
    ];

    expect(buildHistoryRows(aligned, "bilingual")).toEqual([
      { id: 6, zh: "不过还需要更多细节。", en: "The connection is a bit laggy today." },
      { id: 7, zh: "今天网络有点卡。", en: "The connection is a bit laggy today. We still need more details though." },
      { id: 8, zh: "", en: "We still need more details though." },
    ]);
    expect(buildHistoryRows(aligned, "zh-sentence").map((row) => row.zh)).toEqual([
      "不过还需要更多细节。",
      "今天网络有点卡。",
      "",
    ]);
  });
});