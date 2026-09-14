import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadSettings } from "./subtitle-settings-shared";
import { SentenceCutEngine } from "./sentence-cut-engine";
import { SubtitleHistoryAlignment } from "./subtitle-history-alignment";
import {
  addRecord,
  bindPendingRecords,
  createArchive,
  createQuickRecord,
  createSession as createStoredSession,
  deleteRecord,
  isSessionEmpty,
  mergeSessions,
  parseArchive,
  removeSessions,
  replaceSessionSentences,
  serializeArchive,
  toggleSentenceMark,
  updateNote,
  upsertSession,
  type QuickRecordKind,
  type QuickRecord,
  type SessionArchive,
} from "./quick-records";
import { applyAlignmentEdits, buildSentenceUnits, parseAlignmentEdits, type AlignedLine, type AlignmentEdit } from "./alignment-edits";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MINIMIZE_TIP_KEY = "mt-hide-taskbar-minimize-tip";
const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const DEFAULT_SUMMARY_MODEL = "gemini-3.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_WS_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
type BaseFormat = "openai" | "aistudio";
const MIN_COMMA_BREAK_CHARS = 5;
const MIN_PACKET_TAIL_CHARS = 4;
const MIN_SENTENCE_CUT_CHARS = 4;
const MIN_SENTENCE_CUT_DELAY_MS = 500;
const SPEECH_INTERVAL_WINDOW_MS = 30_000;
const DEFAULT_SHORT_TAIL_TIMEOUT_MS = 1_000;
const LOG_AUTO_SCROLL_THRESHOLD = 24;

// ── Window controls ──────────────────────────────────────────────────────────
async function minimizeToTaskbar() {
  await invoke("hide_main_window");
}

async function showMinimizeNotification() {
  await invoke("show_taskbar_minimize_notification");
}

$("btn-taskbar-min").onclick = async (e) => {
  e.stopPropagation();
  await minimizeToTaskbar();
  if (trayTipChk.checked) await showMinimizeNotification();
};
$("btn-min").onclick = async (e) => { e.stopPropagation(); await win.minimize(); };
$("btn-close").onclick = async (e) => {
  e.stopPropagation();
  await invoke("exit_app");
};
void win.onCloseRequested(async (event) => {
  event.preventDefault();
  await invoke("exit_app");
});
$("btn-subtitle").onclick = async (e) => {
  e.stopPropagation();
  if (subtitleVisible) {
    await invoke("hide_subtitle_window");
  } else {
    await invoke("show_subtitle_window");
  }
};
void listen("taskbar-minimize-tip-never", () => {
  trayTipChk.checked = false;
  saveCfg();
  localStorage.setItem(MINIMIZE_TIP_KEY, "1");
});

// ── DOM refs ─────────────────────────────────────────────────────────────────
const apiEntry     = $<HTMLInputElement>("api-entry");
const baseUrlEntry = $<HTMLInputElement>("base-url-entry");
const baseUrlHint  = $<HTMLElement>("base-url-hint");
const formatSegment = $<HTMLElement>("format-segment");
const formatButtons = Array.from(formatSegment.querySelectorAll<HTMLButtonElement>("[data-format]"));
const proxyEntry   = $<HTMLInputElement>("proxy-entry");
const modelEntry   = $<HTMLInputElement>("model-entry");
const summaryModelEntry = $<HTMLInputElement>("summary-model-entry");
const summaryBaseUrlEntry = $<HTMLInputElement>("summary-base-url-entry");
const summaryBaseUrlHint = $<HTMLElement>("summary-base-url-hint");
const summaryUrlSegment = $<HTMLElement>("summary-url-segment");
const summaryUrlButtons = Array.from(summaryUrlSegment.querySelectorAll<HTMLButtonElement>("[data-summary-url]"));
const summaryKeyEntry = $<HTMLInputElement>("summary-key-entry");
const summaryKeyHint = $<HTMLElement>("summary-key-hint");
const summaryKeySegment = $<HTMLElement>("summary-key-segment");
const summaryKeyButtons = Array.from(summaryKeySegment.querySelectorAll<HTMLButtonElement>("[data-summary-key]"));
const chineseMode  = $<HTMLSelectElement>("chinese-mode");
const deviceCombo  = $<HTMLSelectElement>("device-combo");
const voiceChk     = $<HTMLInputElement>("voice");
const trayTipChk   = $<HTMLInputElement>("tray-tip");
const detailedLogChk = $<HTMLInputElement>("detailed-log");
const refreshBtn = $<HTMLButtonElement>("refresh-btn");
const startBtn     = $<HTMLButtonElement>("start-btn");
const stopBtn      = $<HTMLButtonElement>("stop-btn");
const testStreamBtn = $<HTMLButtonElement>("test-stream-btn");
const historyBtn   = $<HTMLButtonElement>("history-btn");
const statusText   = $<HTMLElement>("status-text");
const statusDot    = $<HTMLElement>("status-dot");
const logBox       = $<HTMLDivElement>("log-box");
type AudioDevice = { id: string; name: string; kind: "input" | "output" };
let audioDevices: AudioDevice[] = [];

voiceChk.onchange = saveCfg;
chineseMode.onchange = saveCfg;
summaryModelEntry.onchange = saveCfg;
summaryBaseUrlEntry.onchange = saveCfg;
summaryUrlSegment.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-summary-url]");
  if (!button || button.disabled) return;
  summaryUrlButtons.forEach((item) => item.classList.toggle("active", item === button));
  updateSummaryBaseUrlUi();
  saveCfg();
});
summaryKeyEntry.onchange = saveCfg;
summaryKeySegment.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-summary-key]");
  if (!button || button.disabled) return;
  summaryKeyButtons.forEach((item) => item.classList.toggle("active", item === button));
  updateSummaryKeyUi();
  saveCfg();
});
trayTipChk.onchange = () => {
  if (trayTipChk.checked) {
    localStorage.removeItem(MINIMIZE_TIP_KEY);
  } else {
    localStorage.setItem(MINIMIZE_TIP_KEY, "1");
  }
  saveCfg();
};
detailedLogChk.onchange = () => { saveCfg(); updateTestStreamVisibility(); };
historyBtn.onclick = async (e) => {
  e.stopPropagation();
  try {
    await invoke("show_subtitle_history");
    emitToOverlay();
    emitHistoryToWindow();
  } catch (err) {
    addLog(`历史字幕窗口打开失败：${err}`, "err");
  }
};
logBox.addEventListener("scroll", () => {
  logAutoScroll = isLogNearBottom();
});

// ── Toggle key visibility ────────────────────────────────────────────────────
let keyVis = false;
$("toggle-key").onclick = (e) => {
  e.stopPropagation();
  keyVis = !keyVis;
  apiEntry.type = keyVis ? "text" : "password";
  $("eye-open").classList.toggle("hidden", keyVis);
  $("eye-closed").classList.toggle("hidden", !keyVis);
};

let summaryKeyVis = false;
$("toggle-summary-key").onclick = (e) => {
  e.stopPropagation();
  summaryKeyVis = !summaryKeyVis;
  summaryKeyEntry.type = summaryKeyVis ? "text" : "password";
  $("summary-eye-open").classList.toggle("hidden", summaryKeyVis);
  $("summary-eye-closed").classList.toggle("hidden", !summaryKeyVis);
};

// ── Presets ──────────────────────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>(".preset:not(.summary-preset)").forEach((b) =>
  b.onclick = () => { modelEntry.value = b.dataset.m || ""; });
document.querySelectorAll<HTMLButtonElement>(".summary-preset").forEach((b) =>
  b.onclick = () => { summaryModelEntry.value = b.dataset.sm || ""; saveCfg(); });

// ── Refresh devices ──────────────────────────────────────────────────────────
refreshBtn.onclick = refreshDevices;

function updateTestStreamVisibility() {
  testStreamBtn.classList.toggle("hidden", !detailedLogChk.checked);
}

async function refreshDevices() {
  refreshBtn.classList.add("is-refreshing");
  refreshBtn.disabled = true;
  try {
    const [d, defaultId] = await invoke<[AudioDevice[], string]>("get_audio_devices");
    const prev = deviceCombo.value;
    audioDevices = d;
    deviceCombo.innerHTML = "";
    d.forEach((device) => {
      const o = document.createElement("option");
      o.value = device.id;
      o.textContent = `${device.kind === "input" ? "音频输入" : "系统音频"}：${device.name}`;
      deviceCombo.appendChild(o);
    });
    // Restore previous selection, or select system default
    if (prev && d.some((device) => device.id === prev)) {
      deviceCombo.value = prev;
    } else if (defaultId && d.some((device) => device.id === defaultId)) {
      deviceCombo.value = defaultId;
    }
  } catch (e) {
    console.error(e);
  } finally {
    refreshBtn.classList.remove("is-refreshing");
    refreshBtn.disabled = false;
  }
}

// ── Settings persistence ─────────────────────────────────────────────────────
const SK = "mt-cfg";
function loadCfg() {
  try { const s = localStorage.getItem(SK); if (s) return JSON.parse(s); } catch {}
  return { k: "", b: "", p: "", m: DEFAULT_MODEL, sm: DEFAULT_SUMMARY_MODEL, cm: "auto", v: true, d: "", tt: true, dl: false, bf: "openai", sb: "", sum: "same", sk: "", skm: "same" };
}
function saveCfg() {
  localStorage.setItem(SK, JSON.stringify({
    k: apiEntry.value, b: baseUrlEntry.value, p: proxyEntry.value, m: modelEntry.value, sm: summaryModelEntry.value, cm: chineseMode.value,
    v: voiceChk.checked, d: deviceCombo.value, tt: trayTipChk.checked, dl: detailedLogChk.checked, bf: baseFormat(),
    sb: summaryBaseUrlEntry.value, sum: summaryUrlMode(), sk: summaryKeyEntry.value, skm: summaryKeyMode()
  }));
}

function baseFormat(): BaseFormat {
  return formatSegment.querySelector<HTMLButtonElement>(".format-segment-option.active")?.dataset.format === "aistudio" ? "aistudio" : "openai";
}

