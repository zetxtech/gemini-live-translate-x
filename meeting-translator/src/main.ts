import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "./subtitle-settings-shared";
import { SentenceCutEngine } from "./sentence-cut-engine";

const win = getCurrentWindow();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MINIMIZE_TIP_KEY = "mt-hide-taskbar-minimize-tip";
const DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_WS_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MIN_COMMA_BREAK_CHARS = 5;
const MIN_PACKET_TAIL_CHARS = 4;
const MIN_SENTENCE_CUT_CHARS = 4;
const MIN_SENTENCE_CUT_DELAY_MS = 500;
const SPEECH_INTERVAL_WINDOW_MS = 30_000;
const DEFAULT_SHORT_TAIL_TIMEOUT_MS = 1_000;
const SENTENCE_DEBUG = true;
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
$("btn-max").onclick = (e) => { e.stopPropagation(); win.toggleMaximize(); };
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
const proxyEntry   = $<HTMLInputElement>("proxy-entry");
const modelEntry   = $<HTMLInputElement>("model-entry");
const chineseMode  = $<HTMLSelectElement>("chinese-mode");
const deviceCombo  = $<HTMLSelectElement>("device-combo");
const voiceChk     = $<HTMLInputElement>("voice");
const trayTipChk   = $<HTMLInputElement>("tray-tip");
const startBtn     = $<HTMLButtonElement>("start-btn");
const stopBtn      = $<HTMLButtonElement>("stop-btn");
const testStreamBtn = $<HTMLButtonElement>("test-stream-btn");
const statusText   = $<HTMLElement>("status-text");
const statusDot    = $<HTMLElement>("status-dot");
const logBox       = $<HTMLDivElement>("log-box");

voiceChk.onchange = saveCfg;
chineseMode.onchange = saveCfg;
trayTipChk.onchange = () => {
  if (trayTipChk.checked) {
    localStorage.removeItem(MINIMIZE_TIP_KEY);
  } else {
    localStorage.setItem(MINIMIZE_TIP_KEY, "1");
  }
  saveCfg();
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

// ── Presets ──────────────────────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>(".preset").forEach((b) =>
  b.onclick = () => { modelEntry.value = b.dataset.m || ""; });

// ── Refresh devices ──────────────────────────────────────────────────────────
$("refresh-btn").onclick = refreshDevices;

async function refreshDevices() {
  try {
    const [d, defaultName] = await invoke<[string[], string]>("get_audio_devices");
    const prev = deviceCombo.value;
    deviceCombo.innerHTML = "";
    d.forEach((n) => {
      const o = document.createElement("option");
      o.value = n; o.textContent = n;
      deviceCombo.appendChild(o);
    });
    // Restore previous selection, or select system default
    if (prev && d.includes(prev)) {
      deviceCombo.value = prev;
    } else if (defaultName && d.includes(defaultName)) {
      deviceCombo.value = defaultName;
    }
  } catch (e) { console.error(e); }
}

