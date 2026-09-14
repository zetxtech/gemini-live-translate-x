/**
 * Non-network subtitle end-to-end tests.
 *
 * Pipeline under test (no Gemini / no Tauri window):
 *   translation/original chunks
 *     -> SentenceCutEngine (cut + history)
 *     -> buildCaptionFrame (display rows for single/multi line modes)
 *     -> scroll/readable helpers (when a line would notify readable)
 *
 * Covers every offline subtitle requirement that can be asserted without DOM/WebView.
 */
import { describe, expect, it } from "vitest";
import { SentenceCutEngine } from "./sentence-cut-engine";
import { buildCaptionFrame, frameRowTexts, shouldPromoteCurrentToHistory } from "./subtitle-frame";
import {
  clampTranslateX,
  computeScrollRawTarget,
  isCurrentLineReadable,
} from "./subtitle-scroll";

type TimerRecord = { fireAt: number; handler: () => void };
type FrameSnapshot = {
  t: number;
  history: string[];
  current: string[];
  empty: string[];
  curT: string;
  curO: string;
  histLen: number;
};

class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, TimerRecord>();

  now = (): number => this.nowMs;

  setTimeout = (handler: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { fireAt: this.nowMs + Math.max(0, delayMs), handler });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(id as unknown as number);
  };

  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      let next: { id: number; fireAt: number; handler: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (
          timer.fireAt <= target
          && (!next
            || timer.fireAt < next.fireAt
            || (timer.fireAt === next.fireAt && id < next.id))
        ) {
          next = { id, fireAt: timer.fireAt, handler: timer.handler };
        }
      }
      if (!next) break;
      this.nowMs = next.fireAt;
      this.timers.delete(next.id);
      next.handler();
    }
    this.nowMs = target;
  }

  flushZero(steps = 30): void {
    for (let step = 0; step < steps; step++) {
      let next: { id: number; fireAt: number; handler: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (
          timer.fireAt <= this.nowMs
          && (!next
            || timer.fireAt < next.fireAt
            || (timer.fireAt === next.fireAt && id < next.id))
        ) {
          next = { id, fireAt: timer.fireAt, handler: timer.handler };
        }
      }
      if (!next) return;
      this.nowMs = next.fireAt;
      this.timers.delete(next.id);
      next.handler();
    }
  }
}

type PipelineOptions = {
  bilingual?: boolean;
  historyRows?: 0 | 1 | 2;
  sentenceBreaksEnabled?: boolean;
};

function createPipeline(options: PipelineOptions = {}) {
  const clock = new FakeClock();
  const bilingual = options.bilingual ?? true;
  const historyRows = options.historyRows ?? 1;
  const frames: FrameSnapshot[] = [];
  const commits: { t: number; text: string; id: number }[] = [];
  let lastHistLen = 0;

  const engine = new SentenceCutEngine({
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    sentenceBreaksEnabled: () => options.sentenceBreaksEnabled ?? historyRows > 0,
    onChange: () => {
      if (engine.hist.length > lastHistLen) {
        const item = engine.hist[engine.hist.length - 1];
        commits.push({ t: clock.nowMs, text: item.t, id: item.id });
        lastHistLen = engine.hist.length;
      }
      const frame = buildCaptionFrame(
        { history: engine.hist, curO: engine.curO, curT: engine.curT },
        { bilingual, historyRows },
      );
      const texts = frameRowTexts(frame);
      frames.push({
        t: clock.nowMs,
        history: texts.history,
        current: texts.current,
        empty: texts.empty,
        curT: engine.curT,
        curO: engine.curO,
        histLen: engine.hist.length,
      });
    },
  });

  const paintReadable = (text = engine.curT) => {
    // Overlay only notifies readable for current translation that fits or settled.
    const rawTarget = computeScrollRawTarget({
      lineClientWidth: 800,
      textScrollWidth: Math.min(text.length * 28, 800),
      isCurrentLine: true,
      hasText: Boolean(text.trim()),
    });
    if (
      isCurrentLineReadable({
        isCurrentTrans: true,
        text,
        rawTarget,
        offset: rawTarget,
        velocity: 0,
      })
    ) {
      engine.onCurrentLineReadable(text);
    }
  };

  const paintLongLineReadable = (text = engine.curT) => {
    // Long overflow line: readable only after scroll settles at left target.
    const rawTarget = computeScrollRawTarget({
      lineClientWidth: 400,
      textScrollWidth: 1200,
      isCurrentLine: true,
      hasText: Boolean(text.trim()),
    });
    expect(rawTarget).toBeLessThan(0);
    expect(clampTranslateX(0, rawTarget)).toBe(0);
    // Before settle: not readable.
    expect(
      isCurrentLineReadable({
        isCurrentTrans: true,
        text,
        rawTarget,
        offset: 0,
        velocity: -50,
      }),
    ).toBe(false);
    // After settle:
    expect(
      isCurrentLineReadable({
        isCurrentTrans: true,
        text,
        rawTarget,
        offset: rawTarget,
        velocity: 0,
      }),
    ).toBe(true);
    engine.onCurrentLineReadable(text);
  };

  const latestFrame = () => frames[frames.length - 1];

  return { clock, engine, frames, commits, paintReadable, paintLongLineReadable, latestFrame, bilingual, historyRows };
}