function setBaseFormat(format: BaseFormat) {
  formatButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.format === format);
  });
  updateBaseFormatUi();
}

function defaultBaseUrl() {
  return DEFAULT_BASE_URL;
}

function updateSummaryBaseUrlUi() {
  summaryBaseUrlEntry.disabled = summaryUrlMode() !== "custom";
  summaryBaseUrlEntry.placeholder = summaryUrlMode() === "custom" ? "https://api.openai.com/v1" : DEFAULT_BASE_URL;
  summaryBaseUrlHint.textContent =
    summaryUrlMode() === "custom"
      ? "使用 OpenAI 格式（/v1/chat/completions），留空使用 OpenAI 官方服务。"
      : "与上方 Base URL 使用同一地址。";
}

function summaryUrlMode(): "same" | "custom" {
  return summaryUrlSegment.querySelector<HTMLButtonElement>(".format-segment-option.active")?.dataset.summaryUrl === "custom" ? "custom" : "same";
}

function setSummaryUrlMode(mode: "same" | "custom") {
  summaryUrlButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.summaryUrl === mode);
  });
  updateSummaryBaseUrlUi();
}

// 总结模型独立 Base URL；同一 URL 时与上方 Base URL 使用同一地址。
function resolveAiBaseUrl() {
  return summaryUrlMode() === "custom" ? summaryBaseUrlEntry.value : baseUrlEntry.value;
}

function updateSummaryKeyUi() {
  summaryKeyEntry.disabled = summaryKeyMode() !== "custom";
  summaryKeyHint.textContent =
    summaryKeyMode() === "custom"
      ? "自定义模式为总结模型使用独立密钥，与上方 Gemini API 密钥无关。"
      : "与上方 Gemini API 密钥使用同一密钥。";
}

function summaryKeyMode(): "same" | "custom" {
  return summaryKeySegment.querySelector<HTMLButtonElement>(".format-segment-option.active")?.dataset.summaryKey === "custom" ? "custom" : "same";
}

function setSummaryKeyMode(mode: "same" | "custom") {
  summaryKeyButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.summaryKey === mode);
  });
  updateSummaryKeyUi();
}

// 总结模型独立 API 密钥；同一 Key 时与上方密钥一致。
function resolveAiKey() {
  return summaryKeyMode() === "custom" ? summaryKeyEntry.value.trim() : apiEntry.value.trim();
}

function updateBaseFormatUi() {
  const isAiStudio = baseFormat() === "aistudio";
  baseUrlEntry.placeholder = DEFAULT_BASE_URL;
  baseUrlHint.textContent = `留空会使用官方服务；自定义服务应支持 ${isAiStudio ? "Google AI Studio" : "OpenAI"} 格式。`;
}
formatSegment.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-format]");
  if (!button || button.disabled) return;
  formatButtons.forEach((item) => item.classList.toggle("active", item === button));
  updateBaseFormatUi();
  saveCfg();
});

// ── State ────────────────────────────────────────────────────────────────────
let running = false;
let geminiConnected = false;
let subtitleVisible = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let logAutoScroll = true;
let testStreamTimer: ReturnType<typeof setTimeout> | null = null;
let testStreamBurstTimers: ReturnType<typeof setTimeout>[] = [];
let testStreamRunning = false;
type SummaryPageItem =
  | { kind: "marker"; time: string; sessionId?: string }
  | { kind: "summary"; time: string; text: string; sessionId?: string }
  | { kind: "qa"; time: string; question: string; answer: string; sessionId?: string };
let summaryPageItems: SummaryPageItem[] = [];
let summarySessionStarted = false;
let aiRequestRunning = false;
let aiAlignmentRunning = false;
let alignmentCancelRequested = false;
let activeAlignmentRequestId: string | null = null;
let summaryPageStatus = "";
let summaryPageStatusKind: "idle" | "running" | "error" = "idle";
let summaryBusyAction: "summary" | "qa" | null = null;
let sessionArchive: SessionArchive = createArchive();
let activeSessionId = "";
let historySelectedSessionId = "";
let historyEventRevision = 0;
let archiveSaveChain = Promise.resolve();
type RecordWindowState = {
  mode: "note" | "details";
  sessionId: string;
  sentenceId: number | null;
  sentenceText: string;
  records: QuickRecord[];
  readOnly: boolean;
  marked: boolean;
};
let recordWindowState: RecordWindowState = {
  mode: "note",
  sessionId: "",
  sentenceId: null,
  sentenceText: "",
  records: [],
  readOnly: true,
  marked: false,
};

const sentenceEngine = new SentenceCutEngine({
  minCommaBreakChars: MIN_COMMA_BREAK_CHARS,
  minPacketTailChars: MIN_PACKET_TAIL_CHARS,
  minSentenceCutChars: MIN_SENTENCE_CUT_CHARS,
  minSentenceCutDelayMs: MIN_SENTENCE_CUT_DELAY_MS,
  speechIntervalWindowMs: SPEECH_INTERVAL_WINDOW_MS,
  defaultShortTailTimeoutMs: DEFAULT_SHORT_TAIL_TIMEOUT_MS,
  sentenceBreaksEnabled: () => loadSettings().historyRows > 0,
  onChange: () => render(),
  onDebug: (message) => debugSentence(message),
});

const historyAlignment = new SubtitleHistoryAlignment({
  maxHistory: Number.MAX_SAFE_INTEGER,
  onChange: () => syncActiveSession(),
});

async function loadSessionState() {
  try {
    const raw = await invoke<string>("load_session_archive");
    sessionArchive = parseArchive(raw);
  } catch (error) {
    addLog(`历史记录加载失败：${error}`, "err");
    sessionArchive = createArchive();
  }

  const latest = sessionArchive.sessions[sessionArchive.sessions.length - 1];
  if (!latest) return;
  activeSessionId = latest.id;
  historySelectedSessionId = latest.id;
  historyAlignment.replaceHistory(latest.sentences);
}

function getSession(sessionId: string) {
  return sessionArchive.sessions.find((session) => session.id === sessionId);
}

function getActiveSession() {
  return getSession(activeSessionId);
}

function persistSessionArchive() {
  const payload = serializeArchive(sessionArchive);
  archiveSaveChain = archiveSaveChain
    .catch(() => {})
    .then(async () => { await invoke("save_session_archive", { archive: payload }); })
    .catch((error) => addLog(`历史记录保存失败：${error}`, "err"));
}

function syncActiveSession() {
  const session = getActiveSession();
  if (!session) {
    emitHistoryToWindow();
    return;
  }

  const snapshot = historyAlignment.snapshot();
  const previousIds = new Set(session.sentences.map((sentence) => sentence.id));
  const pending = snapshot.curId === null
    ? []
    : [{ id: snapshot.curId, o: snapshot.curO, t: snapshot.curT }];
  let nextSession = replaceSessionSentences(session, snapshot.history, pending);
  const newSentence = snapshot.history.find((sentence) => !previousIds.has(sentence.id));
  if (newSentence) nextSession = bindPendingRecords(nextSession, newSentence.id);
  sessionArchive = upsertSession(sessionArchive, nextSession);
  persistSessionArchive();
  emitHistoryToWindow();
}

function createActiveSession() {
  const session = createStoredSession();
  sessionArchive = upsertSession(sessionArchive, session);
  activeSessionId = session.id;
  historySelectedSessionId = session.id;
  persistSessionArchive();
}

function sessionSummaries() {
  return sessionArchive.sessions
    .map((session) => ({
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt || null,
      sentenceCount: session.sentences.length,
      recordCount: session.records.length,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function emitHistoryToWindow() {
  const revision = ++historyEventRevision;
  const selected = getSession(historySelectedSessionId) || getActiveSession();
  if (!selected) {
    emit("subtitle-history-sessions", { sessions: [], selectedSessionId: "", revision });
    emit("subtitle-history-update", {
      history: [],
      curO: "",
      curT: "",
      sessionId: "",
      readOnly: true,
      liveRunning: running || testStreamRunning,
      aiAlignmentRunning,
      records: [],
      revision,
    });
    return;
  }

  const isActive = selected.id === activeSessionId;
  const snapshot = isActive
    ? historyAlignment.snapshot()
    : { history: selected.sentences, curO: "", curT: "", curId: null };
  emit("subtitle-history-sessions", { sessions: sessionSummaries(), selectedSessionId: selected.id, revision });
  emit("subtitle-history-update", {
    history: snapshot.history,
    curO: snapshot.curO,
    curT: snapshot.curT,
    curId: snapshot.curId,
    sessionId: selected.id,
    readOnly: !isActive,
    liveRunning: running || testStreamRunning,
    aiAlignmentRunning,
    records: selected.records,
    markedSentenceIds: selected.markedSentenceIds,
    editedIds: snapshot.history.filter((line) => line.edited).map((line) => line.id),
    startedAt: selected.startedAt,
    revision,
  });
}

function emitHistoryLiveState() {
  emit("subtitle-history-live-state", { running: running || testStreamRunning });
}

function emitQuickRecordError(message: string) {
  emit("quick-record-error", { message });
}

function emitHistoryEditError() {
  emit("subtitle-history-edit-error", { message: "AI 对齐进行中，暂时不能编辑" });
}

function emitQuickRecordResult(kind: string, success: boolean, message?: string, marked?: boolean) {
  emit("quick-record-result", { kind, success, message, marked });
}

function emitQuickRecordWindowState() {
  emit("quick-record-window-state", {
    ...recordWindowState,
    readOnly: recordWindowState.readOnly || aiAlignmentRunning,
  });
}

async function showQuickRecordWindow(state: RecordWindowState) {
  recordWindowState = state;
  await invoke("show_quick_record_window");
  emitQuickRecordWindowState();
}

function addQuickRecord(kind: QuickRecordKind, text = "", sentenceId: number | null = null, sessionId = activeSessionId) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    emitQuickRecordError("当前没有可记录的内容");
    emitQuickRecordResult(kind, false, "当前没有可记录的内容");
    return;
  }
  if (sessionId !== activeSessionId && running) {
    emitQuickRecordError("历史记录只读");
    emitQuickRecordResult(kind, false, "历史记录只读");
    return;
  }
  if (kind === "note" && !text.trim()) return;
  if (sentenceId !== null && !session.sentences.some((sentence) => sentence.id === sentenceId)) {
    emitQuickRecordError("找不到对应字幕句");
    emitQuickRecordResult(kind, false, "找不到对应字幕句");
    return;
  }
  const record = createQuickRecord(kind, { text, sentenceId });
  sessionArchive = upsertSession(sessionArchive, addRecord(session, record));
  persistSessionArchive();
  emitHistoryToWindow();
  if (recordWindowState.sessionId === sessionId && recordWindowState.sentenceId === sentenceId) {
    recordWindowState = {
      ...recordWindowState,
      records: getSession(sessionId)?.records.filter((item) => item.status === "anchored" && item.sentenceId === sentenceId) || [],
    };
    emitQuickRecordWindowState();
  }
  emitQuickRecordResult(kind, true);
}

function toggleHistoryMark(sessionId: string, sentenceId: number) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    emitQuickRecordError("当前没有可记录的内容");
    emitQuickRecordResult("marker", false, "当前没有可记录的内容");
    return;
  }
  if (sessionId !== activeSessionId && running) {
    emitQuickRecordError("历史记录只读");
    emitQuickRecordResult("marker", false, "历史记录只读");
    return;
  }
  if (!session.sentences.some((sentence) => sentence.id === sentenceId)) {
    emitQuickRecordError("找不到对应字幕句");
    emitQuickRecordResult("marker", false, "找不到对应字幕句");
    return;
  }
  sessionArchive = upsertSession(sessionArchive, toggleSentenceMark(session, sentenceId));
  persistSessionArchive();
  emitHistoryToWindow();
  const marked = getSession(sessionId)?.markedSentenceIds.includes(sentenceId) ?? false;
  if (recordWindowState.sessionId === sessionId && recordWindowState.sentenceId === sentenceId) {
    recordWindowState = { ...recordWindowState, marked };
    emitQuickRecordWindowState();
  }
  emitQuickRecordResult("marker", true, undefined, marked);
}

