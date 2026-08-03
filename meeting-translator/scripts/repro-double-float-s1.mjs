/**
 * Red-capable probes for "两次上浮" around short-tail merge cut.
 * Symptom models:
 *  S1: per commit with existing history, exit+enter both upward (dual upward motion)
 *  S2: two commits within 1000ms (rapid successive 上浮 cycles)
 *  S3: history-enter animation restart (class rewrite while entering)
 *  S4: appendMergedText leaves terminal punct; next break causes second cut soon after
 */

const MIN_COMMA_BREAK_CHARS = 5;
const MIN_PACKET_TAIL_CHARS = 3;
const MIN_SENTENCE_CUT_DELAY_MS = 500;
const SPEECH_INTERVAL_WINDOW_MS = 30_000;

let nowMs = 0;
const timers = new Map();
let nextTimerId = 1;
function setFakeTimeout(fn, delay) {
  const id = nextTimerId++;
  timers.set(id, { fn, fireAt: nowMs + Math.max(0, delay) });
  return id;
}
function clearFakeTimeout(id) { timers.delete(id); }
function advance(ms) {
  const target = nowMs + ms;
  while (true) {
    let next = null;
    for (const [id, t] of timers) {
      if (t.fireAt <= target && (!next || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && id < next.id))) {
        next = { id, ...t };
      }
    }
    if (!next) break;
    nowMs = next.fireAt;
    timers.delete(next.id);
    next.fn();
  }
  nowMs = target;
}

// Engine state
let curO = "", curT = "";
let hist = [];
let nextHistoryId = 1;
let pendingSentenceCutTimer = null;
let pendingSentenceCutAction = null;
let pendingSentenceCutReady = false;
let pendingShortTail = null;
let sentenceBoundaryTime = 0;
let translationPacketTimes = [];
const events = [];

function log(type, data = {}) { events.push({ type, t: nowMs, ...data }); }

function hasTerminalPunctuation(text) { return /[。！？!?；;：:\n—]/.test(text); }
function hasCommaPunctuation(text) { return /[，,、]/.test(text); }
function hasBoundaryPunctuation(text) { return hasTerminalPunctuation(text) || hasCommaPunctuation(text); }
function sentenceCharLength(text) {
  return Array.from(text).filter((char) => !/[\s。！？!?；;，,、：:\n—]/.test(char)).length;
}
function findSentenceBreakIndex(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (hasTerminalPunctuation(char)) return i;
    if (hasCommaPunctuation(char)) {
      if (sentenceCharLength(curT + text.slice(0, i + 1)) >= MIN_COMMA_BREAK_CHARS) return i;
    }
  }
  return -1;
}
function extendSentenceBreakEnd(text, breakIndex) {
  let end = breakIndex;
  while (end + 1 < text.length && hasBoundaryPunctuation(text[end + 1])) end += 1;
  return end;
}
function shortTailTimeoutMs() {
  if (translationPacketTimes.length < 2) return 1000;
  let total = 0;
  for (let i = 1; i < translationPacketTimes.length; i++) total += translationPacketTimes[i] - translationPacketTimes[i - 1];
  return Math.max(MIN_SENTENCE_CUT_DELAY_MS, (total / (translationPacketTimes.length - 1)) * 1.5);
}
function trackTranslationPacket() {
  translationPacketTimes.push(nowMs);
  translationPacketTimes = translationPacketTimes.filter((t) => nowMs - t <= SPEECH_INTERVAL_WINDOW_MS);
}

// DOM/anim model for historyRows=1
let historyDom = null; // { key, text, enteringUntil, className }
const animStarts = []; // { t, kind, key, text, note }

function emitRender() {
  const historyRows = 1;
  const visible = hist.slice(-historyRows);
  const top = visible[0] || null;
  const nextKey = top ? `${top.id}:t` : null;
  const nextText = top?.t || "";
  const nextClass = top ? `line trans age-1` : null;

  // Simulate syncHistoryLines
  if (historyDom && (!nextKey || historyDom.key !== nextKey)) {
    // exit old
    animStarts.push({ t: nowMs, kind: "fadeHistoryOut", key: historyDom.key, text: historyDom.text, note: "upward -8px" });
    log("anim", { kind: "exit", key: historyDom.key, text: historyDom.text });
    historyDom = null;
  }
  if (nextKey) {
    if (!historyDom) {
      historyDom = { key: nextKey, text: nextText, enteringUntil: nowMs + 360, className: `${nextClass} entering history-entering` };
      animStarts.push({ t: nowMs, kind: "shrinkUp", key: nextKey, text: nextText, note: "upward from +26px (上浮)" });
      log("anim", { kind: "enter", key: nextKey, text: nextText });
    } else {
      // same key - class update
      if (historyDom.className !== nextClass && historyDom.className !== `${nextClass} entering history-entering`) {
        const stillEntering = nowMs < historyDom.enteringUntil;
        if (stillEntering) {
          // pendingClass path - no restart
          log("anim", { kind: "pending_class", key: nextKey });
        } else {
          historyDom.className = nextClass;
          // assigning className without animation classes should NOT restart
        }
      }
      if (historyDom.text !== nextText) {
        // text change on same key - real code only updates text, no re-enter
        historyDom.text = nextText;
        log("anim", { kind: "text_update", key: nextKey, text: nextText });
      }
    }
  }
  log("render", { hist: hist.map(h => h.t), curT, topKey: nextKey });
}