describe("e2e: single-line modes (historyRows=0)", () => {
  it("mono single line never commits history; frame stays current-only", () => {
    const { clock, engine, commits, latestFrame, paintReadable } = createPipeline({
      bilingual: false,
      historyRows: 0,
      sentenceBreaksEnabled: false,
    });

    engine.appendTranslation("第一句完。");
    paintReadable();
    clock.advance(2000);
    clock.flushZero();

    expect(commits).toHaveLength(0);
    expect(engine.hist).toHaveLength(0);
    expect(latestFrame().history).toEqual([]);
    expect(latestFrame().current).toEqual(["第一句完。"]);
    expect(latestFrame().empty).toEqual([]);
  });

  it("bilingual single line shows trans + orig, no history", () => {
    const { engine, latestFrame } = createPipeline({
      bilingual: true,
      historyRows: 0,
      sentenceBreaksEnabled: false,
    });

    engine.appendOriginal("Hello there");
    engine.appendTranslation("你好啊");

    expect(latestFrame().history).toEqual([]);
    expect(latestFrame().current).toEqual(["你好啊", "Hello there"]);
  });

  it("bilingual single line reserves pending orig until English arrives", () => {
    const { engine, latestFrame } = createPipeline({
      bilingual: true,
      historyRows: 0,
      sentenceBreaksEnabled: false,
    });

    engine.appendTranslation("先到译文");
    expect(latestFrame().current[0]).toBe("先到译文");
    expect(latestFrame().current[1]).toBe("\u00a0");

    engine.appendOriginal("Late English");
    expect(latestFrame().current).toEqual(["先到译文", "Late English"]);
  });
});

describe("e2e: multi-line history modes", () => {
  it("history=1: keeps the completed line current until the next line has text", () => {
    const { clock, engine, commits, latestFrame, paintReadable } = createPipeline({
      bilingual: false,
      historyRows: 1,
    });

    engine.appendTranslation("确认问题切换。");
    expect(latestFrame().current).toEqual(["确认问题切换。"]);
    expect(commits).toHaveLength(0);

    paintReadable("确认问题切换。");
    clock.advance(499);
    expect(commits).toHaveLength(0);

    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(0);
    expect(latestFrame().history).toEqual(["\u00a0"]);
    expect(latestFrame().current).toEqual(["确认问题切换。"]);
    expect(latestFrame().empty).toEqual([]);

    engine.appendTranslation("下一句开始");
    expect(commits).toHaveLength(1);
    const switchedFrame = latestFrame();
    expect(switchedFrame.history).toEqual(["确认问题切换。"]);
    expect(switchedFrame.current).toEqual(["下一句开始"]);

    const frame = buildCaptionFrame(
      { history: engine.hist, curO: engine.curO, curT: engine.curT },
      { bilingual: false, historyRows: 1 },
    );
    expect(shouldPromoteCurrentToHistory("确认问题切换。", frame.historyRows)).toBe(true);
  });

  it("history bilingual: history never includes original English", () => {
    const { clock, engine, commits, latestFrame, paintReadable } = createPipeline({
      bilingual: true,
      historyRows: 1,
    });

    engine.appendOriginal("Please confirm the switch.");
    engine.appendTranslation("请确认切换。");
    paintReadable("请确认切换。");
    clock.advance(500);
    clock.flushZero();

    expect(commits).toHaveLength(0);
    engine.appendTranslation("下一话题");

    expect(commits).toHaveLength(1);
    expect(latestFrame().history).toEqual(["请确认切换。"]);
    expect(latestFrame().history.some((text) => text.includes("Please"))).toBe(false);

    engine.appendOriginal("Next topic");
    expect(latestFrame().current).toEqual(["下一话题", "Please confirm the switch. Next topic"]);
    expect(latestFrame().history).toEqual(["请确认切换。"]);
  });

  it("historyRows=2 keeps two ages and drops oldest from visible frame", () => {
    const { clock, engine, latestFrame, paintReadable } = createPipeline({
      bilingual: false,
      historyRows: 2,
    });

    const sentences = ["第一句话完。", "第二句话完。", "第三句话完。"];
    for (const sentence of sentences) {
      engine.appendTranslation(sentence);
      paintReadable(sentence);
      clock.advance(500);
      clock.flushZero();
    }

    engine.appendTranslation("第四句话开始");

    expect(engine.hist).toHaveLength(3);
    // Visible frame only last 2.
    expect(latestFrame().history).toEqual(["第二句话完。", "第三句话完。"]);
    const frame = buildCaptionFrame(
      { history: engine.hist, curO: "", curT: "" },
      { bilingual: false, historyRows: 2 },
    );
    expect(frame.historyRows.map((row) => row.age)).toEqual([2, 1]);
    expect(frame.historyRows[0].className).toContain("age-2");
    expect(frame.historyRows[1].className).toContain("age-1");
  });

  it("rapid multi-sentence stream keeps >=500ms between commits (no double float)", () => {
    const { clock, engine, commits, paintReadable } = createPipeline({
      bilingual: false,
      historyRows: 1,
    });

    engine.appendTranslation("记录确认问题？。这个上浮继续。");
    expect(commits).toHaveLength(0);

    const first = engine.snapshot().pendingCutText;
    paintReadable(first);
    clock.advance(500);
    clock.flushZero();
    expect(commits).toHaveLength(1);

    clock.flushZero();
    expect(engine.snapshot().awaitingReadable).toBe(true);
    const second = engine.snapshot().pendingCutText || engine.curT;
    paintReadable(second);
    clock.advance(499);
    expect(commits).toHaveLength(1);
    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(1);
    engine.appendTranslation("第三句开始");
    expect(commits).toHaveLength(2);
    expect(commits[1].t - commits[0].t).toBeGreaterThanOrEqual(500);
  });
});

