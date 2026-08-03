/**
 * Repro harness for double "float-up" (上浮) animations when historyRows=1.
 * Replays the exact packet sequence from the user log around "但是显示显示问题。"
 *
 * PASS: each commit produces at most 1 history-entering animation
 * FAIL (bug): a commit window produces 2 history-entering animations
 */

const MIN_COMMA_BREAK_CHARS = 5;
const MIN_PACKET_TAIL_CHARS = 3;
const MIN_SENTENCE_CUT_DELAY_MS = 500;
const SPEECH_INTERVAL_WINDOW_MS = 30_000;
const DEFAULT_SHORT_TAIL_TIMEOUT_MS = 1_000;

// ── Fake timers ──────────────────────────────────────────────────────────────
let nowMs = 0;
const timers = new Map();
let nextTimerId = 1;

function setFakeTimeout(fn, delay) {
  const id = nextTimerId++;
  timers.set(id, { fn, fireAt: nowMs + delay });
  return id;
}
function clearFakeTimeout(id) {
  timers.delete(id);
}
function advance(ms) {
  const target = nowMs + ms;
  while (true) {
    let next = null;
    for (const [id, t] of timers) {
      if (t.fireAt <= target && (!next || t.fireAt < next.fireAt)) next = { id, ...t };
    }
    if (!next) break;
    nowMs = next.fireAt;
    timers.delete(next.id);
    next.fn();
  }
  nowMs = target;
}
function DateNow() { return nowMs; }

// ── Sentence engine (mirrors main.ts) ────────────────────────────────────────
let curO = "", curT = "";
let hist = [];
let nextHistoryId = 1;
let pendingSentenceCutTimer = null;
let pendingSentenceCutAction = null;
let pendingSentenceCutReady = false;
let pendingShortTail = null;
let sentenceBoundaryTime = 0;
let translationPacketTimes = [];
let sentenceIdleTimer = null;

const events = []; // { type, t, ... }

function logEvent(type, data = {}) {
  events.push({ type, t: nowMs, ...data });
}

function formatDebugText(text) {
  if (!text) return "<empty>";
  return text.length > 36 ? text.slice(0, 36) + "..." : text;
}

function sentenceBreaksEnabled() { return true; } // historyRows=1

function hasTerminalPunctuation(text) {
  return /[。！？!?；;：:\n—]/.test(text);
}
function hasCommaPunctuation(text) {
  return /[，,、]/.test(text);
}
function hasBoundaryPunctuation(text) {
  return hasTerminalPunctuation(text) || hasCommaPunctuation(text);
}
function sentenceCharLength(text) {
  return Array.from(text).filter((char) => !/[\s。！？!?；;，,、：:\n—]/.test(char)).length;
}

function clearSentenceIdleTimer() {
  if (!sentenceIdleTimer) return;
  clearFakeTimeout(sentenceIdleTimer);
  sentenceIdleTimer = null;
}
function clearPendingShortTail() {
  if (pendingShortTail?.timer) clearFakeTimeout(pendingShortTail.timer);
  pendingShortTail = null;
}
function clearPendingSentenceCut() {
  if (pendingSentenceCutTimer) clearFakeTimeout(pendingSentenceCutTimer);
  pendingSentenceCutTimer = null;
  pendingSentenceCutAction = null;
  pendingSentenceCutReady = false;
}

function trackTranslationPacket() {
  const now = DateNow();
  translationPacketTimes.push(now);
  translationPacketTimes = translationPacketTimes.filter((time) => now - time <= SPEECH_INTERVAL_WINDOW_MS);
}

function shortTailTimeoutMs() {
  if (translationPacketTimes.length < 2) return DEFAULT_SHORT_TAIL_TIMEOUT_MS;
  let total = 0;
  for (let i = 1; i < translationPacketTimes.length; i++) {
    total += translationPacketTimes[i] - translationPacketTimes[i - 1];
  }
  const average = total / (translationPacketTimes.length - 1);
  return Math.max(MIN_SENTENCE_CUT_DELAY_MS, average * 1.5);
}