function updateQuickNote(sessionId: string, recordId: string, text: string) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  const session = getSession(sessionId);
  if (!session || sessionId !== activeSessionId && running) return;
  sessionArchive = upsertSession(sessionArchive, updateNote(session, recordId, text));
  persistSessionArchive();
  emitHistoryToWindow();
  refreshQuickRecordWindowState(sessionId);
}

function deleteQuickRecord(sessionId: string, recordId: string) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  const session = getSession(sessionId);
  if (!session || sessionId !== activeSessionId && running) return;
  sessionArchive = upsertSession(sessionArchive, deleteRecord(session, recordId));
  persistSessionArchive();
  emitHistoryToWindow();
  refreshQuickRecordWindowState(sessionId);
}

function refreshQuickRecordWindowState(sessionId: string) {
  if (recordWindowState.sessionId !== sessionId || recordWindowState.sentenceId === null) return;
  const session = getSession(sessionId);
  recordWindowState = {
    ...recordWindowState,
    records: session?.records.filter((item) => item.status === "anchored" && item.sentenceId === recordWindowState.sentenceId) || [],
    marked: session?.markedSentenceIds.includes(recordWindowState.sentenceId) ?? false,
  };
  emitQuickRecordWindowState();
}

function deleteSessions(sessionIds: string[]) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  if (running && sessionIds.includes(activeSessionId)) {
    emitQuickRecordError("翻译进行中，当前记录不能删除");
    return;
  }
  sessionArchive = removeSessions(sessionArchive, sessionIds);
  if (sessionIds.includes(activeSessionId)) {
    const replacement = sessionArchive.sessions[sessionArchive.sessions.length - 1];
    activeSessionId = replacement?.id || "";
    historySelectedSessionId = activeSessionId;
    if (replacement) historyAlignment.replaceHistory(replacement.sentences);
    else historyAlignment.reset();
  }
  if (!getSession(historySelectedSessionId)) historySelectedSessionId = activeSessionId;
  persistSessionArchive();
  emitHistoryToWindow();
}

function mergeSelectedSessions(sessionIds: string[]) {
  if (sessionIds.length < 2) return;
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  if (running && sessionIds.includes(activeSessionId)) {
    emitQuickRecordError("翻译进行中，当前记录不能合并");
    return;
  }
  const selected = sessionIds.flatMap((id) => {
    const session = getSession(id);
    return session ? [session] : [];
  });
  if (selected.length < 2) return;
  const merged = mergeSessions(selected);
  sessionArchive = upsertSession(removeSessions(sessionArchive, sessionIds), merged);
  const mergedActiveSession = sessionIds.includes(activeSessionId);
  if (mergedActiveSession) activeSessionId = merged.id;
  historySelectedSessionId = merged.id;
  if (mergedActiveSession) historyAlignment.replaceHistory(merged.sentences);
  persistSessionArchive();
  emitHistoryToWindow();
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const c = loadCfg();
  if (c.k) apiEntry.value = c.k;
  if (c.b) baseUrlEntry.value = c.b;
  if (c.p) proxyEntry.value = c.p;
  modelEntry.value = c.m || DEFAULT_MODEL;
  summaryModelEntry.value = c.sm || DEFAULT_SUMMARY_MODEL;
  summaryBaseUrlEntry.value = c.sb || "";
  setSummaryUrlMode(c.sum === "custom" || c.sus === true ? "custom" : "same");
  summaryKeyEntry.value = c.sk || "";
  setSummaryKeyMode(c.skm === "custom" ? "custom" : "same");
  chineseMode.value = normalizeChineseMode(c.cm);
  voiceChk.checked = c.v;
  trayTipChk.checked = c.tt !== false && localStorage.getItem(MINIMIZE_TIP_KEY) !== "1";
  detailedLogChk.checked = c.dl === true;
  updateTestStreamVisibility();
  setBaseFormat(c.bf === "aistudio" ? "aistudio" : "openai");
  await loadSessionState();
  await loadSummaryItems();
  await refreshDevices();
  if (c.d) {
    const savedDevice = audioDevices.find((device) => device.id === c.d || device.name === c.d);
    if (savedDevice) deviceCombo.value = savedDevice.id;
  }
  await listen<number[]>("audio-data", (e) => {
    if (geminiConnected) sendAudio(new Uint8Array(e.payload));
  });
  await listen<string>("gemini-log", (e) => addLog(e.payload));
  await listen<boolean>("subtitle-visibility-changed", (e) => {
    setSubtitleVisible(e.payload);
  });
  // The subtitle window can already be visible without a visibility event
  // (it is shown in the Rust app setup), so calibrate the button against
  // the real window state.
  try {
    const subtitleWindow = await WebviewWindow.getByLabel("subtitles");
    if (subtitleWindow) setSubtitleVisible(await subtitleWindow.isVisible());
  } catch { /* keep the initial hidden state */ }
  await listen<{ keepSubtitleWindow?: boolean }>("subtitle-record-toggle", async (event) => {
    if (running) await stop(Boolean(event.payload?.keepSubtitleWindow));
    else await start();
  });
  await listen("gemini-open", () => {
    addLog("WebSocket 已打开，正在发送初始化配置", "ok");
    setStatus("连接中，请稍等...", "warn");
    updateTitleRecordButton();
    sendSetup(modelEntry.value.trim() || DEFAULT_MODEL);
  });
  await listen<string>("gemini-message", (e) => {
    try {
      onMsg(JSON.parse(e.payload));
    } catch (err) {
      addLog(`消息解析失败：${err}`, "err");
      setStatus(`消息解析失败：${err}`, "err");
    }
  });
  await listen<string>("gemini-error", (e) => {
    addLog(`连接出错：${e.payload}`, "err");
    setStatus(`连接出错：${e.payload}`, "err");
  });
  await listen("gemini-close", () => {
    geminiConnected = false;
    addLog("连接已关闭", "warn");
    if (running) scheduleReconnect();
    else setStatus("连接已断开", "");
    updateTitleRecordButton();
  });
  await listen("subtitle-history-request", () => {
    emitToOverlay();
    emitHistoryToWindow();
  });
  await listen<{ snapshot?: { o?: string; t?: string } }>("quick-record-open-request", async (event) => {
    if (aiAlignmentRunning) {
      emitHistoryEditError();
      return;
    }
    const snapshot = event.payload.snapshot || { o: sentenceEngine.curO, t: sentenceEngine.curT };
    const sentenceText = [snapshot.t, snapshot.o].filter(Boolean).join("\n");
    if (!sentenceText) {
      emitQuickRecordError("当前没有字幕句子");
      return;
    }
    await showQuickRecordWindow({
      mode: "note",
      sessionId: activeSessionId,
      sentenceId: null,
      sentenceText,
      records: [],
      readOnly: false,
      marked: false,
    });
  });
  await listen("quick-record-window-request", () => emitQuickRecordWindowState());
  await listen<{ kind: string; sessionId?: string; sentenceId?: number | null; text?: string }>("quick-record-submit", async (event) => {
    if (aiAlignmentRunning) {
      emitHistoryEditError();
      return;
    }
    if (event.payload.kind === "marker") {
      if (event.payload.sentenceId === null || event.payload.sentenceId === undefined) return;
      toggleHistoryMark(event.payload.sessionId || activeSessionId, event.payload.sentenceId);
      if (recordWindowState.mode === "note") await invoke("hide_quick_record_window").catch(() => {});
      return;
    }
    addQuickRecord(
      "note",
      event.payload.text || "",
      event.payload.sentenceId ?? null,
      event.payload.sessionId || activeSessionId,
    );
    if (recordWindowState.mode === "note") await invoke("hide_quick_record_window").catch(() => {});
  });
  await listen<{ sessionId: string; recordId: string; text: string }>("quick-record-update", (event) => {
    updateQuickNote(event.payload.sessionId, event.payload.recordId, event.payload.text);
  });
  await listen<{ sessionId: string; recordId: string }>("quick-record-delete", (event) => {
    deleteQuickRecord(event.payload.sessionId, event.payload.recordId);
  });
  await listen<{ kind: string; text?: string; snapshot?: { o?: string; t?: string } }>("quick-record-request", (event) => {
    if (aiAlignmentRunning) {
      emitHistoryEditError();
      return;
    }
    const hasCurrent = Boolean(
      sentenceEngine.curO || sentenceEngine.curT || event.payload.snapshot?.o || event.payload.snapshot?.t,
    );
    if (!hasCurrent) {
      emitQuickRecordError("当前没有字幕句子");
      emitQuickRecordResult(event.payload.kind, false, "当前没有字幕句子");
      return;
    }
    if (event.payload.kind === "marker") {
      const snapshot = historyAlignment.snapshot();
      const sentenceId = snapshot.curId ?? (snapshot.history.length ? snapshot.history[snapshot.history.length - 1].id : undefined);
      if (sentenceId === undefined) {
        emitQuickRecordError("当前没有字幕句子");
        emitQuickRecordResult("marker", false, "当前没有字幕句子");
        return;
      }
      syncActiveSession();
      toggleHistoryMark(activeSessionId, sentenceId);
      return;
    }
    addQuickRecord("note", event.payload.text || "");
  });
  await listen<{ kind: string; sessionId: string; sentenceId: number; text?: string }>("subtitle-history-record-request", (event) => {
    if (event.payload.kind === "marker") {
      toggleHistoryMark(event.payload.sessionId, event.payload.sentenceId);
      return;
    }
    addQuickRecord("note", event.payload.text || "", event.payload.sentenceId, event.payload.sessionId);
  });
  await listen<{ requestId: string; sessionId: string; sentenceId: number; text: string }>("subtitle-history-record-optimize", (event) => {
    if (aiAlignmentRunning) {
      emitHistoryEditError();
      return;
    }
    void optimizeHistoryRecordWithAi(event.payload);
  });
  await listen<{ sessionId: string; recordId: string; text: string }>("subtitle-history-record-update", (event) => {
    updateQuickNote(event.payload.sessionId, event.payload.recordId, event.payload.text);
  });
  await listen<{ sessionId: string; recordId: string }>("subtitle-history-record-delete", (event) => {
    deleteQuickRecord(event.payload.sessionId, event.payload.recordId);
  });
  await listen<{ sessionId: string; items: Array<{ id: number; o: string; t: string }> }>("subtitle-history-sentence-edit", (event) => {
    if (aiAlignmentRunning) {
      emitHistoryEditError();
      return;
    }
    applySentenceChanges(event.payload.sessionId, event.payload.items || []);
  });
  await listen<{ sessionId: string; ids: number[] }>("subtitle-history-sentence-delete", (event) => {
    if (aiAlignmentRunning) {
      emitHistoryEditError();
      return;
    }
    deleteSentences(event.payload.sessionId, event.payload.ids || []);
  });
  await listen<{ sessionId: string }>("subtitle-history-session-select", (event) => {
    if (!getSession(event.payload.sessionId)) return;
    historySelectedSessionId = event.payload.sessionId;
    emitHistoryToWindow();
  });
  await listen<{ sessionIds: string[] }>("subtitle-history-session-delete", (event) => {
    deleteSessions(event.payload.sessionIds || []);
  });
  await listen<{ sessionIds: string[] }>("subtitle-history-session-merge", (event) => {
    mergeSelectedSessions(event.payload.sessionIds || []);
  });
  await listen<{ sessionId?: string }>("subtitle-history-ai-align", (event) => {
    void alignHistoryWithAi(event.payload?.sessionId);
  });
  await listen("subtitle-history-ai-align-cancel", () => {
    void cancelHistoryAiAlign();
  });
  await listen<{ sessionId?: string }>("subtitle-history-ai-summary", (event) => {
    void handleSummaryRequest(event.payload?.sessionId);
  });
  await listen("summary-page-request", () => emitSummaryState());
  await listen<{ question?: string }>("summary-ask-request", (event) => {
    void askHistoryWithAi(event.payload?.question);
  });
  await listen("summary-regenerate-request", () => {
    void summarizeHistoryWithAi();
  });
  await listen<{ text: string }>("current-line-readable", (e) => {
    sentenceEngine.onCurrentLineReadable(e.payload?.text || "");
  });
  render();
  emitSummaryState();
  updateTitleRecordButton();
}

