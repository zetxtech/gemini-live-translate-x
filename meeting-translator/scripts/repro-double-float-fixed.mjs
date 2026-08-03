// Fixed harness: assert dual upward motion on history commit (historyRows=1)
// and short-tail merge skipping re-break of terminal punctuation.

const MIN_COMMA_BREAK_CHARS = 5;
const MIN_PACKET_TAIL_CHARS = 3;
const MIN_SENTENCE_CUT_DELAY_MS = 500;

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
      if (t.fireAt <= target && (!next || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && id < next.id))) next = { id, ...t };
    }
    if (!next) break;
    nowMs = next.fireAt;
    timers.delete(next.id);
    next.fn();
  }
  nowMs = target;
}

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
function log(type, data = {}) { events.push({ type, time: nowMs, ...data }); }

function hasTerminal(text) { return /[。！？!?；;：:\n—]/.test(text); }
function hasComma(text) { return /[，,、]/.test(text); }
function hasBoundary(text) { return hasTerminal(text) || hasComma(text); }
function charLen(text) {
  return Array.from(text).filter((c) => !/[\s。！？!?；;，,、：:\n—]/.test(c)).length;
}
function findBreak(text) {
  for (let i = 0; i < text.length; i++) {
    if (hasTerminal(text[i])) return i;
    if (hasComma(text[i]) && charLen(curT + text.slice(0, i + 1)) >= MIN_COMMA_BREAK_CHARS) return i;
  }
  return -1;
}
function extendBreak(text, i) {
  let end = i;
  while (end + 1 < text.length && hasBoundary(text[end + 1])) end++;
  return end;
}
function track() {
  translationPacketTimes.push(nowMs);
  translationPacketTimes = translationPacketTimes.filter((t) => nowMs - t <= 30000);
}
function shortTailMs() {
  if (translationPacketTimes.length < 2) return 1000;
  let total = 0;
  for (let i = 1; i < translationPacketTimes.length; i++) total += translationPacketTimes[i] - translationPacketTimes[i - 1];
  return Math.max(MIN_SENTENCE_CUT_DELAY_MS, (total / (translationPacketTimes.length - 1)) * 1.5);
}

let historyKey = null;
let historyText = "";
const anims = [];

function emitRender() {
  const top = hist[hist.length - 1] || null; // historyRows=1 => last only for visible, but we only care about top key change
  // visible is slice(-1)
  const visible = hist.slice(-1);
  const v = visible[0] || null;
  const nextKey = v ? v.id + ":t" : null;
  const nextText = v ? v.t : "";
  if (historyKey && historyKey !== nextKey) {
    anims.push({ time: nowMs, kind: "exit_up", key: historyKey, text: historyText });
    log("anim_exit", { key: historyKey, text: historyText });
  }
  if (nextKey && nextKey !== historyKey) {
    anims.push({ time: nowMs, kind: "enter_up", key: nextKey, text: nextText });
    log("anim_enter", { key: nextKey, text: nextText });
  }
  historyKey = nextKey;
  historyText = nextText;
  log("render", { histTop: nextText, curT });
}

function commit() {
  if (!curO && !curT) return;
  const id = nextHistoryId++;
  const text = curT;
  hist.push({ id, o: curO, t: curT });
  curO = curT = "";
  log("commit", { id, text, commitTime: nowMs });
}
function appendMerged(text) {
  curT += text;
  log("append_merged", { curT, hasTerminal: hasTerminal(curT) });
  emitRender();
}
function requestCut(after) {
  pendingSentenceCutReady = false;
  pendingSentenceCutAction = after || pendingSentenceCutAction;
  const delay = Math.max(0, sentenceBoundaryTime + MIN_SENTENCE_CUT_DELAY_MS - nowMs);
  log("schedule_cut", { delay, hasAction: Boolean(after) });
  if (pendingSentenceCutTimer) clearFakeTimeout(pendingSentenceCutTimer);
  pendingSentenceCutTimer = setFakeTimeout(() => {
    pendingSentenceCutTimer = null;
    const action = pendingSentenceCutAction;
    pendingSentenceCutAction = null;
    if (!action) { pendingSentenceCutReady = true; return; }
    log("execute_cut", {});
    commit();
    action();
  }, delay);
}
function queueShortTail(tail) {
  if (pendingShortTail?.timer) clearFakeTimeout(pendingShortTail.timer);
  const delay = shortTailMs();
  log("queue_short_tail", { tail, delay });
  const timer = setFakeTimeout(() => {
    pendingShortTail = null;
    requestCut(() => process(tail));
  }, delay);
  pendingShortTail = { tail, timer };
}
function process(text) {
  if (!text) return;
  if (pendingShortTail) {
    const p = pendingShortTail;
    if (p.timer) clearFakeTimeout(p.timer);
    pendingShortTail = null;
    log("merge_short_tail", { tail: p.tail, next: text });
    requestCut(() => appendMerged(p.tail + text));
    return;
  }
  if (pendingSentenceCutTimer) {
    const prev = pendingSentenceCutAction;
    pendingSentenceCutAction = () => { prev?.(); process(text); };
    return;
  }
  if (pendingSentenceCutReady) {
    const delay = Math.max(0, sentenceBoundaryTime + MIN_SENTENCE_CUT_DELAY_MS - nowMs);
    if (delay > 0) { pendingSentenceCutReady = false; requestCut(() => process(text)); return; }
    pendingSentenceCutReady = false;
    commit();
    process(text);
    return;
  }
  const bi = findBreak(text);
  if (bi < 0) {
    curT += text;
    log("append", { curT });
    emitRender();
    return;
  }
  const end = extendBreak(text, bi);
  const head = text.slice(0, end + 1);
  const tail = text.slice(end + 1);
  curT += head;
  sentenceBoundaryTime = nowMs;
  log("break", { head, tail, curT });
  emitRender();
  if (!tail) {
    if (charLen(curT) < MIN_PACKET_TAIL_CHARS) return;
    requestCut();
    return;
  }
  if (charLen(tail) >= MIN_PACKET_TAIL_CHARS) {
    requestCut(() => process(tail));
    return;
  }
  queueShortTail(tail);
}
function appendT(text) { track(); process(text); }