describe("e2e: empty / reset / original-first timing", () => {
  it("starts with empty waiting frame", () => {
    const frame = buildCaptionFrame(
      { history: [], curO: "", curT: "" },
      { bilingual: true, historyRows: 1 },
    );
    expect(frameRowTexts(frame).empty).toEqual(["等待音频...", "Waiting for audio..."]);
  });

  it("original-first then translation builds bilingual current without empty", () => {
    const { engine, latestFrame } = createPipeline({
      bilingual: true,
      historyRows: 1,
      sentenceBreaksEnabled: false,
    });

    engine.appendOriginal("Audio first");
    // Original shows immediately and keeps scrolling; it never waits for
    // the translation to start.
    expect(engine.curO).toBe("Audio first");
    expect(engine.curT).toBe("");

    engine.appendTranslation("先到原文");
    expect(latestFrame().empty).toEqual([]);
    expect(latestFrame().current).toEqual(["先到原文", "Audio first"]);
  });

  it("reset clears engine and frame returns to empty", () => {
    const { engine, latestFrame, paintReadable, clock } = createPipeline({
      bilingual: true,
      historyRows: 1,
    });

    engine.appendTranslation("临时内容。");
    paintReadable();
    clock.advance(500);
    clock.flushZero();
    expect(engine.hist.length + (engine.curT ? 1 : 0)).toBeGreaterThan(0);

    engine.reset();
    expect(engine.hist).toHaveLength(0);
    expect(engine.curT).toBe("");
    expect(engine.curO).toBe("");
    // Selected history mode keeps its row reserved from the initial frame.
    expect(latestFrame().history).toEqual(["\u00a0"]);
    expect(latestFrame().current).toEqual([]);
    // onChange after reset with empty state — frame builder empty path:
    const emptyFrame = buildCaptionFrame(
      { history: [], curO: "", curT: "" },
      { bilingual: true, historyRows: 1 },
    );
    expect(emptyFrame.showEmpty).toBe(true);
  });
});

describe("e2e: long line scroll gate before cut", () => {
  it("long overflowing line must settle scroll before readable starts 500ms hold", () => {
    const { clock, engine, commits, paintLongLineReadable } = createPipeline({
      bilingual: false,
      historyRows: 1,
    });

    const longSentence = "这是一句非常非常长的会议字幕内容需要横向滚动才能看完末尾标点。";
    engine.appendTranslation(longSentence);
    clock.advance(100);
    expect(commits).toHaveLength(0);

    // Without readable, even after 500ms, no commit.
    clock.advance(500);
    expect(commits).toHaveLength(0);

    paintLongLineReadable(longSentence);
    clock.advance(499);
    expect(commits).toHaveLength(0);
    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(0);
    engine.appendTranslation("下一句开始");
    expect(commits).toHaveLength(1);
    expect(commits[0].text).toBe(longSentence);
  });
});