// ── Start / Stop ─────────────────────────────────────────────────────────────
startBtn.onclick = start;
stopBtn.onclick = () => { void stop(); };
testStreamBtn.onclick = toggleTestStream;

async function start() {
  if (aiAlignmentRunning) {
    setStatus("AI 对齐进行中，请先停止对齐", "warn");
    return;
  }
  const key = apiEntry.value.trim();
  if (!key) { setStatus("请输入 API 密钥", "err"); flashStartError("缺少 API 密钥"); return; }
  try {
    buildWebSocketUrl(baseUrlEntry.value, key);
  } catch (e) {
    setStatus(String(e), "err");
    flashStartError("地址无效");
    return;
  }
  saveCfg();
  createActiveSession();
  beginSummarySession();
  clearLog();
  addLog("准备连接 Gemini");
  addLog(`Base URL：${baseUrlEntry.value.trim() || defaultBaseUrl()}`);
  addLog(`代理：${proxyEntry.value.trim() || "直连"}`);
  addLog(`模型：${modelEntry.value.trim() || DEFAULT_MODEL}`);
  addLog(`总结模型：${summaryModelEntry.value.trim() || DEFAULT_SUMMARY_MODEL}${summaryUrlMode() === "custom" ? `（独立地址：${summaryBaseUrlEntry.value.trim() || defaultBaseUrl()}）` : "（与上方同地址）"}${summaryKeyMode() === "custom" ? "，独立密钥" : "，与上方同密钥"}`);
  addLog(`字幕中文：${chineseModeLabel(chineseMode.value)} -> ${resolveTargetLanguageCode(chineseMode.value)}`);
  running = true;
  emitHistoryToWindow();
  emitHistoryLiveState();
  reconnectAttempt = 0;
  clearReconnectTimer();
  sentenceEngine.reset();
  historyAlignment.reset();
  startBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  apiEntry.disabled = baseUrlEntry.disabled = proxyEntry.disabled = modelEntry.disabled = summaryModelEntry.disabled = summaryBaseUrlEntry.disabled = summaryKeyEntry.disabled = chineseMode.disabled = deviceCombo.disabled = true;
  formatButtons.forEach((button) => { button.disabled = true; });
  summaryUrlButtons.forEach((button) => { button.disabled = true; });
  summaryKeyButtons.forEach((button) => { button.disabled = true; });
  render();
  setStatus("连接中，请稍等...", "warn");
  updateTitleRecordButton();

  try {
    addLog("正在建立 WebSocket 连接...");
    await connectGemini();
  } catch (e) {
    addLog(`连接失败：${e}`, "err");
    setStatus(`连接失败：${e}`, "err");
    flashStartError("连接失败");
    scheduleReconnect();
  }

  try {
    addLog("正在启动音频捕获...");
    await invoke("start_capture", { deviceId: deviceCombo.value });
    addLog("音频捕获已启动", "ok");
    if (!geminiConnected && !reconnectTimer) setStatus("连接中，请稍等...", "warn");
  } catch (e) {
    addLog(`音频启动失败：${e}`, "err");
    setStatus(`Audio: ${e}`, "err");
    flashStartError("音频失败");
    stop();
  }

  // Show subtitle overlay window
  try {
    await invoke("show_subtitle_window");
    updateTitleRecordButton();
  } catch (e) { console.error("subtitle window:", e); }
}

async function stop(keepSubtitleWindow = false) {
  running = false;
  stopTestStream();
  clearReconnectTimer();
  await invoke("gemini_disconnect").catch(() => {});
  geminiConnected = false;
  try { await invoke("stop_capture"); } catch {}
  historyAlignment.completeTurn();
  sentenceEngine.resetCurrent();
  const session = getActiveSession();
  if (session) {
    if (isSessionEmpty(session)) {
      sessionArchive = removeSessions(sessionArchive, [session.id]);
      const replacement = sessionArchive.sessions[sessionArchive.sessions.length - 1];
      activeSessionId = replacement?.id || "";
      historySelectedSessionId = activeSessionId;
      if (replacement) historyAlignment.replaceHistory(replacement.sentences);
      else historyAlignment.reset();
    } else if (!session.endedAt) {
      sessionArchive = upsertSession(sessionArchive, { ...session, endedAt: new Date().toISOString() });
    }
    persistSessionArchive();
  }
  emitHistoryToWindow();
  emitHistoryLiveState();
  emitToOverlay(true);
  stopBtn.classList.add("hidden");
  startBtn.classList.remove("hidden");
  apiEntry.disabled = baseUrlEntry.disabled = proxyEntry.disabled = modelEntry.disabled = summaryModelEntry.disabled = summaryBaseUrlEntry.disabled = summaryKeyEntry.disabled = chineseMode.disabled = deviceCombo.disabled = false;
  formatButtons.forEach((button) => { button.disabled = false; });
  summaryUrlButtons.forEach((button) => { button.disabled = false; });
  updateSummaryBaseUrlUi();
  summaryKeyButtons.forEach((button) => { button.disabled = false; });
  updateSummaryKeyUi();
  setStatus("连接已断开", "");
  updateTitleRecordButton();

  if (!keepSubtitleWindow) {
    try {
      await invoke("hide_subtitle_window");
    } catch {}
  }
}

function toggleTestStream() {
  if (testStreamRunning) {
    pauseTestStream();
  } else if (testStreamBtn.textContent === "随机字幕测试") {
    // First launch from the idle state: full start (show window, clear log).
    void startTestStream();
  } else {
    resumeTestStream();
  }
}

function resumeTestStream() {
  if (testStreamRunning) return;
  if (aiAlignmentRunning) {
    setStatus("AI 对齐进行中，请先停止对齐", "warn");
    return;
  }
  testStreamRunning = true;
  emitHistoryToWindow();
  emitHistoryLiveState();
  testStreamBtn.classList.add("active");
  testStreamBtn.textContent = "暂停随机字幕测试";
  scheduleTestChunk(0);
}