function commitCurrentSentenceNow() {
  if (!curO && !curT) return;
  const id = nextHistoryId++;
  const item = { id, o: curO, t: curT };
  hist.push(item);
  curO = curT = "";
  log("commit", { id, t: item.t });
}
function appendMergedText(text) {
  curT += text;
  log("append_merged", { curT });
  emitRender();
}
function requestSentenceCut(afterCut) {
  pendingSentenceCutReady = false;
  pendingSentenceCutAction = afterCut || pendingSentenceCutAction;
  const delay = Math.max(0, sentenceBoundaryTime + MIN_SENTENCE_CUT_DELAY_MS - nowMs);
  log("schedule_cut", { delay, hasAction: Boolean(afterCut) });
  if (pendingSentenceCutTimer) clearFakeTimeout(pendingSentenceCutTimer);
  pendingSentenceCutTimer = setFakeTimeout(() => {
    pendingSentenceCutTimer = null;
    const action = pendingSentenceCutAction;
    pendingSentenceCutAction = null;
    if (!action) { pendingSentenceCutReady = true; log("cut_ready"); return; }
    log("execute_cut");
    commitCurrentSentenceNow();
    action();
  }, delay);
}
function queueShortTail(tail) {
  if (pendingShortTail?.timer) clearFakeTimeout(pendingShortTail.timer);
  const delay = shortTailTimeoutMs();
  log("queue_short_tail", { tail, delay });
  const timer = setFakeTimeout(() => {
    pendingShortTail = null;
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
    log("merge_short_tail", { tail: pending.tail, next: text });
    requestSentenceCut(() => appendMergedText(pending.tail + text));
    return;
  }
  if (pendingSentenceCutTimer) {
    const prev = pendingSentenceCutAction;
    pendingSentenceCutAction = () => { prev?.(); processTranslationText(text); };
    return;
  }
  if (pendingSentenceCutReady) {
    const delay = Math.max(0, sentenceBoundaryTime + MIN_SENTENCE_CUT_DELAY_MS - nowMs);
    if (delay > 0) {
      pendingSentenceCutReady = false;
      requestSentenceCut(() => processTranslationText(text));
      return;
    }
    pendingSentenceCutReady = false;
    commitCurrentSentenceNow();
    processTranslationText(text);
    return;
  }
  const breakIndex = findSentenceBreakIndex(text);
  if (breakIndex < 0) {
    curT += text;
    log("append", { curT });
    emitRender();
    return;
  }
  const breakEnd = extendSentenceBreakEnd(text, breakIndex);
  const head = text.slice(0, breakEnd + 1);
  const tail = text.slice(breakEnd + 1);
  curT += head;
  sentenceBoundaryTime = nowMs;
  log("break", { head, tail, curT });
  emitRender();
  if (!tail) {
    if (sentenceCharLength(curT) < MIN_PACKET_TAIL_CHARS) return;
    requestSentenceCut();
    return;
  }
  if (sentenceCharLength(tail) >= MIN_PACKET_TAIL_CHARS) {
    requestSentenceCut(() => processTranslationText(tail));
    return;
  }
  queueShortTail(tail);
}
function appendTranslationText(text) {
  trackTranslationPacket();
  processTranslationText(text);
}

function reset() {
  curO = curT = ""; hist = []; nextHistoryId = 1;
  pendingSentenceCutTimer = null; pendingSentenceCutAction = null; pendingSentenceCutReady = false;
  pendingShortTail = null; sentenceBoundaryTime = 0; translationPacketTimes = [];
  events.length = 0; animStarts.length = 0; historyDom = null; timers.clear(); nowMs = 0;
}

// ── Scenario: exact user bug window ──────────────────────────────────────────
reset();
hist = [{ id: 3, o: "hellohello", t: "上浮记录如果！" }];
nextHistoryId = 4;
curT = "继续需要";
for (let i = 0; i < 12; i++) translationPacketTimes.push(-(12 - i) * 824);
emitRender(); // baseline enter for id=3
const baselineAnimCount = animStarts.length;

// times relative matching user log (ms)
const steps = [
  [655, () => appendTranslationText("我们重复")],           // ~15333-14678
  [1487, () => appendTranslationText("字幕上浮、但是")],    // 16165
  [2237, () => appendTranslationText("显示显示问题。")],    // 16915
  // cut delay 0 fires inside advance/call
  [2719, () => appendTranslationText("字幕现在字幕：然后")], // 17397
  [2781, () => appendTranslationText("动画确认")],          // 17459
  // cut ~437ms later at ~3218
  [3445, () => appendTranslationText("如果观察记录")],      // 18123
];

let prev = 0;
for (const [at, fn] of steps) {
  advance(at - prev);
  prev = at;
  fn();
}
advance(2000);

const commits = events.filter(e => e.type === "commit");
const animsAfterBaseline = animStarts.slice(baselineAnimCount);
const enters = animsAfterBaseline.filter(a => a.kind === "shrinkUp");
const exits = animsAfterBaseline.filter(a => a.kind === "fadeHistoryOut");

console.log("=== Commits ===");
commits.forEach(c => console.log(`  t=${c.t} id=${c.id} text=${c.t}`));
// fix print
commits.forEach(c => console.log("  ", c));

console.log("\n=== Upward animations after baseline ===");
animsAfterBaseline.forEach(a => console.log(`  t=${a.t} ${a.kind} key=${a.key} text=${a.text}`));

// Group animations by commit time (within 5ms of commit)
console.log("\n=== Per-commit upward motion count ===");
let s1Red = false;
for (const c of commits) {
  const near = animsAfterBaseline.filter(a => Math.abs(a.t - c.t) <= 5);
  const up = near.filter(a => a.kind === "shrinkUp" || a.kind === "fadeHistoryOut");
  console.log(`commit id=${c.id} at ${c.t}: ${up.length} upward anims`, up.map(a => a.kind));
  if (up.length >= 2) s1Red = true;
}

// S2: commits within 1000ms
let s2Red = false;
for (let i = 1; i < commits.length; i++) {
  const gap = commits[i].t - commits[i - 1].t;
  console.log(`commit gap id${commits[i-1].id}->id${commits[i].id}: ${gap}ms`);
  if (gap < 1000) s2Red = true;
}

// S4: merged text has terminal punct but not cut until later
const merges = events.filter(e => e.type === "append_merged");
console.log("\n=== Merged currents ===");
merges.forEach(m => {
  const hasTerm = /[。！？!?；;：:]/.test(m.curT);
  console.log(`  t=${m.t} hasTerminal=${hasTerm} curT=${m.curT}`);
});

// Detail around first merge (但是显示显示问题)
console.log("\n=== Event slice around 但是显示显示问题 (2000-3500) ===");
for (const e of events) {
  if (e.t >= 2000 && e.t <= 3500) {
    const { type, t, ...rest } = e;
    console.log(t, type, JSON.stringify(rest).slice(0, 140));
  }
}

// Simultaneous pair count (exit+enter same timestamp)
const dualAtSameT = [];
const byT = new Map();
for (const a of animsAfterBaseline) {
  if (!byT.has(a.t)) byT.set(a.t, []);
  byT.get(a.t).push(a);
}
for (const [t, list] of byT) {
  if (list.some(a => a.kind === "fadeHistoryOut") && list.some(a => a.kind === "shrinkUp")) {
    dualAtSameT.push({ t, list });
  }
}
console.log("\n=== Simultaneous exit+enter pairs (double 上浮 visual) ===");
console.log(dualAtSameT.map(d => ({ t: d.t, kinds: d.list.map(x => x.kind), texts: d.list.map(x => x.text) })));

console.log("\n======== VERDICT ========");
console.log("S1 dual upward per commit (exit+enter):", s1Red ? "RED" : "GREEN");
console.log("S2 rapid commits <1000ms:", s2Red ? "RED" : "GREEN");
console.log("S1 pairs count:", dualAtSameT.length);

// The user symptom "两次上浮" is RED if S1 (structural) or S2 (this log window)
if (s1Red || s2Red) {
  console.log("RESULT: RED — reproduces dual/rapid 上浮 pattern from user log");
  process.exit(1);
}
console.log("RESULT: GREEN");
process.exit(0);