function findSentenceBreakIndex(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (hasTerminalPunctuation(char)) return i;
    if (hasCommaPunctuation(char)) {
      const length = sentenceCharLength(curT + text.slice(0, i + 1));
      if (length >= MIN_COMMA_BREAK_CHARS) return i;
    }
  }
  return -1;
}
function extendSentenceBreakEnd(text, breakIndex) {
  let end = breakIndex;
  while (end + 1 < text.length && hasBoundaryPunctuation(text[end + 1])) end += 1;
  return end;
}

function commitCurrentSentenceNow() {
  if (!curO && !curT) {
    logEvent("skip_commit");
    return;
  }
  const id = nextHistoryId++;
  const committed = { id, o: curO, t: curT };
  hist.push(committed);
  curO = curT = "";
  if (hist.length > 50) hist.shift();
  logEvent("commit", { id, t: committed.t, o: committed.o });
}

function render() {
  // Simulate subtitle overlay with historyRows=1:
  // visibleHistory = last 1 history line
  // When history id changes, old line exits (fadeHistoryOut) and new line enters (shrinkUp = 上浮)
  const historyRows = 1;
  const visible = hist.slice(-historyRows);
  const top = visible[visible.length - 1] || null;
  logEvent("render", {
    histLen: hist.length,
    topId: top?.id ?? null,
    topT: top?.t ?? "",
    curT,
    curO,
  });
}

function appendMergedText(text) {
  if (!text) return;
  curT += text;
  clearSentenceIdleTimer();
  logEvent("append_merged", { curT });
  render();
}

function requestSentenceCut(afterCut) {
  if (!sentenceBreaksEnabled()) {
    afterCut?.();
    return;
  }
  pendingSentenceCutReady = false;
  pendingSentenceCutAction = afterCut || pendingSentenceCutAction;
  const delay = Math.max(0, sentenceBoundaryTime + MIN_SENTENCE_CUT_DELAY_MS - DateNow());
  logEvent("schedule_cut", { delay, hasAction: Boolean(afterCut), curT });
  if (pendingSentenceCutTimer) clearFakeTimeout(pendingSentenceCutTimer);
  pendingSentenceCutTimer = setFakeTimeout(() => {
    pendingSentenceCutTimer = null;
    const action = pendingSentenceCutAction;
    pendingSentenceCutAction = null;
    if (!action) {
      pendingSentenceCutReady = true;
      logEvent("cut_ready", { curT });
      return;
    }
    logEvent("execute_cut", { curT, hasQueued: true });
    commitCurrentSentenceNow();
    action();
  }, delay);
}

function enqueueAfterPendingCut(action) {
  const previousAction = pendingSentenceCutAction;
  pendingSentenceCutAction = () => {
    previousAction?.();
    action();
  };
}

function queueShortTail(tail) {
  clearPendingShortTail();
  const delay = shortTailTimeoutMs();
  logEvent("queue_short_tail", { delay, tail });
  const timer = setFakeTimeout(() => {
    pendingShortTail = null;
    logEvent("short_tail_timeout", { tail });
    requestSentenceCut(() => processTranslationText(tail));
  }, delay);
  pendingShortTail = { tail, timer };
}