function pauseTestStream() {
  if (!testStreamRunning) return;
  if (testStreamTimer) clearTimeout(testStreamTimer);
  testStreamTimer = null;
  for (const timer of testStreamBurstTimers) clearTimeout(timer);
  testStreamBurstTimers = [];
  testStreamRunning = false;
  emitHistoryToWindow();
  emitHistoryLiveState();
  testStreamBtn.classList.remove("active");
  testStreamBtn.textContent = "继续随机字幕测试";
  // Drop unfinished fragments so a resumed stream never merges into them.
  sentenceEngine.resetCurrent();
  historyAlignment.resetCurrent();
}

async function startTestStream() {
  if (aiAlignmentRunning) {
    setStatus("AI 对齐进行中，请先停止对齐", "warn");
    return;
  }
  pauseTestStream();
  clearLog();
  testStreamRunning = true;
  emitHistoryToWindow();
  emitHistoryLiveState();
  testStreamBtn.classList.add("active");
  testStreamBtn.textContent = "暂停随机字幕测试";
  createActiveSession();
  beginSummarySession();
  sentenceEngine.reset();
  historyAlignment.reset();
  render();
  addLog("[随机测试] 开始：chunk 流式输出预制中英句子对，写入历史记录");
  try { await invoke("show_subtitle_window"); } catch (e) { console.error("subtitle window:", e); }
  scheduleTestChunk(0);
}

function stopTestStream() {
  pauseTestStream();
  testStreamTimer = null;
  testStreamBurstTimers = [];
  testStreamRunning = false;
  emitHistoryToWindow();
  emitHistoryLiveState();
  testStreamBtn.classList.remove("active");
  testStreamBtn.textContent = "随机字幕测试";
  sentenceEngine.clearPendingSentenceCut();
  sentenceEngine.clearPendingShortTail();
}

function scheduleTestChunk(delay: number) {
  testStreamTimer = setTimeout(() => {
    testStreamTimer = null;
    if (!testStreamRunning) return;
    if (Math.random() < 0.1) {
      runTestBurst();
      return;
    }
    emitTestSentencePair(() => {
      if (!testStreamRunning) return;
      scheduleTestChunk(randomTestInterval());
    });
  }, delay);
}

function runTestBurst() {
  const count = randomInt(2, 3);
  addDetailedLog(`[随机测试] burst count=${count}`, "warn");
  let sent = 0;
  const sendNext = () => {
    if (!testStreamRunning || sent >= count) {
      if (testStreamRunning) scheduleTestChunk(randomTestInterval());
      return;
    }
    sent++;
    emitTestSentencePair(() => {
      if (!testStreamRunning) return;
      const timer = setTimeout(sendNext, randomInt(200, 500));
      testStreamBurstTimers.push(timer);
    });
  };
  sendNext();
}

/**
 * Inter-sentence pause: feels like natural turns, longer than chunk gaps.
 */
function randomTestInterval() {
  const roll = Math.random();
  if (roll < 0.2) return randomInt(1500, 2500);
  if (roll < 0.7) return randomInt(2500, 4500);
  return randomInt(4500, 6500);
}

function emitTestMessage(message: { serverContent: unknown }) {
  const sc = message.serverContent as {
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
  };
  const input = sc.inputTranscription;
  const output = sc.outputTranscription;
  if (input?.text) addDetailedLog(`[随机测试] chunk EN="${input.text}"${input.finished ? " [终]" : ""}`);
  else if (output?.text) addDetailedLog(`[随机测试] chunk ZH="${output.text}"${output.finished ? " [终]" : ""}`);
  onMsg(message);
}

type TestSentencePair = { en: string[]; zh: string[] };

// Prebuilt bilingual pairs organized by sentence: each en/zh element is one
// sentence with exactly one terminal punctuation mark, and both sides always
// have the SAME sentence count, so sentence-by-sentence alignment holds.
const TEST_SENTENCE_PAIRS: TestSentencePair[] = [
  { en: ["Thanks everyone."], zh: ["谢谢大家。"] },
  { en: ["Let's get started."], zh: ["我们开始吧。"] },
  { en: ["I can hear you."], zh: ["我能听到你说话。"] },
  { en: ["Sorry, can you say that again?"], zh: ["不好意思，你能再说一遍吗？"] },
  { en: ["Let me check my notes for a second."], zh: ["我查一下笔记，稍等一下。"] },
  { en: ["The connection is a bit laggy today."], zh: ["今天网络有点卡。"] },
  { en: ["That's a great point, let's dig into it."], zh: ["这是个很好的观点，我们深入讨论一下。"] },
  { en: ["Can everyone see my screen now?"], zh: ["大家现在能看到我的屏幕吗？"] },
  { en: ["Please mute your microphone when you're not speaking."], zh: ["不说话的时候，请把麦克风静音。"] },
  { en: ["Did everyone review the document?", "We need your feedback by Friday."], zh: ["大家都看过这份文档了吗？", "周五前需要你们的反馈。"] },
  { en: ["I'm about to walk through the slides.", "Please stop me if anything is unclear."], zh: ["我准备过一下幻灯片。", "有不清楚的地方请随时打断我。"] },
  { en: ["Before we move on, let me summarize the key points.", "We'll send the details afterwards."], zh: ["在继续之前，我先总结一下要点。", "稍后会把详细内容发给大家。"] },
  { en: ["Could you please share your screen?", "I can't see the design you're referring to."], zh: ["你能共享一下屏幕吗？", "我看不到你提到的设计。"] },
  { en: ["The deadline is next Friday.", "Let's plan accordingly."], zh: ["截止日期是下周五。", "我们提前做好计划。"] },
  { en: ["I'll send the meeting notes after this call.", "They'll include all the action items."], zh: ["会议结束后我会把纪要发给大家。", "里面会包含所有待办事项。"] },
  { en: ["We need to finalize the design before the review.", "Let's focus on the details."], zh: ["我们得在评审前把设计定下来。", "先集中敲定细节。"] },
  { en: ["I agree with John about the budget.", "We still need more details though."], zh: ["我同意约翰关于预算的看法。", "不过还需要更多细节。"] },
  { en: ["Thanks for joining today.", "Please remember to fill out the feedback form."], zh: ["感谢大家今天参会。", "记得填写反馈问卷。"] },
  { en: ["Let's take a short break.", "We'll reconvene in ten minutes."], zh: ["我们休息一下。", "十分钟后回来继续。"] },
];

let lastTestPairIndex = -1;

function pickTestSentencePair() {
  let index = randomInt(0, TEST_SENTENCE_PAIRS.length - 1);
  if (index === lastTestPairIndex) index = (index + 1) % TEST_SENTENCE_PAIRS.length;
  lastTestPairIndex = index;
  return TEST_SENTENCE_PAIRS[index];
}

// Gemini-style fragments: 3-10 Chinese characters / 3-10 English words per
// chunk; boundaries are random, so a chunk can land mid-sentence or even
// carry a sentence-final mark in the middle (merged Chinese stream).
const SENTENCE_END_RE = /[。！？!?；;]/;

function scheduleChunkStream(startDelay: number, sentence: string, language: "en" | "zh") {
  const parts = language === "en" ? sentence.split(/\s+/).filter(Boolean) : [...sentence];
  const chunks: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const size = Math.min(randomInt(3, 10), parts.length - i);
    const part = parts.slice(i, i + size);
    const lastPart = i + size >= parts.length;
    chunks.push(language === "en" ? `${part.join(" ")}${lastPart ? "" : " "}` : part.join(""));
    i += size;
  }
  let delay = startDelay;
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const timer = setTimeout(() => {
      if (!testStreamRunning) return;
      emitTestMessage({
        serverContent: {
          [language === "en" ? "inputTranscription" : "outputTranscription"]: {
            text: chunks[i],
            finished: last,
          },
        },
      });
    }, delay);
    testStreamBurstTimers.push(timer);
    if (!last && SENTENCE_END_RE.test(chunks[i])) {
      // A chunk that carries sentence-final punctuation marks a turn
      // boundary: pause a bit longer before the next chunk.
      delay += randomInt(600, 1200);
    } else {
      delay += Math.random() < 0.3 ? randomInt(1000, 2000) : randomInt(400, 900);
    }
  }
  return delay;
}

function emitTestSentencePair(onDone?: () => void) {
  const pair = pickTestSentencePair();
  let delay = 0;
  for (let s = 0; s < pair.en.length; s++) {
    // Original arrives first, translation lags like a real Gemini stream.
    delay = scheduleChunkStream(delay, pair.en[s], "en");
    delay += randomInt(400, 1200);
  }
  // Chinese sentences stream as one continuous flow, so chunk boundaries can
  // fall in the middle of a sentence-final punctuation like real speech.
  delay = scheduleChunkStream(delay, pair.zh.join(""), "zh");
  if (onDone) {
    const doneTimer = setTimeout(() => {
      if (testStreamRunning) onDone();
    }, delay + 350);
    testStreamBurstTimers.push(doneTimer);
  }
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function connectGemini() {
  const key = apiEntry.value.trim();
  const url = buildWebSocketUrl(baseUrlEntry.value, key);
  geminiConnected = false;
  await invoke("gemini_connect", { url, proxyUrl: proxyEntry.value.trim() || null });
}

function reconnectDelayMs(attempt: number) {
  if (attempt <= 0) return 100;
  if (attempt === 1) return 1000;
  return 1000 * 2 ** (attempt - 1);
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  const delay = reconnectDelayMs(reconnectAttempt);
  const seconds = delay / 1000;
  addLog(`连接已断开，${seconds.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 秒后自动重连`, "warn");
  setStatus("连接断开，正在重连，请稍等...", "warn");
  updateTitleRecordButton();
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!running) return;
    reconnectAttempt += 1;
    try {
      addLog("正在自动重连...");
      setStatus("连接断开，正在重连，请稍等...", "warn");
      updateTitleRecordButton();
      await connectGemini();
    } catch (e) {
      addLog(`自动重连失败：${e}`, "err");
      scheduleReconnect();
    }
  }, delay);
}

function clearReconnectTimer() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  updateTitleRecordButton();
}

