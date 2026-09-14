import { describe, expect, it } from "vitest";
import { SentenceCutEngine } from "./sentence-cut-engine";

type TimerRecord = { fireAt: number; handler: () => void };
type CommitRecord = { t: number; text: string; id: number };

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
        if (timer.fireAt <= target && (!next || timer.fireAt < next.fireAt || (timer.fireAt === next.fireAt && id < next.id))) {
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

  flushZero(steps = 20): void {
    for (let step = 0; step < steps; step++) {
      let next: { id: number; fireAt: number; handler: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.fireAt <= this.nowMs && (!next || timer.fireAt < next.fireAt || (timer.fireAt === next.fireAt && id < next.id))) {
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

function createEngine(clock: FakeClock) {
  const commits: CommitRecord[] = [];
  let lastHistLen = 0;
  const engine = new SentenceCutEngine({
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onChange: () => {
      if (engine.hist.length > lastHistLen) {
        const item = engine.hist[engine.hist.length - 1];
        commits.push({ t: clock.nowMs, text: item.t, id: item.id });
        lastHistLen = engine.hist.length;
      }
    },
  });
  return { engine, commits };
}

describe("SentenceCutEngine readable hold", () => {
  it("commits the completed line only when the next translation arrives", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("确认问题切换。");
    clock.advance(400);
    expect(commits).toHaveLength(0);

    engine.onCurrentLineReadable("确认问题切换。");
    clock.advance(499);
    expect(commits).toHaveLength(0);

    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(0);
    expect(engine.hist).toHaveLength(0);
    expect(engine.curT).toBe("确认问题切换。");
    expect(engine.snapshot().readyToCommit).toBe(true);

    engine.appendTranslation("下一句开始");
    expect(commits).toHaveLength(1);
    expect(commits[0].t).toBe(900);
    expect(commits[0].text).toBe("确认问题切换。");
    expect(engine.curT).toBe("下一句开始");
    expect(engine.snapshot().readyToCommit).toBe(false);
  });

  it("does not cut in the first 500ms without readable", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("现在需要上浮。");
    clock.advance(500);
    expect(commits).toHaveLength(0);

    clock.advance(1499);
    expect(commits).toHaveLength(0);

    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(0);

    clock.advance(500);
    clock.flushZero();
    expect(commits).toHaveLength(0);
    expect(engine.snapshot().readyToCommit).toBe(true);

    engine.appendTranslation("下一句开始");
    expect(commits).toHaveLength(1);
    expect(commits[0].t).toBe(2500);
  });

  it("requires a fresh readable+hold for each chained tail sentence", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("这个问题需要确认。");
    expect(commits).toHaveLength(0);

    engine.onCurrentLineReadable("错误句子");
    clock.advance(100);
    expect(commits).toHaveLength(0);

    const firstText = engine.snapshot().pendingCutText;
    engine.onCurrentLineReadable(firstText);
    clock.advance(500);
    clock.flushZero();
    expect(commits).toHaveLength(0);

    // The next translation atomically commits the completed first sentence.
    engine.appendTranslation("下个问题继续上浮。");
    expect(commits).toHaveLength(1);
    expect(engine.snapshot().awaitingReadable).toBe(true);

    const secondText = engine.snapshot().pendingCutText || engine.curT;
    engine.onCurrentLineReadable(secondText);
    clock.advance(499);
    expect(commits).toHaveLength(1);
    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(1);

    engine.appendTranslation("第三句话继续");
    expect(commits).toHaveLength(2);
    expect(commits[1].t - commits[0].t).toBeGreaterThanOrEqual(500);
  });

  it("publishes the next tail atomically with a history commit", () => {
    const clock = new FakeClock();
    const publishedFrames: Array<{ historyLength: number; currentText: string }> = [];
    const engine = new SentenceCutEngine({
      now: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      onChange: () => {
        publishedFrames.push({
          historyLength: engine.hist.length,
          currentText: engine.curT,
        });
      },
    });

    engine.appendTranslation("发生这个问题。结果我们这个");
    const pendingText = engine.snapshot().pendingCutText || engine.curT;
    engine.onCurrentLineReadable(pendingText);
    clock.advance(500);
    clock.flushZero();

    const framesAfterCommit = publishedFrames.filter((frame) => frame.historyLength === 1);
    expect(framesAfterCommit.length).toBeGreaterThan(0);
    expect(framesAfterCommit.every((frame) => frame.currentText.length > 0)).toBe(true);
    expect(framesAfterCommit.at(-1)?.currentText).toBe("结果我们这个");
  });

  it("keeps 500ms hold between rapid punctuated packets", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("第一句话完。");
    engine.onCurrentLineReadable("第一句话完。");
    clock.advance(500);
    clock.flushZero();
    expect(commits).toHaveLength(0);

    engine.appendTranslation("第二句话也完。");
    expect(commits).toHaveLength(1);
    clock.advance(50);
    engine.onCurrentLineReadable("第二句话也完。");
    clock.advance(499);
    expect(commits).toHaveLength(1);
    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(1);
    engine.appendTranslation("第三句话开始");
    expect(commits).toHaveLength(2);
    expect(commits[1].t - commits[0].t).toBeGreaterThanOrEqual(500);
  });

  it("ignores stale readable from a previous sentence", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("旧句子已经完。");
    engine.onCurrentLineReadable("旧句子已经完。");
    clock.advance(500);
    clock.flushZero();
    expect(commits).toHaveLength(0);

    engine.appendTranslation("新句很长需要滚动。");
    expect(commits).toHaveLength(1);
    engine.onCurrentLineReadable("旧句子已经完。");
    clock.advance(100);
    expect(commits).toHaveLength(1);

    engine.onCurrentLineReadable("新句很长需要滚动。");
    clock.advance(499);
    expect(commits).toHaveLength(1);
    clock.advance(1);
    clock.flushZero();
    expect(commits).toHaveLength(1);
    engine.appendTranslation("继续说明");
    expect(commits).toHaveLength(2);
    expect(commits[1].t - commits[0].t).toBeGreaterThanOrEqual(500);
  });

  it("appends without break until terminal punctuation", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("正在讨论方案");
    expect(engine.curT).toBe("正在讨论方案");
    expect(commits).toHaveLength(0);
    expect(engine.snapshot().awaitingReadable).toBe(false);

    engine.appendTranslation("细节。");
    expect(engine.curT).toBe("正在讨论方案细节。");
    expect(engine.snapshot().awaitingReadable).toBe(true);
  });

  it("treats Chinese and English semicolons as terminal punctuation", () => {
    const clock = new FakeClock();
    const { engine } = createEngine(clock);

    engine.appendTranslation("正在讨论方案；继续说明内容");
    expect(engine.curT).toBe("正在讨论方案；");
    expect(engine.snapshot().pendingCutText).toBe("正在讨论方案；");

    engine.reset();
    engine.appendTranslation("We are discussing the plan; continue with details");
    expect(engine.curT).toBe("We are discussing the plan;");
    expect(engine.snapshot().pendingCutText).toBe("We are discussing the plan;");
  });

  it("merges short tail when next chunk arrives before timeout", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    // Head ends with terminal and is long enough; short tail "还" queues a wait.
    engine.appendTranslation("先说完这句话。还");
    expect(engine.snapshot().pendingShortTail).toBe("还");
    expect(commits).toHaveLength(0);

    // Next chunk arrives — short tail merges into next process.
    engine.appendTranslation("有补充说明。");
    // After merge, first sentence should be awaiting readable (or hold).
    expect(engine.snapshot().awaitingReadable || engine.snapshot().cutHoldActive).toBe(true);

    engine.onCurrentLineReadable(engine.snapshot().pendingCutText || engine.curT);
    clock.advance(500);
    clock.flushZero();
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].text).toContain("先说完这句话。");
  });

  it("commits a long head when the short tail times out without a next chunk", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("重复这个观察？然后");
    expect(engine.curT).toBe("重复这个观察？");
    expect(engine.snapshot().pendingShortTail).toBe("然后");
    expect(engine.snapshot().awaitingReadable).toBe(false);

    clock.advance(2_000);
    clock.flushZero();

    // The head (6 chars > 4) must not stall on the current line forever: it
    // commits to history and the timed-out short tail starts the next line.
    expect(engine.snapshot().pendingShortTail).toBe("");
    expect(engine.snapshot().awaitingReadable).toBe(false);
    expect(engine.snapshot().cutHoldActive).toBe(false);
    expect(engine.curT).toBe("然后");
    expect(commits).toHaveLength(1);
    expect(commits[0].text).toBe("重复这个观察？");
  });

  it("short sentence with a long tail stays merged on the current line", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    // "好的。" is only 2 content chars: it must not move to history by itself.
    engine.appendTranslation("好的。接下来我们继续讨论。");
    expect(engine.curT).toBe("好的。接下来我们继续讨论。");
    expect(engine.snapshot().pendingShortTail).toBe("");
    expect(commits).toHaveLength(0);
    expect(engine.snapshot().awaitingReadable).toBe(true);

    const cutText = engine.snapshot().pendingCutText || engine.curT;
    engine.onCurrentLineReadable(cutText);
    clock.advance(500);
    clock.flushZero();
    expect(commits).toHaveLength(0);
    engine.appendTranslation("继续说明");
    expect(commits).toHaveLength(1);
    // The whole merged sentence commits as one history row, never the 2-char head.
    expect(commits[0].text).toBe("好的。接下来我们继续讨论。");
  });

  it("pairs original text with translation on commit", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendOriginal("Hello world");
    engine.appendTranslation("你好美丽世界。");
    engine.onCurrentLineReadable("你好美丽世界。");
    clock.advance(500);
    clock.flushZero();

    expect(commits).toHaveLength(0);
    engine.appendTranslation("下一句开始");

    expect(commits).toHaveLength(1);
    expect(engine.hist[0]).toEqual({ id: 1, o: "Hello world", t: "你好美丽世界。" });
    // Original never cuts: the line keeps its text and scrolls on.
    expect(engine.curO).toBe("Hello world");
    expect(engine.curT).toBe("下一句开始");
  });

  it("keeps appending original text as a continuous scrolling line", () => {
    const clock = new FakeClock();
    const { engine } = createEngine(clock);

    engine.appendOriginal("First English ");
    engine.appendOriginal("sentence.", true);
    engine.appendTranslation("第一句");
    engine.appendTranslation("中文。");
    expect(engine.curO).toBe("First English sentence.");

    engine.onCurrentLineReadable("第一句中文。");
    clock.advance(500);
    clock.flushZero();

    engine.appendOriginal("Second English ");
    expect(engine.curO).toBe("First English sentence. Second English ");
    engine.appendOriginal("sentence.", true);
    expect(engine.curO).toBe("First English sentence. Second English sentence.");
    expect(engine.curT).toBe("第一句中文。");

    engine.appendTranslation("第二句中文");
    expect(engine.hist.at(-1)).toMatchObject({
      o: "First English sentence. Second English sentence.",
      t: "第一句中文。",
    });
    expect(engine.curO).toBe("First English sentence. Second English sentence.");
    expect(engine.curT).toBe("第二句中文");
  });

  it("merges English sentences when Chinese holds a short sentence", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    // "谢谢大家。" is 4 chars <= minSentenceCutChars: held, no cut pending.
    engine.appendTranslation("谢谢大家。");
    expect(engine.curT).toBe("谢谢大家。");

    engine.appendOriginal("Thanks everyone.", true);
    engine.appendOriginal("Can everyone see my screen now?", true);
    // Original scrolls continuously: every chunk appends to the same line.
    expect(engine.curO).toBe("Thanks everyone. Can everyone see my screen now?");

    engine.appendTranslation("大家现在能看到我的屏幕吗？");
    expect(engine.curT).toBe("谢谢大家。大家现在能看到我的屏幕吗？");
    const pendingText = engine.snapshot().pendingCutText || engine.curT;
    engine.onCurrentLineReadable(pendingText);
    clock.advance(500);
    clock.flushZero();

    expect(commits).toHaveLength(0);
    engine.appendTranslation("继续说明");

    expect(commits).toHaveLength(1);
    expect(engine.hist[0]).toMatchObject({
      o: "Thanks everyone. Can everyone see my screen now?",
      t: "谢谢大家。大家现在能看到我的屏幕吗？",
    });
  });

  it("appends the next English sentence while Chinese is about to cut", () => {
    const clock = new FakeClock();
    const { engine } = createEngine(clock);

    engine.appendOriginal("Please confirm the switch.", true);
    engine.appendTranslation("请确认问题切换。");
    expect(engine.curO).toBe("Please confirm the switch.");

    // Next English arrives during the cut hold: it keeps appending (scroll).
    engine.appendOriginal("Next topic.", true);
    expect(engine.curO).toBe("Please confirm the switch. Next topic.");

    engine.appendTranslation("下一个主题。");
    const pendingText = engine.snapshot().pendingCutText || engine.curT;
    engine.onCurrentLineReadable(pendingText);
    clock.advance(500);
    clock.flushZero();
    expect(engine.hist.at(-1)).toMatchObject({
      o: "Please confirm the switch. Next topic.",
      t: "请确认问题切换。",
    });
    expect(engine.curO).toBe("Please confirm the switch. Next topic.");
    expect(engine.curT).toBe("下一个主题。");
  });

  it("does not cut when sentence breaks are disabled", () => {
    const clock = new FakeClock();
    const commits: CommitRecord[] = [];
    let lastHistLen = 0;
    const engine = new SentenceCutEngine({
      now: clock.now,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      sentenceBreaksEnabled: () => false,
      onChange: () => {
        if (engine.hist.length > lastHistLen) {
          const item = engine.hist[engine.hist.length - 1];
          commits.push({ t: clock.nowMs, text: item.t, id: item.id });
          lastHistLen = engine.hist.length;
        }
      },
    });

    engine.appendTranslation("一句。两句。三句。");
    engine.onCurrentLineReadable("一句。两句。三句。");
    clock.advance(5000);
    clock.flushZero();
    expect(commits).toHaveLength(0);
    expect(engine.curT).toBe("一句。两句。三句。");
  });

  it("extends consecutive punctuation into one break", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    // "真的吗？！" is only 3 content chars (<=4), so the tail merges instead of
    // cutting a short head; the consecutive "？！" stay one break.
    engine.appendTranslation("真的吗？！后续");
    expect(engine.curT).toBe("真的吗？！后续");
    expect(engine.snapshot().pendingShortTail).toBe("");
    expect(engine.snapshot().awaitingReadable).toBe(false);
    expect(commits).toHaveLength(0);

    engine.appendTranslation("还要说明。");
    expect(engine.snapshot().awaitingReadable || engine.snapshot().cutHoldActive).toBe(true);
    const cutText = engine.snapshot().pendingCutText || engine.curT;
    expect(cutText).toContain("？！");
    engine.onCurrentLineReadable(cutText);
    clock.advance(500);
    clock.flushZero();
    engine.appendTranslation("继续说明");
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].text).toContain("？！");
    // The merged tail continues after the first commit without re-splitting "？！".
    expect(commits[0].text).not.toMatch(/^[？！]+$/);
  });

  it("reset clears pending cut and history", () => {
    const clock = new FakeClock();
    const { engine } = createEngine(clock);

    engine.appendTranslation("这句话将被清空。");
    expect(engine.snapshot().awaitingReadable).toBe(true);
    engine.reset();
    expect(engine.curT).toBe("");
    expect(engine.hist).toHaveLength(0);
    expect(engine.snapshot().awaitingReadable).toBe(false);
    expect(engine.snapshot().hasPendingCutTimer).toBe(false);
  });

  it("keeps a completed current line until the next translation arrives", () => {
    const clock = new FakeClock();
    const { engine, commits } = createEngine(clock);

    engine.appendTranslation("这句话已经完成。");
    engine.onCurrentLineReadable("这句话已经完成。");
    clock.advance(500);
    clock.flushZero();

    expect(commits).toHaveLength(0);
    expect(engine.hist).toHaveLength(0);
    expect(engine.curT).toBe("这句话已经完成。");
    expect(engine.snapshot().readyToCommit).toBe(true);

    engine.appendTranslation("下一句开始");
    expect(commits).toHaveLength(1);
    expect(engine.hist[0].t).toBe("这句话已经完成。");
    expect(engine.curT).toBe("下一句开始");
  });
});