function processTranslationText(text) {
  if (!text) return;
  if (pendingShortTail) {
    const pending = pendingShortTail;
    if (pending.timer) clearFakeTimeout(pending.timer);
    pendingShortTail = null;
    logEvent("merge_short_tail", { tail: pending.tail, next: text });
    requestSentenceCut(() => appendMergedText(pending.tail + text));
    return;
  }
  if (pendingSentenceCutTimer) {
    logEvent("queue_after_pending_cut", { text });
    enqueueAfterPendingCut(() => processTranslationText(text));
    return;
  }
  if (pendingSentenceCutReady) {
    const delay = Math.max(0, sentenceBoundaryTime + MIN_SENTENCE_CUT_DELAY_MS - DateNow());
    if (delay > 0) {
      pendingSentenceCutReady = false;
      requestSentenceCut(() => processTranslationText(text));
      return;
    }
    pendingSentenceCutReady = false;
    logEvent("cut_before_next", { text });
    commitCurrentSentenceNow();
    processTranslationText(text);
    return;
  }
  if (!sentenceBreaksEnabled()) {
    curT += text;
    clearSentenceIdleTimer();
    render();
    return;
  }
  const breakIndex = findSentenceBreakIndex(text);
  if (breakIndex < 0) {
    curT += text;
    clearSentenceIdleTimer();
    logEvent("append_no_break", { curT });
    render();
    return;
  }
  const breakEnd = extendSentenceBreakEnd(text, breakIndex);
  const head = text.slice(0, breakEnd + 1);
  const tail = text.slice(breakEnd + 1);
  curT += head;
  sentenceBoundaryTime = DateNow();
  clearSentenceIdleTimer();
  logEvent("break", { head, tail, curT, tailChars: sentenceCharLength(tail) });
  render();

  if (!tail) {
    if (sentenceCharLength(curT) < MIN_PACKET_TAIL_CHARS) {
      logEvent("hold_short_punctuated", { curT });
      return;
    }
    logEvent("request_cut_punct_end");
    requestSentenceCut();
    return;
  }
  if (sentenceCharLength(tail) >= MIN_PACKET_TAIL_CHARS) {
    logEvent("request_cut_long_tail", { tail });
    requestSentenceCut(() => processTranslationText(tail));
    return;
  }
  logEvent("queue_short_tail_decision", { tail });
  queueShortTail(tail);
}

function appendTranslationText(text) {
  if (!text) return;
  trackTranslationPacket();
  logEvent("chunk", { text, curT, pendingCut: Boolean(pendingSentenceCutTimer), pendingTail: pendingShortTail?.tail || "" });
  processTranslationText(text);
}

function onMsg(d) {
  const sc = d.serverContent;
  if (!sc) return;
  if (sc.inputTranscription?.text) {
    curO += sc.inputTranscription.text;
    render();
  }
  if (sc.outputTranscription?.text) {
    appendTranslationText(sc.outputTranscription.text);
  }
}

// ── Minimal history DOM simulator (historyRows=1) ────────────────────────────
// Tracks: history enter (上浮/shrinkUp), history exit (fadeHistoryOut)
let domHistoryKey = null;
let domHistoryText = "";
const animEvents = [];

function applyOverlayFromLastRender() {
  // Use last render event state
  const last = [...events].reverse().find((e) => e.type === "render");
  if (!last) return;
  const historyRows = 1;
  const visible = hist.slice(-historyRows);
  const top = visible[visible.length - 1] || null;
  const nextKey = top ? `${top.id}:t` : null;
  const nextText = top?.t || "";

  if (domHistoryKey && (!nextKey || nextKey !== domHistoryKey)) {
    // old exits
    animEvents.push({ t: nowMs, kind: "history_exit", key: domHistoryKey, text: domHistoryText });
    logEvent("anim_history_exit", { key: domHistoryKey, text: domHistoryText });
  }
  if (nextKey && nextKey !== domHistoryKey) {
    // new enters = 上浮
    animEvents.push({ t: nowMs, kind: "history_enter", key: nextKey, text: nextText });
    logEvent("anim_history_enter", { key: nextKey, text: nextText });
  }
  domHistoryKey = nextKey;
  domHistoryText = nextText;
}

// wrap render to also update anim
const _render = render;
// re-bind: monkey after definition - recreate by patching events push sites
// Instead: call apply after every render via override
function renderAndAnim() {
  const historyRows = 1;
  const visible = hist.slice(-historyRows);
  const top = visible[visible.length - 1] || null;
  logEvent("render", {
    histLen: hist.length,
    topId: top?.id ?? null,
    topT: top?.t ?? "",
    curT,
    curO,
  });
  const nextKey = top ? `${top.id}:t` : null;
  const nextText = top?.t || "";
  if (domHistoryKey && (!nextKey || nextKey !== domHistoryKey)) {
    animEvents.push({ t: nowMs, kind: "history_exit", key: domHistoryKey, text: domHistoryText });
    logEvent("anim_history_exit", { key: domHistoryKey, text: domHistoryText });
  }
  if (nextKey && nextKey !== domHistoryKey) {
    animEvents.push({ t: nowMs, kind: "history_enter", key: nextKey, text: nextText });
    logEvent("anim_history_enter", { key: nextKey, text: nextText });
  }
  domHistoryKey = nextKey;
  domHistoryText = nextText;
}

