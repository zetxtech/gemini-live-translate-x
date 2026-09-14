import { describe, expect, it } from "vitest";
import {
  buildCaptionFrame,
  frameRowTexts,
  shouldPromoteCurrentToHistory,
} from "./subtitle-frame";
import { normalizeSettings, defaultSettings } from "./subtitle-settings-shared";

const PLACEHOLDER = "\u00a0";

describe("buildCaptionFrame — mode matrix (single / multi line)", () => {
  it("single mono: only current translation", () => {
    const frame = buildCaptionFrame(
      { history: [{ id: 1, o: "hello", t: "你好" }], curO: "world", curT: "世界" },
      { bilingual: false, historyRows: 0 },
    );
    expect(frameRowTexts(frame)).toEqual({
      history: [],
      current: ["世界"],
      empty: [],
    });
    expect(frame.showHistory).toBe(false);
    expect(frame.currentRows[0].role).toBe("current-trans");
  });

  it("single bilingual: current trans + current orig, no history", () => {
    const frame = buildCaptionFrame(
      { history: [{ id: 1, o: "old", t: "旧句" }], curO: "Hello world", curT: "你好世界" },
      { bilingual: true, historyRows: 0 },
    );
    expect(frame.historyRows).toHaveLength(0);
    expect(frame.currentRows.map((row) => row.role)).toEqual(["current-trans", "current-orig"]);
    expect(frameRowTexts(frame).current).toEqual(["你好世界", "Hello world"]);
  });

  it("history mono: one history + current, history has no original", () => {
    const frame = buildCaptionFrame(
      {
        history: [{ id: 1, o: "Previous sentence", t: "上一句" }],
        curO: "Now speaking",
        curT: "现在说话",
      },
      { bilingual: false, historyRows: 1 },
    );
    expect(frameRowTexts(frame)).toEqual({
      history: ["上一句"],
      current: ["现在说话"],
      empty: [],
    });
    expect(frame.historyRows[0].className).toBe("line trans age-1");
    expect(frame.historyRows.every((row) => !row.text.includes("Previous"))).toBe(true);
  });

  it("history bilingual: history translation only + current trans/orig", () => {
    const frame = buildCaptionFrame(
      {
        history: [{ id: 2, o: "English history", t: "历史译文" }],
        curO: "Current English",
        curT: "当前译文",
      },
      { bilingual: true, historyRows: 1 },
    );
    expect(frame.visibleHistoryCount).toBe(1);
    expect(frame.historyRows[0].text).toBe("历史译文");
    expect(frame.currentRows.map((row) => row.text)).toEqual(["当前译文", "Current English"]);
    // History must never surface original.
    expect(frame.historyRows.some((row) => row.text === "English history")).toBe(false);
  });

  it("history2 mono: two history ages + current", () => {
    const frame = buildCaptionFrame(
      {
        history: [
          { id: 1, o: "a", t: "最旧" },
          { id: 2, o: "b", t: "次新" },
          { id: 3, o: "c", t: "最新历史" },
        ],
        curO: "",
        curT: "当前",
      },
      { bilingual: false, historyRows: 2 },
    );
    expect(frame.historyRows.map((row) => ({ text: row.text, age: row.age, className: row.className }))).toEqual([
      { text: "次新", age: 2, className: "line trans age-2" },
      { text: "最新历史", age: 1, className: "line trans age-1" },
    ]);
    expect(frame.currentRows[0].text).toBe("当前");
  });
});