describe("e2e: punctuation / short-tail / comma rules through frame", () => {
  it("terminal punctuation at chunk end requests cut after readable", () => {
    const { clock, engine, commits, paintReadable, latestFrame } = createPipeline({
      bilingual: false,
      historyRows: 1,
    });
    engine.appendTranslation("会议已经结束！");
    paintReadable();
    clock.advance(500);
    clock.flushZero();
    engine.appendTranslation("下一句开始");
    expect(commits.map((item) => item.text)).toEqual(["会议已经结束！"]);
    expect(latestFrame().history).toEqual(["会议已经结束！"]);
  });

  it("comma break only after min length, then holds for readable", () => {
    const { clock, engine, commits, paintReadable } = createPipeline({
      bilingual: false,
      historyRows: 1,
    });
    // Below minCommaBreakChars (5 content chars): comma must not break.
    engine.appendTranslation("确认问题，");
    expect(engine.curT).toBe("确认问题，");
    expect(engine.snapshot().awaitingReadable).toBe(false);
    expect(engine.snapshot().pendingShortTail).toBe("");
    expect(commits).toHaveLength(0);

    // More content makes the next comma eligible (total content chars >= 5).
    // Head becomes "确认问题，切换，"; tail "后续继续说" is long enough to cut.
    engine.appendTranslation("切换，后续继续说");
    expect(engine.snapshot().awaitingReadable || engine.snapshot().cutHoldActive).toBe(true);
    const pending = engine.snapshot().pendingCutText || engine.curT;
    expect(pending.startsWith("确认问题，")).toBe(true);
    expect(pending).toContain("切换，");
    paintReadable(pending);
    clock.advance(500);
    clock.flushZero();
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].text).toContain("确认问题，");
  });

  it("short punctuated phrase below min tail chars does not auto-cut immediately", () => {
    const { clock, engine, commits, paintReadable } = createPipeline({
      bilingual: false,
      historyRows: 1,
    });
    // 2 content chars + period -> below MIN_PACKET_TAIL_CHARS(3)
    engine.appendTranslation("好。");
    clock.advance(100);
    paintReadable("好。");
    clock.advance(500);
    clock.flushZero();
    // Should not have requested cut because sentenceCharLength < 3.
    expect(commits).toHaveLength(0);
    expect(engine.curT).toBe("好。");
  });

  it("interleaved original and translation preserve pairing on commit", () => {
    const { clock, engine, commits, paintReadable } = createPipeline({
      bilingual: true,
      historyRows: 1,
    });
    engine.appendOriginal("Part one ");
    engine.appendTranslation("第一部分");
    engine.appendOriginal("done.");
    engine.appendTranslation("完成。");
    paintReadable(engine.curT);
    clock.advance(500);
    clock.flushZero();
    engine.appendTranslation("下一句开始");
    expect(commits).toHaveLength(1);
    expect(engine.hist[0].o).toBe("Part one done.");
    expect(engine.hist[0].t).toBe("第一部分完成。");
  });
});

describe("e2e: mode matrix smoke (all 5 display modes)", () => {
  const payload = {
    history: [
      { id: 1, o: "Old English", t: "旧译文" },
      { id: 2, o: "Mid English", t: "中译文" },
    ],
    curO: "Now English",
    curT: "当前译文",
  };

  const cases: Array<{
    name: string;
    bilingual: boolean;
    historyRows: 0 | 1 | 2;
    expectHistory: string[];
    expectCurrent: string[];
  }> = [
    {
      name: "single",
      bilingual: false,
      historyRows: 0,
      expectHistory: [],
      expectCurrent: ["当前译文"],
    },
    {
      name: "single-bilingual",
      bilingual: true,
      historyRows: 0,
      expectHistory: [],
      expectCurrent: ["当前译文", "Now English"],
    },
    {
      name: "history",
      bilingual: false,
      historyRows: 1,
      expectHistory: ["中译文"],
      expectCurrent: ["当前译文"],
    },
    {
      name: "history-bilingual",
      bilingual: true,
      historyRows: 1,
      expectHistory: ["中译文"],
      expectCurrent: ["当前译文", "Now English"],
    },
    {
      name: "history2",
      bilingual: false,
      historyRows: 2,
      expectHistory: ["旧译文", "中译文"],
      expectCurrent: ["当前译文"],
    },
  ];

  for (const testCase of cases) {
    it(`mode ${testCase.name}`, () => {
      const frame = buildCaptionFrame(payload, {
        bilingual: testCase.bilingual,
        historyRows: testCase.historyRows,
      });
      const texts = frameRowTexts(frame);
      expect(texts.history).toEqual(testCase.expectHistory);
      expect(texts.current).toEqual(testCase.expectCurrent);
      // History never contains English originals.
      expect(texts.history.join(" ")).not.toMatch(/English/);
    });
  }
});