// Replace render body usage - processTranslationText already calls render()
// We need to patch: redefine render in outer scope by re-assigning via global trick
// Easiest: copy all functions to call renderAndAnim - use Object approach

// Monkey-patch: replace function render by redefining through assignment on a bag
// Actually in this script render is a function declaration hoisted - let's just post-process commits

// ── Replay exact user log sequence (relative times) ──────────────────────────
// From user log, only translation (output) and input packets that matter for curO/curT
const packets = [
  // time relative ms from first relevant packet in the double-float region
  // Full sequence from start of log for context
  { at: 0, kind: "in", text: "testi" }, // 01:31:08.757 - approximated; we care about later
  { at: 3, kind: "out", text: "显示" }, // chunk after cur was 切换 - we'll seed
];

// Better: seed state and only replay from a clean point matching the bug window.
// From log:
// At 01:31:14.677 commit id=3 t=上浮记录如果！ then cur=继续需要
// Then packets leading to double float around 但是显示显示问题

function resetEngine() {
  curO = ""; curT = ""; hist = []; nextHistoryId = 1;
  pendingSentenceCutTimer = null; pendingSentenceCutAction = null; pendingSentenceCutReady = false;
  pendingShortTail = null; sentenceBoundaryTime = 0; translationPacketTimes = [];
  sentenceIdleTimer = null; events.length = 0; animEvents.length = 0;
  domHistoryKey = null; domHistoryText = "";
  timers.clear(); nowMs = 0;
}

// Patch: force all render() calls to use anim tracking
// Because render is const function, re-implement by running post-process on events

function countAnimInWindow(fromT, toT) {
  return animEvents.filter((a) => a.t >= fromT && a.t <= toT);
}

// ── Build post-process anim from render+commit events ───────────────────────
function deriveAnimationsFromEvents(evs) {
  let histArr = [];
  let nextId = 1;
  let curTLocal = "";
  let curOLocal = "";
  // We'll re-simulate DOM from render events only - render already has histLen/topId
  let key = null;
  let text = "";
  const anims = [];
  for (const e of evs) {
    if (e.type !== "render") continue;
    const nextKey = e.topId != null ? `${e.topId}:t` : null;
    const nextText = e.topT || "";
    if (key && (!nextKey || nextKey !== key)) {
      anims.push({ t: e.t, kind: "history_exit", key, text });
    }
    if (nextKey && nextKey !== key) {
      anims.push({ t: e.t, kind: "history_enter", key: nextKey, text: nextText });
    }
    key = nextKey;
    text = nextText;
  }
  return anims;
}

// ── Scenario A: exact packets from user log (translation path only) ──────────
// Reconstruct from logs with approximate timings matching user log absolute diffs

