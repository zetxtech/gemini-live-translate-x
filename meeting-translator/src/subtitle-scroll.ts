/**
 * Pure horizontal-scroll helpers for the subtitle overlay.
 * Invariants:
 * 1. First paint of current text uses translateX = 0.
 * 2. translateX is never positive (text never moves right).
 * 3. Short text that fits the line does not scroll.
 * 4. Long text holds at 0 for SCROLL_READ_HOLD_MS before chasing the target.
 * 5. History lines do not live-scroll (static clamp only).
 */

export const SCROLL_READ_HOLD_MS = 530;

export type ScrollTargetInput = {
  lineClientWidth: number;
  textScrollWidth: number;
  isCurrentLine: boolean;
  hasText: boolean;
};

/** Left-anchored scroll target. Always <= 0. */
export function computeScrollRawTarget(input: ScrollTargetInput): number {
  if (!input.isCurrentLine || !input.hasText || input.textScrollWidth <= 0) {
    return 0;
  }
  return Math.min(0, input.lineClientWidth - input.textScrollWidth);
}

/** Hard clamp: never allow positive (rightward) translateX. */
export function clampTranslateX(offset: number, rawTarget = 0): number {
  const upperBound = 0;
  const lowerBound = Math.min(0, rawTarget);
  return Math.max(lowerBound, Math.min(upperBound, offset));
}

/**
 * Bilingual sync: drive both current rows with the most-negative target so
 * translation and original stay visually aligned while scrolling left.
 */
export function computeBilingualSyncTarget(targets: number[]): number {
  if (targets.length === 0) return 0;
  let mostNegative = 0;
  for (const target of targets) {
    const clamped = Math.min(0, target);
    if (clamped < mostNegative) mostNegative = clamped;
  }
  return mostNegative;
}

export type ScrollHoldInput = {
  previousHadReadableText: boolean;
  nowHasReadableText: boolean;
  nowMs: number;
  holdMs?: number;
};

/** When text first becomes readable, hold at translateX=0 for holdMs. */
export function computeScrollHoldUntil(input: ScrollHoldInput): number {
  const holdMs = input.holdMs ?? SCROLL_READ_HOLD_MS;
  if (!input.previousHadReadableText && input.nowHasReadableText) {
    return input.nowMs + holdMs;
  }
  return 0;
}

export function isScrollHolding(nowMs: number, holdUntil: number): boolean {
  return holdUntil > 0 && nowMs < holdUntil;
}

/**
 * Readable = last character is in view (no overflow, or scroll settled at target).
 * Used by the cut engine's "await readable then 500ms hold" path.
 */
export function isCurrentLineReadable(input: {
  isCurrentTrans: boolean;
  text: string;
  rawTarget: number;
  offset: number;
  velocity: number;
  settledEpsilon?: number;
  velocityEpsilon?: number;
}): boolean {
  if (!input.isCurrentTrans) return false;
  const trimmed = input.text.trim();
  if (!trimmed || trimmed === "\u00a0") return false;
  const settledEpsilon = input.settledEpsilon ?? 0.5;
  const velocityEpsilon = input.velocityEpsilon ?? 2;
  // No overflow: last char already visible at x=0.
  if (input.rawTarget >= -settledEpsilon) return true;
  // Overflow: only readable once scroll has settled on the left target.
  return (
    Math.abs(input.rawTarget - input.offset) < settledEpsilon
    && Math.abs(input.velocity) < velocityEpsilon
  );
}

export function shouldResetScrollOnNonContinuation(
  previousText: string,
  nextText: string,
): boolean {
  if (!previousText || !nextText) return false;
  return !nextText.startsWith(previousText);
}

/** History lines keep a static offset; never animate live scroll. */
export function clampHistoryStaticOffset(
  offset: number,
  lineClientWidth: number,
  textScrollWidth: number,
): number {
  const minOffset = Math.min(0, lineClientWidth - textScrollWidth);
  return Math.max(minOffset, Math.min(0, offset));
}