describe("buildCaptionFrame — empty / pending / placeholders", () => {
  it("truly empty bilingual shows waiting rows", () => {
    const frame = buildCaptionFrame(
      { history: [], curO: "", curT: "" },
      { bilingual: true, historyRows: 1 },
    );
    expect(frame.showEmpty).toBe(true);
    expect(frameRowTexts(frame).empty).toEqual(["等待音频...", "Waiting for audio..."]);
    expect(frame.showHistory).toBe(true);
    expect(frame.historyRows).toEqual([
      {
        role: "history-placeholder",
        text: PLACEHOLDER,
        className: "line trans age-1 pending history-placeholder",
        key: "history-placeholder:1",
        age: 1,
      },
    ]);
    expect(frame.visibleHistoryCount).toBe(0);
    expect(frame.showCurrent).toBe(false);
  });

  it("reserves two history rows from the initial empty frame", () => {
    const frame = buildCaptionFrame(
      { history: [], curO: "", curT: "" },
      { bilingual: false, historyRows: 2 },
    );
    expect(frame.showHistory).toBe(true);
    expect(frame.historyRows.map((row) => ({ role: row.role, text: row.text, age: row.age }))).toEqual([
      { role: "history-placeholder", text: PLACEHOLDER, age: 2 },
      { role: "history-placeholder", text: PLACEHOLDER, age: 1 },
    ]);
    expect(frame.visibleHistoryCount).toBe(0);
    expect(frame.showEmpty).toBe(true);
  });

  it("truly empty mono shows only Chinese waiting", () => {
    const frame = buildCaptionFrame(
      { history: [], curO: "", curT: "" },
      { bilingual: false, historyRows: 0 },
    );
    expect(frameRowTexts(frame).empty).toEqual(["等待音频..."]);
  });

  it("does not show empty placeholder when only history exists", () => {
    const frame = buildCaptionFrame(
      { history: [{ id: 1, o: "x", t: "已提交" }], curO: "", curT: "" },
      { bilingual: false, historyRows: 1 },
    );
    expect(frame.showEmpty).toBe(false);
    expect(frame.showHistory).toBe(true);
    expect(frame.currentRows).toEqual([]);
    expect(frame.showCurrent).toBe(false);
  });

  it("bilingual reserves pending original while translation is present", () => {
    const frame = buildCaptionFrame(
      { history: [], curO: "", curT: "只有译文" },
      { bilingual: true, historyRows: 0 },
    );
    expect(frame.currentRows).toHaveLength(2);
    expect(frame.currentRows[1]).toMatchObject({
      role: "current-orig",
      text: PLACEHOLDER,
      className: "line orig cur pending",
    });
  });

  it("skips blank history translation rows", () => {
    const frame = buildCaptionFrame(
      {
        history: [
          { id: 1, o: "only original", t: "" },
          { id: 2, o: "ok", t: "有效" },
        ],
        curO: "",
        curT: "当前",
      },
      { bilingual: false, historyRows: 2 },
    );
    expect(frameRowTexts(frame).history).toEqual([PLACEHOLDER, "有效"]);
    expect(frame.historyRows.map((row) => row.role)).toEqual(["history-placeholder", "history"]);
    expect(frame.visibleHistoryCount).toBe(1);
  });

  it("history gap with bilingual keeps only the last original", () => {
    const frame = buildCaptionFrame(
      { history: [{ id: 1, o: "a", t: "历史" }], curO: "", curT: "" },
      { bilingual: true, historyRows: 1 },
    );
    expect(frame.currentRows.map((row) => row.role)).toEqual(["current-orig"]);
    expect(frame.currentRows[0].text).toBe("a");
    expect(frame.currentRows[0].className).not.toContain("pending");
  });

  it("holds the last completed original until the next original chunk", () => {
    const frame = buildCaptionFrame(
      {
        history: [{ id: 1, o: "We'll send the details afterwards.", t: "稍后会把详细内容发给大家。" }],
        curO: "",
        curT: "",
      },
      { bilingual: true, historyRows: 1 },
    );
    expect(frame.currentRows[0].text).toBe("We'll send the details afterwards.");
  });

  it("keeps the scrolling original visible while translation is absent", () => {
    const frame = buildCaptionFrame(
      {
        history: [{ id: 1, o: "old", t: "旧句" }],
        curO: "Thanks everyone. Can everyone see my screen now?",
        curT: "",
      },
      { bilingual: true, historyRows: 1 },
    );
    expect(frame.currentRows.map((row) => row.role)).toEqual(["current-orig"]);
    expect(frame.currentRows[0].text).toBe("Thanks everyone. Can everyone see my screen now?");
    expect(frame.currentRows[0].className).toContain("cur");
    expect(frame.currentRows.map((row) => row.key)).toEqual(["current:orig"]);
  });

  it("keeps current row keys stable across a translation commit", () => {
    const active = buildCaptionFrame(
      { history: [], curO: "English keeps streaming", curT: "中文正在显示" },
      { bilingual: true, historyRows: 1 },
    );
    const committed = buildCaptionFrame(
      {
        history: [{ id: 1, o: "English keeps streaming", t: "中文正在显示" }],
        curO: "English keeps streaming without restarting",
        curT: "",
      },
      { bilingual: true, historyRows: 1 },
    );

    expect(active.currentRows.map((row) => row.key)).toEqual(["current:trans", "current:orig"]);
    expect(committed.currentRows.map((row) => row.key)).toEqual(["current:orig"]);
    expect(committed.currentRows[0].text).toBe("English keeps streaming without restarting");
  });
});

describe("buildCaptionFrame — promote continuity", () => {
  it("promotes when outgoing current text matches a new history row", () => {
    const frame = buildCaptionFrame(
      {
        history: [{ id: 3, o: "hi", t: "确认问题切换。" }],
        curO: "",
        curT: "下一句",
      },
      { bilingual: false, historyRows: 1 },
    );
    expect(shouldPromoteCurrentToHistory("确认问题切换。", frame.historyRows)).toBe(true);
  });

  it("does not promote placeholder or mismatched text", () => {
    const frame = buildCaptionFrame(
      { history: [{ id: 1, o: "", t: "历史句" }], curO: "", curT: "当前" },
      { bilingual: false, historyRows: 1 },
    );
    expect(shouldPromoteCurrentToHistory(PLACEHOLDER, frame.historyRows)).toBe(false);
    expect(shouldPromoteCurrentToHistory("别的句子", frame.historyRows)).toBe(false);
    expect(shouldPromoteCurrentToHistory("", frame.historyRows)).toBe(false);
  });
});

describe("normalizeSettings — bilingual history cap", () => {
  it("forces historyRows <= 1 when bilingual", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      bilingual: true,
      historyRows: 2,
    });
    expect(normalized.historyRows).toBe(1);
  });

  it("keeps historyRows 2 when mono", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      bilingual: false,
      historyRows: 2,
    });
    expect(normalized.historyRows).toBe(2);
  });

  it("forces align left", () => {
    const normalized = normalizeSettings({
      ...defaultSettings(),
      align: "center",
    });
    expect(normalized.align).toBe("left");
  });
});