function runUserLogScenario() {
  resetEngine();

  // Seed mid-session state right before the interesting sequence.
  // From log at 01:31:14.678: after commit id=3, cur="继续需要", hist has 3 items
  // We only care about historyRows=1 so prior history content barely matters for DOM
  // But nextHistoryId must be 4 next.
  hist = [
    { id: 1, o: "x", t: "prev1" },
    { id: 2, o: "x", t: "prev2" },
    { id: 3, o: "hellohello", t: "上浮记录如果！" },
  ];
  nextHistoryId = 4;
  curO = "";
  curT = "继续需要";
  // seed packet times for short tail timeout calc similar to log (~800ms avg)
  for (let i = 0; i < 12; i++) translationPacketTimes.push(nowMs - (12 - i) * 824);

  // initial render so DOM has id=3 history
  render();
  // manually set anim baseline for id=3 without counting as double
  const baselineAnims = deriveAnimationsFromEvents(events);
  // clear baseline enters from count later

  // packets from user log with relative times from 01:31:14.678
  // 15.325 burst (ignore)
  // 15.331 out? actually 我们重复 is out path via chunk - log says chunk="我们重复" after input msg
  // Looking carefully:
  // 15.331 input sentence...
  // 15.333 chunk="我们重复"  <- translation
  // 16.165 out "字幕上浮、但是"
  // 16.308 input testi
  // 16.912 input stream
  // 16.915 chunk="显示显示问题。"
  // 17.397 out "字幕现在字幕：然后"
  // 17.457 input meeting
  // 17.459 chunk="动画确认"
  // 17.563 input chunk
  // 17.903 execute cut
  // 18.121 input
  // 18.123 chunk="如果观察记录"

  const t0 = 14678; // fake base so times match log milliseconds portion-ish
  nowMs = t0;
  // re-seed packet times absolute
  translationPacketTimes = [];
  for (let i = 0; i < 12; i++) translationPacketTimes.push(nowMs - (12 - i) * 824);

  // re-render at new time
  events.length = 0;
  render();

  const schedule = [
    { at: 15333, fn: () => { curO += "sentence"; render(); appendTranslationText("我们重复"); } },
    { at: 16165, fn: () => appendTranslationText("字幕上浮、但是") },
    { at: 16308, fn: () => { curO += "testing"; render(); } },
    { at: 16912, fn: () => { curO += "stream"; render(); } },
    { at: 16915, fn: () => appendTranslationText("显示显示问题。") },
    { at: 17397, fn: () => appendTranslationText("字幕现在字幕：然后") },
    { at: 17457, fn: () => { curO += "meeting"; render(); } },
    { at: 17459, fn: () => appendTranslationText("动画确认") },
    { at: 17563, fn: () => { curO += "chunkhello"; render(); } },
    // execute cut scheduled ~437ms after 17461 -> ~17900
    { at: 18121, fn: () => { curO += "meeting"; render(); } },
    { at: 18123, fn: () => appendTranslationText("如果观察记录") },
  ];

  // Drive timeline
  let cursor = t0;
  for (const step of schedule) {
    advance(step.at - cursor);
    cursor = step.at;
    step.fn();
  }
  advance(2000); // flush remaining timers

  const anims = deriveAnimationsFromEvents(events);
  const commits = events.filter((e) => e.type === "commit");
  const enters = anims.filter((a) => a.kind === "history_enter");
  const exits = anims.filter((a) => a.kind === "history_exit");

  console.log("=== User-log scenario ===");
  console.log("commits:", commits.map((c) => ({ t: c.t, id: c.id, text: c.t })));
  console.log("commits detail:", commits);
  console.log("history enters (上浮):", enters);
  console.log("history exits:", exits);
  console.log("curT final:", curT);
  console.log("hist final:", hist.map((h) => ({ id: h.id, t: h.t })));

  // Focus window around first double-suspect: merge short tail "但是" + cut of previous
  // That is commit id=4 at ~16923
  const windowAroundId4 = enters.filter((a) => a.t >= 16900 && a.t <= 17100);
  const windowAroundId5 = enters.filter((a) => a.t >= 17800 && a.t <= 18100);

  console.log("enters near id4 (~16923):", windowAroundId4);
  console.log("enters near id5 (~17903):", windowAroundId5);

  // Bug signal: more than one history_enter within 50ms of a commit
  let doubleFloatFound = false;
  for (const c of commits) {
    const near = enters.filter((a) => Math.abs(a.t - c.t) <= 50);
    if (near.length > 1) {
      doubleFloatFound = true;
      console.log("DOUBLE FLOAT near commit", c, near);
    }
  }

  // Also: two enters within 400ms (animation duration) without enough visual settle
  for (let i = 1; i < enters.length; i++) {
    const gap = enters[i].t - enters[i - 1].t;
    if (gap < 400) {
      doubleFloatFound = true;
      console.log("RAPID consecutive 上浮 gap=" + gap + "ms", enters[i - 1], enters[i]);
    }
  }

  // Print relevant events around bug
  console.log("--- events 16100-18000 ---");
  for (const e of events) {
    if (e.t >= 16100 && e.t <= 18000) {
      const { type, t, ...rest } = e;
      console.log(t, type, JSON.stringify(rest).slice(0, 160));
    }
  }

  return { commits, enters, exits, doubleFloatFound, events, anims };
}