// ── Gemini WebSocket ─────────────────────────────────────────────────────────
function buildWebSocketUrl(baseUrl: string, key: string) {
  const value = baseUrl.trim() || defaultBaseUrl();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(normalized);

  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("Base URL 需要以 http、https、ws 或 wss 开头");
  }

  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = GEMINI_WS_PATH;
  } else if (!url.pathname.endsWith("BidiGenerateContent")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}${GEMINI_WS_PATH}`;
  }

  url.searchParams.set("key", key);
  return url.toString();
}

function sendSetup(m: string) {
  addLog(`发送初始化配置：${m}`);
  const isLiveTranslate = m.includes("live-translate");
  const targetLanguageCode = resolveTargetLanguageCode(chineseMode.value);
  const setup = isLiveTranslate
    ? {
        setup: {
          model: `models/${m}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: { targetLanguageCode, echoTargetLanguage: true },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }
    : {
        setup: {
          model: `models/${m}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: { parts: [{ text: `Translate audio to ${targetLanguageCode === "zh-TW" ? "Traditional" : "Simplified"} Chinese.` }] },
        },
      };
  sendGeminiJson(setup);
}

function normalizeChineseMode(value: unknown) {
  return value === "zh-CN" || value === "zh-TW" ? value : "auto";
}

function resolveTargetLanguageCode(mode: string) {
  if (mode === "zh-TW") return "zh-TW";
  if (mode !== "auto") return "zh-CN";
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((lang) => /zh-(TW|HK|MO|Hant)/i.test(lang)) ? "zh-TW" : "zh-CN";
}

function chineseModeLabel(mode: string) {
  return mode === "zh-TW" ? "繁体中文" : mode === "auto" ? "自动" : "简体中文";
}

function sendGeminiJson(message: unknown) {
  invoke("gemini_send", { message: JSON.stringify(message) }).catch((e) => setStatus(`发送失败：${e}`, "err"));
}

function sendAudio(pcm: Uint8Array) {
  let b = "";
  for (let i = 0; i < pcm.length; i++) b += String.fromCharCode(pcm[i]);
  sendGeminiJson({
    realtimeInput: { audio: { data: btoa(b), mimeType: "audio/pcm;rate=16000" } },
  });
}

function onMsg(d: any) {
  if (d.setupComplete) { reconnectAttempt = 0; clearReconnectTimer(); geminiConnected = true; addLog("Gemini 初始化完成", "ok"); setStatus("已连接", "on"); updateTitleRecordButton(); return; }
  const sc = d.serverContent;
  if (sc) {
    if (sc.inputTranscription?.text) {
      sentenceEngine.appendOriginal(sc.inputTranscription.text, sc.inputTranscription.finished === true);
      historyAlignment.appendOriginal(sc.inputTranscription.text, sc.inputTranscription.finished === true);
    }
    if (sc.outputTranscription?.text) {
      sentenceEngine.appendTranslation(sc.outputTranscription.text);
      historyAlignment.appendTranslation(sc.outputTranscription.text, sc.outputTranscription.finished === true);
    }
    const hasOutputTranscription = Boolean(sc.outputTranscription?.text);
    if (sc.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData?.mimeType?.startsWith("audio/pcm") && voiceChk.checked) {
          const raw = atob(p.inlineData.data);
          const a = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
          invoke("play_audio", { pcmData: Array.from(a) }).catch(console.error);
        }
        if (p.text && !hasOutputTranscription) {
          sentenceEngine.appendTranslation(p.text);
          historyAlignment.appendTranslation(p.text);
        }
      }
    }
    if (sc.turnComplete) historyAlignment.completeTurn();
  }
  if (d.error) {
    const message = d.error.message || JSON.stringify(d.error);
    addLog(`Gemini 返回错误：${message}`, "err");
    setStatus(`错误：${message}`, "err");
  }
}

function debugSentence(message: string) {
  addDetailedLog(`[切句] ${message}`);
}

function formatDebugText(text: string) {
  if (!text) return "<empty>";
  return JSON.stringify(text.length > 36 ? `${text.slice(0, 36)}...` : text);
}

function updateTitleRecordButton() {
  emit("translation-state-changed", { running, connected: geminiConnected });
}

function setSubtitleVisible(visible: boolean) {
  subtitleVisible = visible;
  $("btn-subtitle").classList.toggle("active", visible);
  $("subtitle-toggle-text").textContent = visible ? "关闭悬浮字幕" : "开启悬浮字幕";
  if (visible) updateTitleRecordButton();
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  emitToOverlay();
}

function emitToOverlay(resetDisplay = false) {
  const data = {
    history: sentenceEngine.hist,
    curO: sentenceEngine.curO,
    curT: sentenceEngine.curT,
    bilingual: true,
    resetDisplay,
  };
  if (testStreamRunning) {
    addDetailedLog(`[随机测试] render hist=${data.history.length} cur=${formatDebugText(sentenceEngine.curT)}`);
  }
  emit("subtitle-update", data);
}

function emitSummaryState() {
  emit("summary-page-state", {
    items: summaryPageItems,
    running: aiRequestRunning,
    busyAction: summaryBusyAction,
    status: summaryPageStatus,
    statusKind: summaryPageStatusKind,
  });
}

function setSummaryPageStatus(status: string, kind: "idle" | "running" | "error") {
  summaryPageStatus = status;
  summaryPageStatusKind = kind;
  emitSummaryState();
}

async function loadSummaryItems() {
  try {
    const raw = await invoke<string>("load_summary_items");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      summaryPageItems = parsed as SummaryPageItem[];
      summarySessionStarted = summaryPageItems.length > 0;
    }
  } catch (error) {
    addLog(`总结历史加载失败：${error}`, "err");
    summaryPageItems = [];
    summarySessionStarted = false;
  }
}

function persistSummaryItems() {
  try {
    void invoke("save_summary_items", { items: JSON.stringify(summaryPageItems) });
  } catch (error) {
    addLog(`总结历史保存失败：${error}`, "err");
  }
}

function beginSummarySession() {
  if (summarySessionStarted) {
    summaryPageItems.push({ kind: "marker", time: currentTimeLabel(), sessionId: activeSessionId });
  }
  summarySessionStarted = true;
  setSummaryPageStatus("", "idle");
  persistSummaryItems();
}

function historySnapshotForSession(sessionId?: string) {
  if (!sessionId || sessionId === activeSessionId) return historyAlignment.snapshot();
  const session = getSession(sessionId);
  return session ? { history: session.sentences, curO: "", curT: "", curId: null } : null;
}

// 指定会话是否已有总结或问答（旧存档无 sessionId 时无法关联，视为没有）。
function hasSessionSummary(sessionId: string) {
  return summaryPageItems.some((item) => item.sessionId === sessionId && (item.kind === "summary" || item.kind === "qa"));
}

// 之前生成过则直接打开总结窗口展示历史，不重复调用 AI。
async function handleSummaryRequest(sessionId?: string) {
  const targetSessionId = sessionId || activeSessionId;
  if (hasSessionSummary(targetSessionId)) {
    emit("history-ai-state", { action: "summary", running: false });
    await invoke("show_summary_window");
    emitSummaryState();
    return;
  }
  await summarizeHistoryWithAi(targetSessionId);
}

function applyAlignedHistory(sessionId: string | undefined, items: Array<{ id: number; o: string; t: string }>) {
  if (!sessionId || sessionId === activeSessionId) {
    historyAlignment.replaceHistoryItems(items, { markAligned: true });
  } else {
    const session = getSession(sessionId);
    if (!session) return;
    sessionArchive = upsertSession(
      sessionArchive,
      replaceSessionSentences(
        session,
        items.map(({ id, o, t }) => ({ id, o, t, aligned: true })),
      ),
    );
    persistSessionArchive();
  }
  emitHistoryToWindow();
}

function applySentenceChanges(sessionId: string, items: Array<{ id: number; o: string; t: string }>) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  if (!items.length) return;
  if (!sessionId || sessionId === activeSessionId) {
    historyAlignment.markEdited(items.map((item) => item.id));
    historyAlignment.updateHistoryItems(items);
  } else {
    const session = getSession(sessionId);
    if (!session) return;
    const changes = new Map<number, { id: number; o: string; t: string; edited: true }>(
      items.map((item) => [item.id, { ...item, edited: true }]),
    );
    const sentences = session.sentences.map((sentence) => changes.get(sentence.id) || sentence);
    sessionArchive = upsertSession(sessionArchive, replaceSessionSentences(session, sentences));
    persistSessionArchive();
    emitHistoryToWindow();
  }
}

function deleteSentences(sessionId: string, ids: number[]) {
  if (aiAlignmentRunning) {
    emitHistoryEditError();
    return;
  }
  if (!ids.length) return;
  if (!sessionId || sessionId === activeSessionId) {
    historyAlignment.replaceHistoryItems(
      historyAlignment.hist.filter((item) => !ids.includes(item.id)),
      { preserveEdited: true, preserveAligned: true },
    );
  } else {
    const session = getSession(sessionId);
    if (!session) return;
    sessionArchive = upsertSession(
      sessionArchive,
      replaceSessionSentences(session, session.sentences.filter((sentence) => !ids.includes(sentence.id))),
    );
    persistSessionArchive();
    emitHistoryToWindow();
  }
}

function formatSentenceAlignmentWindow(lines: AlignedLine[]) {
  const { originals, translations } = buildSentenceUnits(lines);
  return [
    "ORIGINAL SENTENCES",
    originals.map((unit) => `[${unit.id}] ${unit.text}`).join("\n") || "(none)",
    "",
    "TRANSLATION SENTENCES",
    translations.map((unit) => `[${unit.id}] ${unit.text}`).join("\n") || "(none)",
  ].join("\n");
}

function buildAlignmentEditPrompt(lines: AlignedLine[]) {
  return [
    "You are aligning a bilingual transcript at sentence level. A history row may contain multiple sentences on either side, and sentences may be delayed or combined into the wrong row.",
    "The input contains separate ORIGINAL and TRANSLATION sentence lists. Each sentence has a unique ID.",
    "Return a JSON object {\"pairs\":[...]} with one pair for every ORIGINAL sentence and every TRANSLATION sentence.",
    '- "o" is an ORIGINAL sentence ID; "t" is a TRANSLATION sentence ID.',
    "Use null for one-sided content: {\"o\":\"O1-1\",\"t\":null} or {\"o\":null,\"t\":\"T2-1\"}.",
    "Every ORIGINAL and every TRANSLATION must appear exactly once. Never alter, merge, split, add, or remove sentence text; only choose pairings.",
    "Return pairs in chronological source order. Keep one-sided sentences at their ORIGINAL or TRANSLATION source position; do not group them at the end.",
    "",
    "Example:",
    "ORIGINAL SENTENCES\n[O1-1] Hello everyone.\n[O2-1] Let us start.",
    "TRANSLATION SENTENCES\n[T1-1] 我们开始吧。\n[T2-1] 大家好。",
    '{"pairs":[{"o":"O1-1","t":"T2-1"},{"o":"O2-1","t":"T1-1"}]}',
    "",
    formatSentenceAlignmentWindow(lines),
    "Return only the JSON object.",
  ].join("\n");
}

const ALIGN_MAX_ATTEMPTS = 3;

// 单块 Agent 闭环：模型返回编辑 → 解析/应用 → 无效编辑携带原因反馈给模型修正重试。
async function alignChunkWithAgent(
  model: string,
  chunkLines: AlignedLine[],
  working: AlignedLine[],
  prefix: string,
): Promise<AlignedLine[]> {
  let prompt = buildAlignmentEditPrompt(chunkLines);
  for (let attempt = 1; attempt <= ALIGN_MAX_ATTEMPTS; attempt++) {
    const response = await callGeminiText(model, prompt, true, {
      onRequestId: (requestId) => { activeAlignmentRequestId = requestId; },
      isCancelled: () => alignmentCancelRequested,
    });
    activeAlignmentRequestId = null;
    let edits: AlignmentEdit[];
    try {
      edits = parseAlignmentEdits(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`${prefix} 第 ${attempt}/${ALIGN_MAX_ATTEMPTS} 次响应无法解析：${message.slice(0, 200)}`, "warn");
      if (attempt === ALIGN_MAX_ATTEMPTS) throw new Error(`${prefix} 重试耗尽：${message}`);
      prompt += `\n\nThe previous response could not be parsed (${message}). Return only a valid pairs JSON object.`;
      continue;
    }
    const report = applyAlignmentEdits(working, edits);
    const errors = report.invalid.map((item) => `${JSON.stringify(item.edit)} — ${item.reason}`);
    if (report.changed) {
      addLog(`${prefix} 应用 ${report.applied} 条编辑（第 ${attempt} 次尝试）`);
      return report.lines;
    }
    if (report.invalid.length === 0) {
      // 模型认为无需修改（空 rows 或全部自引用）：视为成功，避免无意义重试。
      addLog(`${prefix} 未发现需要修正的错位`);
      return working;
    }
    if (attempt === ALIGN_MAX_ATTEMPTS) {
      throw new Error(`${prefix} 重试耗尽：${errors.join("；")}`);
    }
    addLog(`${prefix} 第 ${attempt}/${ALIGN_MAX_ATTEMPTS} 次 pairs 未通过校验，反馈模型重试`, "warn");
    prompt += `\n\nThe previous pairs were invalid. Re-analyze and return only a correct pairs JSON object:\n${errors.join("\n")}\n${formatSentenceAlignmentWindow(working)}`;
  }
  return working;
}

async function alignTranscriptWithAi(lines: AlignedLine[]): Promise<AlignedLine[]> {
  const model = summaryModelEntry.value.trim() || DEFAULT_SUMMARY_MODEL;
  if (alignmentCancelRequested) throw new Error("请求已取消");
  addLog(`AI 对齐：正在分析 ${buildSentenceUnits(lines).originals.length} 条 ORIGINAL 和 ${buildSentenceUnits(lines).translations.length} 条 TRANSLATION`);
  return alignChunkWithAgent(model, lines, lines.map((line) => ({ ...line })), "AI 对齐");
}

async function alignHistoryWithAi(sessionId?: string) {
  if (running || testStreamRunning) {
    emit("history-ai-error", { action: "align", message: "实时翻译进行中，无法进行 AI 对齐" });
    return;
  }
  if (aiRequestRunning) {
    emit("history-ai-error", { action: "align", message: "已有 AI 操作进行中，请稍候" });
    return;
  }
  const snapshot = historySnapshotForSession(sessionId);
  if (!snapshot || !snapshot.history.length) {
    emit("history-ai-error", { action: "align", message: "暂无可对齐的历史字幕" });
    return;
  }

  aiRequestRunning = true;
  aiAlignmentRunning = true;
  alignmentCancelRequested = false;
  activeAlignmentRequestId = null;
  emitHistoryToWindow();
  emitQuickRecordWindowState();
  emit("history-ai-state", { action: "align", running: true });
  let cancelled = false;
  let failed = false;
  try {
    const lines = snapshot.history.map((line) => ({ ...line }));
    const aligned = await alignTranscriptWithAi(lines);
    if (alignmentCancelRequested) throw new Error("请求已取消");
    applyAlignedHistory(sessionId, aligned);
  } catch (error) {
    cancelled = alignmentCancelRequested || isCancellationError(error);
    if (cancelled) {
      addLog("AI 对齐已取消", "warn");
    } else {
      failed = true;
      const message = `AI 对齐失败：${formatAiError(error)}`;
      addLog(message, "err");
      emit("history-ai-error", { action: "align", message });
    }
  } finally {
    activeAlignmentRequestId = null;
    alignmentCancelRequested = false;
    aiAlignmentRunning = false;
    aiRequestRunning = false;
    emitHistoryToWindow();
    emitQuickRecordWindowState();
    if (!failed) {
      emit("history-ai-state", {
        action: "align",
        running: false,
        message: cancelled ? "AI 对齐已取消" : "AI 对齐完成",
      });
    }
  }
}

async function cancelHistoryAiAlign() {
  if (!aiAlignmentRunning || alignmentCancelRequested) return;
  alignmentCancelRequested = true;
  emit("history-ai-state", { action: "align", running: true, cancelRequested: true, message: "正在停止 AI 对齐..." });
  const requestId = activeAlignmentRequestId;
  if (requestId) await invoke("gemini_cancel_text_stream", { requestId }).catch(() => {});
}

async function summarizeHistoryWithAi(sessionId?: string) {
  if (aiRequestRunning) {
    setSummaryPageStatus("已有 AI 操作进行中，请稍候", "error");
    await invoke("show_summary_window").catch(() => {});
    emit("history-ai-error", { action: "summary", message: "已有 AI 操作进行中，请稍候" });
    return;
  }
  const snapshot = historySnapshotForSession(sessionId);
  const transcript = snapshot ? [...snapshot.history, ...(snapshot.curO || snapshot.curT ? [{ o: snapshot.curO, t: snapshot.curT }] : [])] : [];
  if (!transcript.length) {
    setSummaryPageStatus("暂无可总结的历史字幕", "error");
    await invoke("show_summary_window").catch(() => {});
    emit("history-ai-error", { action: "summary", message: "暂无可总结的历史字幕" });
    return;
  }

  aiRequestRunning = true;
  summaryBusyAction = "summary";
  await invoke("show_summary_window").catch(() => {});
  summaryPageItems.push({ kind: "summary", time: currentTimeLabel(), text: "", sessionId: sessionId || activeSessionId });
  const placeholderIndex = summaryPageItems.length - 1;
  emitSummaryState();
  try {
    const prompt = [
      "请用简体中文总结下面的会议字幕。",
      "提炼主题、关键事实、结论和待办事项，避免臆测。",
      "输出清晰的 Markdown，控制在 500 字以内。",
      "字幕内容开始",
      formatHistoryForAi(transcript),
      "字幕内容结束",
    ].join("\n");
    const text = (await callGeminiText(summaryModelEntry.value.trim() || DEFAULT_SUMMARY_MODEL, prompt, false, {
      onChunk: (chunk) => {
        const item = summaryPageItems[placeholderIndex];
        if (item && item.kind === "summary") item.text = chunk;
        emitSummaryState();
      },
    })).trim();
    if (!text) throw new Error("模型没有返回总结内容");
    const item = summaryPageItems[placeholderIndex];
    if (item && item.kind === "summary") item.text = text;
    persistSummaryItems();
    emitSummaryState();
    await invoke("show_summary_window");
    emitSummaryState();
    emit("history-ai-state", { action: "summary", running: false, message: "AI 总结完成" });
  } catch (error) {
    const message = `AI 总结失败：${formatAiError(error)}`;
    addLog(message, "err");
    summaryPageItems.splice(placeholderIndex, 1);
    persistSummaryItems();
    setSummaryPageStatus(message, "error");
    emit("history-ai-error", { action: "summary", message });
  } finally {
    aiRequestRunning = false;
    summaryBusyAction = null;
    emitSummaryState();
  }
}

async function askHistoryWithAi(question?: string) {
  const q = (question || "").trim();
  if (!q) return;
  if (aiRequestRunning) {
    setSummaryPageStatus("已有 AI 操作进行中，请稍候", "error");
    await invoke("show_summary_window").catch(() => {});
    return;
  }
  const snapshot = historySnapshotForSession();
  const transcript = snapshot ? [...snapshot.history, ...(snapshot.curO || snapshot.curT ? [{ o: snapshot.curO, t: snapshot.curT }] : [])] : [];
  if (!transcript.length) {
    setSummaryPageStatus("暂无可提问的字幕", "error");
    await invoke("show_summary_window").catch(() => {});
    emit("history-ai-error", { action: "summary", message: "暂无可提问的字幕" });
    return;
  }

  aiRequestRunning = true;
  summaryBusyAction = "qa";
  await invoke("show_summary_window").catch(() => {});
  summaryPageItems.push({ kind: "qa", time: currentTimeLabel(), question: q, answer: "", sessionId: activeSessionId });
  const placeholderIndex = summaryPageItems.length - 1;
  emitSummaryState();
  try {
    const prompt = [
      "下面是一次会议的字幕记录，请基于字幕内容回答用户的问题。",
      "不要臆测；如果字幕中没有相关信息，请明确说明。",
      "字幕内容开始",
      formatHistoryForAi(transcript),
      "字幕内容结束",
      `问题：${q}`,
    ].join("\n");
    const text = (await callGeminiText(summaryModelEntry.value.trim() || DEFAULT_SUMMARY_MODEL, prompt, false, {
      onChunk: (chunk) => {
        const item = summaryPageItems[placeholderIndex];
        if (item && item.kind === "qa") item.answer = chunk;
        emitSummaryState();
      },
    })).trim();
    if (!text) throw new Error("模型没有返回回答");
    const item = summaryPageItems[placeholderIndex];
    if (item && item.kind === "qa") item.answer = text;
    persistSummaryItems();
    emitSummaryState();
    await invoke("show_summary_window");
    emitSummaryState();
  } catch (error) {
    const message = `AI 提问失败：${formatAiError(error)}`;
    addLog(message, "err");
    summaryPageItems.splice(placeholderIndex, 1);
    persistSummaryItems();
    setSummaryPageStatus(message, "error");
    emit("history-ai-error", { action: "summary", message });
  } finally {
    aiRequestRunning = false;
    summaryBusyAction = null;
    emitSummaryState();
  }
}

function formatHistoryForAi(items: Array<{ o: string; t: string }>) {
  const text = items.map((item, index) => `[${index + 1}] ORIGINAL: ${item.o || ""}\nTRANSLATION: ${item.t || ""}`).join("\n");
  return text.length > 60_000 ? text.slice(-60_000) : text;
}

function isCancellationError(error: unknown) {
  return /请求已取消|对齐已取消/.test(formatAiError(error));
}

async function optimizeHistoryRecordWithAi(payload: {
  requestId: string;
  sessionId: string;
  sentenceId: number;
  text: string;
}) {
  try {
    const prompt = [
      "请优化下面这条会议备注。",
      "保留原意和事实，不要添加原文中没有的信息。",
      "修正错别字、语病和表达不清之处，使其简洁、自然、适合作为会议备注。",
      "只返回优化后的备注文本，不要添加解释、引号或 Markdown。",
      "备注内容：",
      payload.text,
    ].join("\n");
    const text = (await callGeminiText(summaryModelEntry.value.trim() || DEFAULT_SUMMARY_MODEL, prompt, false)).trim();
    if (!text) throw new Error("模型没有返回优化后的备注");
    await emit("subtitle-history-record-optimize-result", {
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      sentenceId: payload.sentenceId,
      success: true,
      text,
    });
  } catch (error) {
    const message = `AI 优化备注失败：${formatAiError(error)}`;
    addLog(message, "err");
    await emit("subtitle-history-record-optimize-result", {
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      sentenceId: payload.sentenceId,
      success: false,
      message,
    });
  }
}

type GeminiTextOptions = {
  onRequestId?: (requestId: string) => void;
  isCancelled?: () => boolean;
  /** 流式输出：每次收到增量后回调整段已累积文本。 */
  onChunk?: (text: string) => void;
};

async function callGeminiText(model: string, prompt: string, jsonResponse: boolean, options?: GeminiTextOptions) {
  const key = resolveAiKey();
  if (!key) throw new Error(summaryKeyMode() === "custom" ? "请先填写总结 API 密钥" : "请先填写 Gemini API 密钥");
  const isAiStudio = summaryUrlMode() === "custom" ? false : baseFormat() === "aistudio";
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (options?.isCancelled?.()) throw new Error("请求已取消");
    addLog(`AI 请求开始（第 ${attempt} 次）：${model}`);
    try {
      const text = await streamGeminiText(model, prompt, jsonResponse, key, isAiStudio, options);
      if (!text.trim()) throw new Error("模型没有返回文本");
      if (options?.isCancelled?.()) throw new Error("请求已取消");
      addLog(`AI 请求完成（第 ${attempt} 次）：${model}`);
      return text;
    } catch (error) {
      lastError = error;
      if (options?.isCancelled?.() || isCancellationError(error)) throw new Error("请求已取消");
      if (attempt >= 3 || !isRetryableError(error)) {
        addLog(`AI 请求结束（失败，第 ${attempt} 次）：${formatAiError(error)}`, "err");
        break;
      }
      addLog(`AI 请求失败（第 ${attempt} 次，3 秒后自动重试）：${formatAiError(error)}`, "err");
      const retryUntil = Date.now() + 3000;
      while (Date.now() < retryUntil) {
        if (options?.isCancelled?.()) throw new Error("请求已取消");
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, retryUntil - Date.now())));
      }
    }
  }
  throw lastError as Error;
}

async function streamGeminiText(
  model: string,
  prompt: string,
  jsonResponse: boolean,
  key: string,
  isAiStudio: boolean,
  options?: GeminiTextOptions,
) {
  const base = buildGenerateContentUrl(resolveAiBaseUrl(), model, key, isAiStudio);
  const url = isAiStudio ? base.replace(":generateContent?", ":streamGenerateContent?alt=sse&") : base;
  const body = isAiStudio
    ? JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: jsonResponse ? { temperature: 0.1, responseMimeType: "application/json" } : { temperature: 0.35 },
      })
    : JSON.stringify({
        model: model.replace(/^models\//, ""),
        messages: [{ role: "user", content: prompt }],
        temperature: jsonResponse ? 0.1 : 0.35,
        stream: true,
        reasoning_effort: "none",
        ...(jsonResponse ? { response_format: { type: "json_object" } } : {}),
      });
  const headers = isAiStudio ? [["x-goog-api-key", key]] : [["Authorization", `Bearer ${key}`]];
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const chunkEvent = `gemini-llm-chunk-${requestId}`;
  options?.onRequestId?.(requestId);
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let settled = false;
    const unlisteners: Array<() => void> = [];
    const cleanup = () => {
      clearTimeout(fallbackTimer);
      unlisteners.forEach((unlisten) => unlisten());
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    // 兜底：Rust 端任何静默挂起也不让请求无限等待
    const fallbackTimer = setTimeout(() => {
      void invoke("gemini_cancel_text_stream", { requestId }).catch(() => {});
      finish(() => reject(new Error("请求超时（超过 360 秒无结果）")));
    }, 360_000);
    listen<{ text: string }>(chunkEvent, (event) => {
      text += event.payload?.text || "";
      options?.onChunk?.(text);
    })
      .then((unlistenChunk) => {
        unlisteners.push(unlistenChunk);
        addLog(`AI 请求已提交：${requestId}`);
        const request = invoke<string>("gemini_generate_text_stream", {
          requestId,
          url,
          proxyUrl: proxyEntry.value.trim() || null,
          headers,
          body,
        });
        if (options?.isCancelled?.()) {
          void invoke("gemini_cancel_text_stream", { requestId }).catch(() => {});
        }
        return request;
      })
      .then((result) => {
        addLog(`AI 请求收到 Rust 返回（${(result || text).length} 字符）`);
        finish(() => resolve(result || text));
      })
      .catch((error) => {
        addLog(`AI 请求底层失败：${error}`, "err");
        finish(() => reject(new Error(`${error}（请求 URL：${maskUrlKey(url)}）`)));
      });
  });
}

function isRetryableError(error: unknown) {
  const message = formatAiError(error);
  // 4xx 是配置/鉴权问题，重试无意义；5xx、超时、网络错误、空回复均重试
  return !/HTTP 4\d\d/.test(message);
}

function maskUrlKey(url: string) {
  try {
    const masked = new URL(url);
    if (masked.searchParams.has("key")) masked.searchParams.set("key", "***");
    return masked.toString();
  } catch {
    return url;
  }
}

function buildGenerateContentUrl(baseUrl: string, model: string, key: string, isAiStudio: boolean) {
  const value = baseUrl.trim() || defaultBaseUrl();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(normalized);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL 协议无效");
  if (isAiStudio) {
    url.pathname = `/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
    // Key travels as a query parameter, matching Google AI Studio's API format.
    url.search = "";
    url.searchParams.set("key", key);
  } else {
    url.pathname = buildOpenAiCompletionsPath(url.pathname);
    url.search = "";
  }
  return url.toString();
}