// ── Settings persistence ─────────────────────────────────────────────────────
const SK = "mt-cfg";
function loadCfg() {
  try { const s = localStorage.getItem(SK); if (s) return JSON.parse(s); } catch {}
  return { k: "", b: "", p: "", m: DEFAULT_MODEL, cm: "zh-CN", v: true, d: "", tt: true };
}
function saveCfg() {
  localStorage.setItem(SK, JSON.stringify({
    k: apiEntry.value, b: baseUrlEntry.value, p: proxyEntry.value, m: modelEntry.value, cm: chineseMode.value,
    v: voiceChk.checked, d: deviceCombo.value, tt: trayTipChk.checked
  }));
}

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

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const c = loadCfg();
  if (c.k) apiEntry.value = c.k;
  if (c.b) baseUrlEntry.value = c.b;
  if (c.p) proxyEntry.value = c.p;
  modelEntry.value = c.m || DEFAULT_MODEL;
  chineseMode.value = normalizeChineseMode(c.cm);
  voiceChk.checked = c.v;
  trayTipChk.checked = c.tt !== false && localStorage.getItem(MINIMIZE_TIP_KEY) !== "1";
  await refreshDevices();
  if (c.d && deviceCombo.querySelector(`option[value="${c.d}"]`)) {
    deviceCombo.value = c.d;
  }
  await listen<number[]>("audio-data", (e) => {
    if (geminiConnected) sendAudio(new Uint8Array(e.payload));
  });
  await listen<string>("gemini-log", (e) => addLog(e.payload));
  await listen<boolean>("subtitle-visibility-changed", (e) => {
    setSubtitleVisible(e.payload);
  });
  await listen("subtitle-record-toggle", async () => {
    if (running) await stop();
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
  await listen<{ text: string }>("current-line-readable", (e) => {
    sentenceEngine.onCurrentLineReadable(e.payload?.text || "");
  });
  render();
  updateTitleRecordButton();
}

// ── Start / Stop ─────────────────────────────────────────────────────────────
startBtn.onclick = start;
stopBtn.onclick = stop;
testStreamBtn.onclick = toggleTestStream;

async function start() {
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
  clearLog();
  addLog("准备连接 Gemini");
  addLog(`Base URL：${baseUrlEntry.value.trim() || DEFAULT_BASE_URL}`);
  addLog(`代理：${proxyEntry.value.trim() || "直连"}`);
  addLog(`模型：${modelEntry.value.trim() || DEFAULT_MODEL}`);
  addLog(`字幕中文：${chineseModeLabel(chineseMode.value)} -> ${resolveTargetLanguageCode(chineseMode.value)}`);
  running = true;
  reconnectAttempt = 0;
  clearReconnectTimer();
  sentenceEngine.reset();
  startBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  apiEntry.disabled = baseUrlEntry.disabled = proxyEntry.disabled = modelEntry.disabled = chineseMode.disabled = deviceCombo.disabled = true;
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
    await invoke("start_capture");
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

async function stop() {
  running = false;
  stopTestStream();
  clearReconnectTimer();
  sentenceEngine.clearPendingSentenceCut();
  sentenceEngine.clearPendingShortTail();
  await invoke("gemini_disconnect").catch(() => {});
  geminiConnected = false;
  try { await invoke("stop_capture"); } catch {}
  stopBtn.classList.add("hidden");
  startBtn.classList.remove("hidden");
  apiEntry.disabled = baseUrlEntry.disabled = proxyEntry.disabled = modelEntry.disabled = chineseMode.disabled = deviceCombo.disabled = false;
  setStatus("连接已断开", "");
  updateTitleRecordButton();

  // Hide subtitle overlay
  try {
    await invoke("hide_subtitle_window");
  } catch {}
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
  testStreamRunning = true;
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
  testStreamBtn.classList.remove("active");
  testStreamBtn.textContent = "继续随机字幕测试";
}

async function startTestStream() {
  pauseTestStream();
  clearLog();
  testStreamRunning = true;
  testStreamBtn.classList.add("active");
  testStreamBtn.textContent = "暂停随机字幕测试";
  sentenceEngine.reset();
  render();
  addLog("[随机测试] 开始：随机输出中文块，包含逗号、句号和单块内断句");
  try { await invoke("show_subtitle_window"); } catch (e) { console.error("subtitle window:", e); }
  scheduleTestChunk(0);
}

function stopTestStream() {
  pauseTestStream();
  testStreamTimer = null;
  testStreamBurstTimers = [];
  testStreamRunning = false;
  testStreamBtn.classList.remove("active");
  testStreamBtn.textContent = "随机字幕测试";
  sentenceEngine.clearPendingSentenceCut();
  sentenceEngine.clearPendingShortTail();
}

function scheduleTestChunk(delay: number) {
  testStreamTimer = setTimeout(() => {
    testStreamTimer = null;
    if (!testStreamRunning) return;
    if (Math.random() < 0.08) {
      runTestBurst();
      scheduleTestChunk(randomTestInterval());
      return;
    }
    emitTestMessage(randomTestMessage());
    scheduleTestChunk(randomTestInterval());
  }, delay);
}

function runTestBurst() {
  const count = randomInt(2, 3);
  addLog(`[随机测试] burst count=${count}`, "warn");
  for (let i = 0; i < count; i++) {
    const timer = setTimeout(() => {
      if (!testStreamRunning) return;
      emitTestMessage(randomTestMessage());
    }, i * randomInt(400, 900));
    testStreamBurstTimers.push(timer);
  }
}

/**
 * Variable pacing so the stream feels like real remote timing:
 * mostly steady short intervals, with occasional fast bursts and slow gaps.
 */
function randomTestInterval() {
  const roll = Math.random();
  if (roll < 0.15) return randomInt(250, 500);
  if (roll < 0.7) return randomInt(500, 1200);
  return randomInt(1200, 2400);
}

function emitTestMessage(message: { serverContent: unknown }) {
  addLog(`[随机测试] msg=${formatDebugText(JSON.stringify(message.serverContent))}`, "warn");
  onMsg(message);
}

function randomTestMessage() {
  const serverContent: any = {};
  const shape = randomInt(0, 9);
  if (shape === 0) {
    serverContent.inputTranscription = { text: randomSpeechChunk(false) };
  } else if (shape === 1) {
    serverContent.outputTranscription = { text: randomSpeechChunk(true) };
  } else if (shape === 2) {
    serverContent.inputTranscription = { text: randomSpeechChunk(false) };
    serverContent.outputTranscription = { text: randomSpeechChunk(true) };
  } else if (shape === 3) {
    serverContent.inputTranscription = { text: randomSpeechChunk(false) };
    serverContent.modelTurn = { parts: [{ text: randomSpeechChunk(true) }] };
  } else if (shape === 4) {
    serverContent.outputTranscription = { text: randomCompoundChunk() };
  } else if (shape === 5) {
    serverContent.outputTranscription = { text: randomShortTailChunk() };
  } else if (shape === 6) {
    serverContent.inputTranscription = { text: randomSpeechChunk(false), finished: true };
  } else if (shape === 7) {
    serverContent.turnComplete = true;
  } else if (shape === 8) {
    serverContent.inputTranscription = { text: randomSpeechChunk(false) };
    serverContent.outputTranscription = { text: randomSpeechChunk(true), finished: true };
  } else {
    serverContent.outputTranscription = { text: randomSpeechChunk(true), finished: Math.random() < 0.35 };
  }
  return { serverContent };
}

function randomSpeechChunk(translated: boolean, allowTrailingPunctuation = true) {
  const words = translated
    ? ["会议", "现在", "我们", "需要", "确认", "这个", "问题", "字幕", "切换", "动画", "上浮", "重复", "显示", "测试", "继续", "观察", "结果", "如果", "发生", "记录"]
    : ["hello", "meeting", "audio", "caption", "stream", "chunk", "sentence", "again", "testing", "remote", "packet", "timing"];
  const longChunk = Math.random() < 0.08;
  const length = translated
    ? (longChunk ? randomInt(5, 9) : randomInt(1, 3))
    : (longChunk ? randomInt(4, 7) : randomInt(1, 2));
  let text = "";
  for (let i = 0; i < length; i++) text += words[randomInt(0, words.length - 1)];
  if (allowTrailingPunctuation && Math.random() < 0.28) text += randomPunctuation();
  return text;
}

function randomCompoundChunk() {
  return `${randomSpeechChunk(true, false)}。${randomSpeechChunk(true, false)}`;
}

function randomShortTailChunk() {
  const tails = ["我", "我们", "这", "如果", "所以", "但是", "然后", "接着"];
  return `${randomSpeechChunk(true, false)}${randomPunctuation()}${tails[randomInt(0, tails.length - 1)]}`;
}

function randomPunctuation() {
  const marks = ["，", "。", "。", "？", "！", "；", "、", "："];
  return marks[randomInt(0, marks.length - 1)];
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
  const value = baseUrl.trim() || DEFAULT_BASE_URL;
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
  return value === "zh-TW" || value === "auto" ? value : "zh-CN";
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
      sentenceEngine.appendOriginal(sc.inputTranscription.text);
    }
    if (sc.outputTranscription?.text) {
      sentenceEngine.appendTranslation(sc.outputTranscription.text);
    }
    if (sc.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData?.mimeType?.startsWith("audio/pcm") && voiceChk.checked) {
          const raw = atob(p.inlineData.data);
          const a = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
          invoke("play_audio", { pcmData: Array.from(a) }).catch(console.error);
        }
        if (p.text) sentenceEngine.appendTranslation(p.text);
      }
    }
  }
  if (d.error) {
    const message = d.error.message || JSON.stringify(d.error);
    addLog(`Gemini 返回错误：${message}`, "err");
    setStatus(`错误：${message}`, "err");
  }
}

function debugSentence(message: string) {
  if (!SENTENCE_DEBUG) return;
  addLog(`[切句] ${message}`);
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

function emitToOverlay() {
  const data = {
    history: sentenceEngine.hist.slice(-20),
    curO: sentenceEngine.curO,
    curT: sentenceEngine.curT,
    bilingual: true,
  };
  if (testStreamRunning) {
    addLog(`[随机测试] render hist=${data.history.length} cur=${formatDebugText(sentenceEngine.curT)}`);
  }
  emit("subtitle-update", data);
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

function clearLog() {
  logBox.textContent = "";
  logAutoScroll = true;
}

function isLogNearBottom() {
  return logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight <= LOG_AUTO_SCROLL_THRESHOLD;
}

init();