// ── Scenario B: minimal repro for short-tail merge cut ───────────────────────
function runMinimalShortTailScenario() {
  resetEngine();
  hist = [{ id: 1, o: "a", t: "历史行A" }];
  nextHistoryId = 2;
  curT = "继续需要我们重复";
  for (let i = 0; i < 5; i++) translationPacketTimes.push(nowMs - (5 - i) * 800);
  render();

  // packet with comma + short tail
  appendTranslationText("字幕上浮、但是");
  // next text arrives soon (like log 750ms later)
  advance(750);
  appendTranslationText("显示显示问题。");
  advance(100); // cut delay was 0
  advance(500);

  // next terminal break with short tail soon after
  appendTranslationText("字幕现在字幕：然后");
  advance(60);
  appendTranslationText("动画确认");
  advance(500);
  advance(100);

  const anims = deriveAnimationsFromEvents(events);
  const commits = events.filter((e) => e.type === "commit");
  const enters = anims.filter((a) => a.kind === "history_enter");

  console.log("\n=== Minimal short-tail scenario ===");
  console.log("commits:", commits);
  console.log("enters:", enters);
  for (let i = 1; i < enters.length; i++) {
    console.log("gap", enters[i].t - enters[i - 1].t, "ms between", enters[i - 1].text, "->", enters[i].text);
  }
  console.log("--- events ---");
  for (const e of events) {
    const { type, t, ...rest } = e;
    console.log(t, type, JSON.stringify(rest).slice(0, 180));
  }

  let rapid = false;
  for (let i = 1; i < enters.length; i++) {
    if (enters[i].t - enters[i - 1].t < 400) rapid = true;
  }
  return { commits, enters, rapid };
}

// ── Scenario C: what does overlay do on commit+new current in ONE render? ────
// Real code: commit then action then ONE render at end of appendMergedText
// So one frame: history gains new line, current becomes new text
// With historyRows=1: old history exits, new history enters — ONE enter per commit
// Unless TWO commits happen before next paint / two commits close together

function runDoubleCommitSameFrameHypothesis() {
  resetEngine();
  // Can one processTranslationText path call commit twice before render?
  // Looking at code: requestSentenceCut action does commit then action.
  // action is appendMergedText which does NOT re-break punctuation (no processTranslationText)
  // So "但是显示显示问题。" is appended WITHOUT re-scanning breaks!
  // That means "。" in merged text does NOT trigger another cut immediately.

  hist = [{ id: 1, o: "", t: "prev" }];
  nextHistoryId = 2;
  curT = "继续需要我们重复字幕上浮、";
  sentenceBoundaryTime = nowMs; // just hit break
  for (let i = 0; i < 5; i++) translationPacketTimes.push(nowMs - (5 - i) * 800);
  // simulate pending short tail already
  pendingShortTail = { tail: "但是", timer: null };
  render();

  // next packet merges and schedules cut delay 0
  appendTranslationText("显示显示问题。");
  advance(0);
  advance(10);

  const commits = events.filter((e) => e.type === "commit");
  const anims = deriveAnimationsFromEvents(events);
  const enters = anims.filter((a) => a.kind === "history_enter");
  console.log("\n=== Double-commit same frame hypothesis ===");
  console.log("commits in one merge:", commits.length, commits);
  console.log("enters:", enters);
  console.log("curT after merge cut:", curT);
  // KEY: does merged text with 。 get cut again?
  return { commits, enters, curT, events: events.filter(e => ["commit","append_merged","schedule_cut","execute_cut","break","merge_short_tail"].includes(e.type)) };
}

const A = runUserLogScenario();
const B = runMinimalShortTailScenario();
const C = runDoubleCommitSameFrameHypothesis();

console.log("\n======== VERDICT ========");
console.log("User log doubleFloatFound:", A.doubleFloatFound);
console.log("Minimal rapid consecutive 上浮:", B.rapid);
console.log("Same-frame double commit?", C.commits.length > 1, "curT=", C.curT);

// Assert for CI-like loop
// The user's symptom: 两次上浮 around 但是显示显示问题
// We check if there are 2 history enters within 400ms in minimal scenario
if (B.rapid || A.doubleFloatFound) {
  console.log("\nRESULT: RED — double/rapid 上浮 reproduced");
  process.exit(1);
} else {
  console.log("\nRESULT: GREEN — no double 上浮 from history enter count alone");
  console.log("Need alternate hypothesis (current-line enter + history enter, or exit+enter visual as two floats)");
  process.exit(0);
}