function buildOpenAiCompletionsPath(pathname: string) {
  const path = pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions") || path.endsWith("/completions")) return path;
  if (path.endsWith("/chat")) return `${path}/completions`;
  if (path.endsWith("/v1")) return `${path}/chat/completions`;
  return `${path}/v1/chat/completions`;
}

function currentTimeLabel() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function formatAiError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError" ? "请求超时" : String(error);
}

async function emit(event: string, payload: unknown) {
  const { emit: tauriEmit } = await import("@tauri-apps/api/event");
  tauriEmit(event, payload);
}

// ── Status ───────────────────────────────────────────────────────────────────
function setStatus(t: string, c: string) {
  statusText.textContent = t;
  statusDot.className = `dot ${c}`;
}

function showSubtitleRecordButtonWarning(message: string) {
  void emit("subtitle-record-warn", { message });
}

function flashStartError(message: string) {
  showSubtitleRecordButtonWarning(message);
}

function addLog(message: string, type = "") {
  const shouldFollow = logAutoScroll || isLogNearBottom();
  const line = document.createElement("div");
  const now = new Date();
  const time = `${now.toLocaleTimeString("zh-CN", { hour12: false })}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  line.className = `log-line ${type}`.trim();
  line.textContent = `[${time}] ${message}`;
  logBox.appendChild(line);
  while (logBox.childElementCount > 100) logBox.firstElementChild?.remove();
  if (shouldFollow) {
    logBox.scrollTop = logBox.scrollHeight;
    logAutoScroll = true;
  }
}

function addDetailedLog(message: string, type = "") {
  if (!detailedLogChk.checked) return;
  addLog(message, type);
}

function clearLog() {
  logBox.textContent = "";
  logAutoScroll = true;
}

function isLogNearBottom() {
  return logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight <= LOG_AUTO_SCROLL_THRESHOLD;
}

init();