// Seed like user log
hist = [{ id: 3, o: "hellohello", t: "prev-history-line" }];
nextHistoryId = 4;
curT = "继续需要";
for (let i = 0; i < 12; i++) translationPacketTimes.push(-(12 - i) * 824);
emitRender();
const baseAnim = anims.length;

const steps = [
  [655, () => appendT("我们重复")],
  [1487, () => appendT("字幕上浮、但是")],
  [2237, () => appendT("显示显示问题。")],
  [2719, () => appendT("字幕现在字幕：然后")],
  [2781, () => appendT("动画确认")],
  [3445, () => appendT("如果观察记录")],
];
let prev = 0;
for (const [at, fn] of steps) { advance(at - prev); prev = at; fn(); }
advance(2000);

const commits = events.filter((e) => e.type === "commit");
const after = anims.slice(baseAnim);
const enters = after.filter((a) => a.kind === "enter_up");
const exits = after.filter((a) => a.kind === "exit_up");

console.log("COMMITS:");
for (const c of commits) console.log("  time=" + c.commitTime + " id=" + c.id + " text=" + c.text);

console.log("ANIMS after baseline:");
for (const a of after) console.log("  time=" + a.time + " " + a.kind + " text=" + a.text);

// S1: each commit with prior history produces exit_up + enter_up at same time
let s1 = false;
for (const c of commits) {
  const near = after.filter((a) => a.time === c.commitTime);
  const hasExit = near.some((a) => a.kind === "exit_up");
  const hasEnter = near.some((a) => a.kind === "enter_up");
  const dual = hasExit && hasEnter;
  console.log("S1 commit id=" + c.id + " time=" + c.commitTime + " dual_up=" + dual + " anims=" + near.map((a) => a.kind).join("+"));
  if (dual) s1 = true;
}

// S2: two commits within 1000ms
let s2 = false;
for (let i = 1; i < commits.length; i++) {
  const gap = commits[i].commitTime - commits[i - 1].commitTime;
  console.log("S2 gap id" + commits[i - 1].id + "->id" + commits[i].id + " = " + gap + "ms");
  if (gap < 1000) s2 = true;
}

// S4: merged current ends with terminal punct but no cut scheduled for it
const merges = events.filter((e) => e.type === "append_merged");
let s4 = false;
for (const m of merges) {
  if (m.hasTerminal) {
    // After merge, is there a schedule_cut for THIS content before next break extends it?
    const laterBreak = events.find((e) => e.type === "break" && e.time > m.time);
    if (laterBreak && laterBreak.curT.startsWith(m.curT) && laterBreak.curT.length > m.curT.length) {
      s4 = true;
      console.log("S4 merged terminal swallowed: merged=" + m.curT + " later_break_cur=" + laterBreak.curT);
    }
  }
}

// Content-focused: phrase appears in current then later in a different history enter
const phrase = "但是显示显示问题";
const phraseInCommit = commits.filter((c) => c.text.includes(phrase));
console.log("Commits containing phrase:", phraseInCommit.map((c) => ({ id: c.id, time: c.commitTime, text: c.text })));
const phraseEnters = enters.filter((a) => a.text.includes(phrase));
console.log("History enters containing phrase:", phraseEnters.map((a) => ({ time: a.time, text: a.text })));

// Count upward anims in window from first merge of phrase to phrase commit
const firstMerge = merges.find((m) => m.curT.includes(phrase));
const phraseCommit = commits.find((c) => c.text.includes(phrase));
if (firstMerge && phraseCommit) {
  const windowAnims = after.filter((a) => a.time >= firstMerge.time && a.time <= phraseCommit.time);
  console.log("Upward anims from phrase-as-current to phrase-as-history:");
  for (const a of windowAnims) console.log("  time=" + a.time + " " + a.kind + " text=" + a.text);
  console.log("count=" + windowAnims.length);
}

console.log("\nVERDICT");
console.log("S1 dual exit+enter per commit:", s1 ? "RED" : "GREEN");
console.log("S2 rapid commits <1000ms:", s2 ? "RED" : "GREEN");
console.log("S4 merge skips terminal re-break:", s4 ? "RED" : "GREEN");

// User symptom "两次上浮" — red if dual simultaneous up motion OR 2+ enter_up in the phrase window
const phraseWindowEnters = firstMerge && phraseCommit
  ? after.filter((a) => a.kind === "enter_up" && a.time >= firstMerge.time - 5 && a.time <= phraseCommit.time + 5)
  : [];
// Also include the enter at the same moment phrase becomes current (previous sentence float)
const atPhraseAppear = firstMerge
  ? after.filter((a) => a.time === firstMerge.time && (a.kind === "enter_up" || a.kind === "exit_up"))
  : [];
console.log("At phrase appear (time=" + (firstMerge && firstMerge.time) + "):", atPhraseAppear);
console.log("Phrase window enters:", phraseWindowEnters);

const red = s1 || s2 || s4 || atPhraseAppear.length >= 2;
console.log(red ? "RESULT: RED" : "RESULT: GREEN");
process.exit(red ? 1 : 0);
