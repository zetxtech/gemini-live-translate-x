import { describe, expect, it } from "vitest";
import {
  clampHistoryStaticOffset,
  clampTranslateX,
  computeBilingualSyncTarget,
  computeScrollHoldUntil,
  computeScrollRawTarget,
  isCurrentLineReadable,
  isScrollHolding,
  SCROLL_READ_HOLD_MS,
  shouldResetScrollOnNonContinuation,
} from "./subtitle-scroll";

describe("horizontal scroll invariants", () => {
  it("first paint / short text raw target is 0 (no right shift)", () => {
    expect(
      computeScrollRawTarget({
        lineClientWidth: 400,
        textScrollWidth: 120,
        isCurrentLine: true,
        hasText: true,
      }),
    ).toBe(0);
  });

  it("long text raw target is negative (scroll left only)", () => {
    const raw = computeScrollRawTarget({
      lineClientWidth: 400,
      textScrollWidth: 900,
      isCurrentLine: true,
      hasText: true,
    });
    expect(raw).toBe(-500);
    expect(raw).toBeLessThanOrEqual(0);
  });

  it("non-current / empty text never scrolls", () => {
    expect(
      computeScrollRawTarget({
        lineClientWidth: 400,
        textScrollWidth: 900,
        isCurrentLine: false,
        hasText: true,
      }),
    ).toBe(0);
    expect(
      computeScrollRawTarget({
        lineClientWidth: 400,
        textScrollWidth: 900,
        isCurrentLine: true,
        hasText: false,
      }),
    ).toBe(0);
  });

  it("clamp never allows positive translateX", () => {
    expect(clampTranslateX(40, -200)).toBe(0);
    expect(clampTranslateX(-10, -200)).toBe(-10);
    expect(clampTranslateX(-300, -200)).toBe(-200);
    expect(clampTranslateX(12, 0)).toBe(0);
  });

  it("holds at x=0 for SCROLL_READ_HOLD_MS after text becomes readable", () => {
    const holdUntil = computeScrollHoldUntil({
      previousHadReadableText: false,
      nowHasReadableText: true,
      nowMs: 1000,
    });
    expect(holdUntil).toBe(1000 + SCROLL_READ_HOLD_MS);
    expect(isScrollHolding(1000 + SCROLL_READ_HOLD_MS - 1, holdUntil)).toBe(true);
    expect(isScrollHolding(1000 + SCROLL_READ_HOLD_MS, holdUntil)).toBe(false);
  });

  it("does not re-arm hold when text was already readable", () => {
    expect(
      computeScrollHoldUntil({
        previousHadReadableText: true,
        nowHasReadableText: true,
        nowMs: 5000,
      }),
    ).toBe(0);
  });

  it("bilingual sync uses the most negative target", () => {
    expect(computeBilingualSyncTarget([0, -120, -40])).toBe(-120);
    expect(computeBilingualSyncTarget([10, 5])).toBe(0);
    expect(computeBilingualSyncTarget([])).toBe(0);
  });

  it("history static offset is clamped left-only", () => {
    expect(clampHistoryStaticOffset(-50, 400, 900)).toBe(-50);
    expect(clampHistoryStaticOffset(30, 400, 900)).toBe(0);
    expect(clampHistoryStaticOffset(-999, 400, 900)).toBe(-500);
  });

  it("non-continuation text resets scroll", () => {
    expect(shouldResetScrollOnNonContinuation("第一句", "第二句")).toBe(true);
    expect(shouldResetScrollOnNonContinuation("你好", "你好世界")).toBe(false);
    expect(shouldResetScrollOnNonContinuation("", "你好")).toBe(false);
  });
});

describe("readable signal for cut hold", () => {
  it("short line is readable immediately (no overflow)", () => {
    expect(
      isCurrentLineReadable({
        isCurrentTrans: true,
        text: "确认问题切换。",
        rawTarget: 0,
        offset: 0,
        velocity: 0,
      }),
    ).toBe(true);
  });

  it("long line is not readable until scroll settles", () => {
    expect(
      isCurrentLineReadable({
        isCurrentTrans: true,
        text: "这是一句很长需要横向滚动才能看完末尾的字幕内容。",
        rawTarget: -400,
        offset: -10,
        velocity: -80,
      }),
    ).toBe(false);
    expect(
      isCurrentLineReadable({
        isCurrentTrans: true,
        text: "这是一句很长需要横向滚动才能看完末尾的字幕内容。",
        rawTarget: -400,
        offset: -400,
        velocity: 0,
      }),
    ).toBe(true);
  });

  it("ignores original / empty / placeholder lines", () => {
    expect(
      isCurrentLineReadable({
        isCurrentTrans: false,
        text: "Hello",
        rawTarget: 0,
        offset: 0,
        velocity: 0,
      }),
    ).toBe(false);
    expect(
      isCurrentLineReadable({
        isCurrentTrans: true,
        text: "\u00a0",
        rawTarget: 0,
        offset: 0,
        velocity: 0,
      }),
    ).toBe(false);
  });
});
