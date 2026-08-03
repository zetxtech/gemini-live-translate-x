import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTextVariables, loadSettings, normalizeSettings, saveSettings, type SubtitleSettings } from "./subtitle-settings-shared";
import { buildCaptionFrame, shouldPromoteCurrentToHistory } from "./subtitle-frame";
import {
  clampHistoryStaticOffset,
  clampTranslateX,
  computeScrollHoldUntil,
  computeScrollRawTarget,
  isCurrentLineReadable,
  SCROLL_READ_HOLD_MS,
  shouldResetScrollOnNonContinuation,
} from "./subtitle-scroll";

const lyrics = document.getElementById("lyrics")!;
const overlay = document.getElementById("overlay")!;
const controls = document.getElementById("controls")!;
const btnSettings = document.getElementById("btn-settings")!;
const btnLock = document.getElementById("btn-lock")!;
const btnClose = document.getElementById("btn-close")!;
const btnRecord = document.getElementById("btn-record")!;
const recordIcon = document.getElementById("record-icon")!;
const resizeBottom = document.getElementById("resize-bottom")!;
type SubtitleLine = { id?: number; o: string; t: string };
type ScrollState = { rawTarget: number; target: number; offset: number; velocity: number; raf: number | null; lastTime: number; lastTextWidth: number; holdUntil: number; hasReadableText: boolean; speedCapped: boolean };
const SCROLL_SOFTNESS_RATIO = 0.08;
const SCROLL_MAX_SPEED_RATIO = 1.4;
const SCROLL_VELOCITY_TAU = 0.12;
const SCROLL_TARGET_TAU = 0.18;
const SCROLL_TEXT_GROWTH_GAIN = 0.28;
const SCROLL_MAX_CHAR_SPEED = 10;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const SPEED_CAP_DELTA_THRESHOLD = 7;
const HISTORY_PROMOTE_MS = 380;
const HISTORY_LAYOUT_FLIP_MS = 320;
type LineRectSnapshot = { left: number; top: number; width: number; height: number; fontSize: number };
let settings = loadSettings();
let latestPayload = { history: [] as SubtitleLine[], curO: "", curT: "" };
let locked = false;
let scrollStates = new WeakMap<HTMLElement, ScrollState>();
let resetRenderTimer: ReturnType<typeof setTimeout> | null = null;
let instantScrollLayout = false;
let lastRenderTime = 0;
let renderCount = 0;
/** Last text for which we already notified main that the current line is readable. */
let lastReadableNotifiedText = "";
const DEBUG_SESSION_ID = "7fb184";
const DEBUG_INGEST_URL = "http://127.0.0.1:7352/ingest/89bf8b89-941a-4294-9d5d-d3f5d2c74fe6";

function hasCJK(text: string): boolean { return CJK_RE.test(text); }

function postDebugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown> = {}) {
  fetch(DEBUG_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}

function previewDebugText(text: string, limit = 24) {
  if (!text) return "<empty>";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function attachHistoryAnimationDebug(line: HTMLElement) {
  if (line.dataset.animationDebugAttached === "1") return;
  line.dataset.animationDebugAttached = "1";
  const key = line.dataset.lineKey ?? "";
  const report = (eventType: string, event: AnimationEvent) => {
    postDebugLog("H2", "subtitles.ts:history-animation", `${eventType} ${event.animationName}`, {
      key,
      className: line.className,
      text: previewDebugText(lineText(line), 18),
      entering: line.dataset.entering === "1",
      exit: line.dataset.exit === "1",
      elapsedTime: event.elapsedTime,
    });
  };
  line.addEventListener("animationstart", (event) => report("animationstart", event));
  line.addEventListener("animationend", (event) => report("animationend", event));
  line.addEventListener("animationcancel", (event) => report("animationcancel", event));
}

// ── Mouse tracking for window area ──────────────────────────────────────────
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function activateBg() {
  if (locked || overlay.classList.contains("bg-visible")) return;
  overlay.classList.add("bg-visible");
  invoke("set_subtitle_background_active", { active: true }).catch(console.error);
}

function scheduleFade() {
  if (overlay.classList.contains("settings-open")) return;
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    overlay.classList.remove("bg-visible");
    overlay.classList.remove("settings-open");
    invoke("set_subtitle_background_active", { active: false }).catch(console.error);
    fadeTimer = null;
  }, 1000);
}

overlay.addEventListener("mouseleave", () => scheduleFade());

resizeBottom.addEventListener("pointerdown", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  try {
    await getCurrentWindow().startResizeDragging("South");
  } catch (err) {
    console.error("resize:", err);
  }
});

// When Rust detects mouse left the window region
listen("lock-mouse-left", () => {
  scheduleFade();
});

listen("subtitle-hit-hover", () => {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  activateBg();
});

listen<{ running: boolean; connected: boolean }>("translation-state-changed", (event) => {
  updateRecordButton(event.payload.running, event.payload.connected);
});

let recordButtonWarnTimer: ReturnType<typeof setTimeout> | null = null;
let lastRecordButtonState = { running: false, connected: false };
let recordButtonWarnSequence = 0;
const RECORD_ICON_FADE_MS = 260;
const RECORD_WARNING_HOLD_MS = 1_400;

/**
 * Show a warning state on the subtitle overlay's start/stop button when the main
 * window reports a failed action (e.g. missing API key). The icon cross-fades to
 * a yellow warning triangle, then fades back to the original look and tooltip.
 */
listen<{ message?: string }>("subtitle-record-warn", (event) => {
  if (recordButtonWarnTimer) clearTimeout(recordButtonWarnTimer);
  const message = event.payload?.message || "操作失败";
  const sequence = ++recordButtonWarnSequence;
  void showRecordButtonWarning(message, sequence);
});

async function showRecordButtonWarning(message: string, sequence: number) {
  btnRecord.classList.add("warn");
  btnRecord.title = message;
  await fadeRecordIcon(1, 0);
  if (sequence !== recordButtonWarnSequence) return;

  renderRecordWarningIcon();
  await fadeRecordIcon(0, 1);
  if (sequence !== recordButtonWarnSequence) return;

  recordButtonWarnTimer = setTimeout(() => {
    recordButtonWarnTimer = null;
    void restoreRecordButton(sequence);
  }, RECORD_WARNING_HOLD_MS);
}

async function restoreRecordButton(sequence: number) {
  await fadeRecordIcon(1, 0);
  if (sequence !== recordButtonWarnSequence) return;

  btnRecord.classList.remove("warn");
  renderRecordButtonState(lastRecordButtonState.running, lastRecordButtonState.connected);
  await fadeRecordIcon(0, 1);
}

async function fadeRecordIcon(fromOpacity: number, toOpacity: number) {
  const animation = recordIcon.animate(
    [{ opacity: fromOpacity }, { opacity: toOpacity }],
    { duration: RECORD_ICON_FADE_MS, easing: "ease-in-out", fill: "forwards" },
  );
  try {
    await animation.finished;
  } catch {
    return;
  }
  recordIcon.style.opacity = String(toOpacity);
  animation.cancel();
}

function renderRecordWarningIcon() {
  recordIcon.className = "record-icon warning";
  recordIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
}

btnRecord.addEventListener("click", async (e) => {
  e.stopPropagation();
  await emit("subtitle-record-toggle", {});
});

function updateRecordButton(running: boolean, connected: boolean) {
  lastRecordButtonState = { running, connected };
  if (btnRecord.classList.contains("warn")) return;
  recordIcon.style.opacity = "";
  renderRecordButtonState(running, connected);
}

function renderRecordButtonState(running: boolean, connected: boolean) {
  recordIcon.className = "record-icon";
  recordIcon.innerHTML = "";
  if (!running) {
    btnRecord.title = "开始翻译";
    recordIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 19 12 7 20 7 4"/></svg>';
    return;
  }
  if (!connected) {
    btnRecord.title = "正在连接";
    recordIcon.classList.add("connecting");
    return;
  }
  btnRecord.title = "停止翻译";
  recordIcon.classList.add("recording");
}

updateRecordButton(false, false);

function updateHitAreas() {
  const children = Array.from(lyrics.querySelectorAll<HTMLElement>(".line, .empty, .empty-sub"));
  const visibleChildren = children.filter((child) => child.offsetWidth > 0 && child.offsetHeight > 0);
  if (!visibleChildren.length) {
    invoke("set_subtitle_hit_areas", { areas: [] }).catch(console.error);
    return;
  }

  const rootRect = overlay.getBoundingClientRect();
  const paddingX = 4;
  const paddingY = 3;
  const areas = visibleChildren.flatMap((child) => {
    const range = document.createRange();
    range.selectNodeContents(child);
    const rects = Array.from(range.getClientRects());
    range.detach();
    return rects
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .map((rect) => {
        const left = Math.max(0, rect.left - rootRect.left - paddingX);
        const top = Math.max(0, rect.top - rootRect.top - paddingY);
        const right = Math.min(rootRect.width, rect.right - rootRect.left + paddingX);
        const bottom = Math.min(rootRect.height, rect.bottom - rootRect.top + paddingY);
        return {
          x: left,
          y: top,
          w: Math.max(0, right - left),
          h: Math.max(0, bottom - top),
        };
      });
  });

  invoke("set_subtitle_hit_areas", { areas }).catch(console.error);
}

/**
 * Align the controls' vertical center line with the top edge of the subtitle
 * background. The lyrics box is vertically centered and its height changes as
 * history/current rows appear, so the controls' top must be recomputed after
 * every render instead of staying pinned to the window edge.
 */
function syncControlsToBackgroundTop() {
  const overlayRect = overlay.getBoundingClientRect();
  const lyricsRect = lyrics.getBoundingClientRect();
  const controlsRect = controls.getBoundingClientRect();
  if (lyricsRect.width === 0 && lyricsRect.height === 0) return;
  const desiredTop = lyricsRect.top - overlayRect.top - controlsRect.height / 2;
  controls.style.top = `${Math.max(0, desiredTop)}px`;
}

function syncControlsAfterLayout() {
  requestAnimationFrame(() => {
    updateHitAreas();
    syncControlsToBackgroundTop();
  });
}

// ── Settings ────────────────────────────────────────────────────────────────
function applySettings(renderNow = true) {
  settings = normalizeSettings(settings);
  overlay.className = `overlay align-${settings.align} bg-${settings.bgStyle} palette-${settings.palette}${locked ? " locked" : ""}${overlay.classList.contains("bg-visible") ? " bg-visible" : ""}${overlay.classList.contains("settings-open") ? " settings-open" : ""}${settings.bilingual ? " bilingual" : ""}`;
  // bgOpacity is transparency: 0 means fully opaque (alpha 1), 1 means fully transparent.
  overlay.style.setProperty("--bg-alpha", String(1 - settings.bgOpacity));
  applyTextVariables(overlay, settings);
  saveSettings(settings);
  if (renderNow) renderSubtitles();
}

btnSettings.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  overlay.classList.add("bg-visible");
  overlay.classList.add("settings-open");
  invoke("set_subtitle_background_active", { active: true }).catch(console.error);
  await emit("subtitle-settings-open", settings);
  try {
    const rect = btnSettings.getBoundingClientRect();
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const scale = await win.scaleFactor();
    await invoke("show_subtitle_settings", {
      x: Math.round(pos.x + rect.right * scale + 8),
      y: Math.round(pos.y + rect.top * scale),
    });
  } catch (err) { console.error(err); }
});

listen("subtitle-settings-closed", () => {
  overlay.classList.remove("settings-open");
  scheduleFade();
});

listen<SubtitleSettings>("subtitle-settings-changed", async (event) => {
  const nextSettings = normalizeSettings(event.payload);
  const bilingualChanged = nextSettings.bilingual !== settings.bilingual;
  const historyChanged = nextSettings.historyRows !== settings.historyRows;
  settings = nextSettings;
  if (bilingualChanged || historyChanged) {
    resetSubtitleLayout();
  }
  applySettings(!bilingualChanged && !historyChanged);
  try { await invoke("set_subtitle_always_on_top", { alwaysOnTop: settings.alwaysOnTop }); } catch (err) { console.error(err); }
});

function resetSubtitleLayout() {
  if (resetRenderTimer) clearTimeout(resetRenderTimer);
  lyrics.classList.add("resetting");
  resetRenderTimer = setTimeout(() => {
    scrollStates = new WeakMap<HTMLElement, ScrollState>();
    lyrics.scrollTop = 0;
    lyrics.textContent = "";
    lastReadableNotifiedText = "";
    instantScrollLayout = true;
    renderSubtitles();
    requestAnimationFrame(() => {
      instantScrollLayout = false;
      lyrics.classList.remove("resetting");
    });
    resetRenderTimer = null;
  }, 140);
}

new ResizeObserver(([entry]) => {
  const { height } = entry.contentRect;
  const scale = Math.max(0.72, Math.min(1.85, height / 180));
  overlay.style.setProperty("--scale", scale.toFixed(3));
  syncControlsAfterLayout();
}).observe(overlay);

// ── Lock toggle ─────────────────────────────────────────────────────────────

btnLock.addEventListener("click", async (e) => {
  e.stopPropagation();
  locked = !locked;
  if (locked) {
    overlay.classList.remove("bg-visible");
    overlay.classList.remove("settings-open");
    invoke("set_subtitle_background_active", { active: false }).catch(console.error);
  } else {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    overlay.classList.add("bg-visible");
    invoke("set_subtitle_background_active", { active: true }).catch(console.error);
  }
  btnLock.innerHTML = locked
    ? '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  applySettings();
  try {
    await invoke("toggle_lock", { locked });
  } catch (err) {
    console.error("toggle_lock:", err);
  }
});

// ── Close ───────────────────────────────────────────────────────────────────
btnClose.addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    await invoke("close_subtitle_window");
  } catch (err) {
    console.error("close:", err);
  }
});

// ── Subtitle listener ───────────────────────────────────────────────────────
let renderScheduled = false;
listen<{
  history: { id?: number; o: string; t: string }[];
  curO: string;
  curT: string;
  bilingual: boolean;
}>("subtitle-update", (event) => {
  const { history, curO, curT } = event.payload;
  latestPayload = { history, curO, curT };
  const now = performance.now();
  if (!lastRenderTime || now - lastRenderTime > 1000) {
    if (renderCount > 0) console.log(`[DEBUG-rate] ${renderCount} renders in last 1s`);
    renderCount = 0;
    lastRenderTime = now;
  }
  renderCount++;
  postDebugLog("H1", "subtitles.ts:subtitle-update", "subtitle-update received", {
    renderScheduled,
    historyLen: history.length,
    historyTopId: history.length > 0 ? history[history.length - 1]?.id ?? null : null,
    curT: previewDebugText(curT, 20),
  });
  // Coalesce rapid updates: only render once per animation frame.
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(() => {
      postDebugLog("H1", "subtitles.ts:subtitle-update", "rAF callback executing", {
        historyLen: latestPayload.history.length,
        historyTopId: latestPayload.history.length > 0 ? latestPayload.history[latestPayload.history.length - 1]?.id ?? null : null,
        curT: previewDebugText(latestPayload.curT, 20),
      });
      renderScheduled = false;
      renderSubtitles();
    });
  }
});

function renderSubtitles() {
  const { history, curO, curT } = latestPayload;
  // Capture the live current-trans node BEFORE any DOM mutation. If that text
  // becomes a new history line, we re-parent the same node (true continuous
  // scale/move) instead of creating a separate small history element.
  const outgoingCurrent = lyrics.querySelector<HTMLElement>(
    '[data-key="current"] .line.trans.cur:not(.pending)',
  );
  const outgoingText = outgoingCurrent ? lineText(outgoingCurrent).trim() : "";
  const outgoingFirst = outgoingCurrent && outgoingText && outgoingText !== "\u00a0"
    ? snapshotLineRect(outgoingCurrent)
    : null;
  const previousHistorySnapshots = captureHistoryLineSnapshots();
  const currentLineOffsets = captureCurrentLineOffsets();
  const frame = buildCaptionFrame(
    { history, curO, curT },
    { bilingual: settings.bilingual, historyRows: settings.historyRows },
  );
  postDebugLog("H1", "subtitles.ts:renderSubtitles", "render start", {
    historyLen: history.length,
    visibleHistory: frame.historyRows.map((line) => ({
      key: line.key ?? null,
      t: previewDebugText(line.text, 16),
      age: line.age ?? null,
    })),
    curO: previewDebugText(curO, 16),
    curT: previewDebugText(curT, 16),
    currentOffsets: Array.from(currentLineOffsets.entries()).map(([text, offset]) => [previewDebugText(text, 12), offset]),
  });
  const historyGroup = ensureGroup("history", "line-group history-group");
  const historyLines: SubtitleRenderLine[] = frame.historyRows.map((row) => ({
    key: row.key,
    text: row.text,
    className: row.className,
    staticOffset: currentLineOffsets.get(row.text),
  }));
  const promoteCandidate =
    outgoingCurrent && outgoingFirst && shouldPromoteCurrentToHistory(outgoingText, frame.historyRows)
      ? { node: outgoingCurrent, first: outgoingFirst, text: outgoingText }
      : null;
  const historySync = syncHistoryLines(historyGroup, historyLines, promoteCandidate);
  setGroupHidden(historyGroup, !frame.showHistory);

  const currentGroup = ensureGroup("current", "line-group current-group");
  const currentLines: SubtitleRenderLine[] = frame.currentRows.map((row) => ({
    text: row.text,
    className: row.className,
  }));
  syncLines(currentGroup, currentLines);
  setGroupHidden(currentGroup, !frame.showCurrent);

  const emptyGroup = ensureGroup("empty", "line-group current-group");
  if (frame.showEmpty) {
    syncLines(emptyGroup, frame.emptyRows.map((row) => ({ text: row.text, className: row.className })));
  } else {
    syncLines(emptyGroup, []);
  }
  setGroupHidden(emptyGroup, !frame.showEmpty);

  lyrics.appendChild(historyGroup);
  lyrics.appendChild(currentGroup);
  lyrics.appendChild(emptyGroup);

  lyrics.scrollTop = 0;
  // FLIP any line that was re-parented from current → history.
  for (const promoted of historySync.promoted) {
    playNodePromoteFlip(promoted.node, promoted.first);
  }
  playHistoryLayoutFlips(historySync.retained, previousHistorySnapshots);
  syncControlsAfterLayout();
}

type SubtitleRenderLine = { key?: string; text: string; className: string; staticOffset?: number };

function ensureGroup(key: string, className: string) {
  let group = lyrics.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!group) {
    group = document.createElement("div");
    group.dataset.key = key;
  }
  group.className = className;
  return group;
}

function setGroupHidden(group: HTMLElement, hidden: boolean) {
  group.hidden = hidden;
  if (hidden) clearExitingLines(group);
}

function clearExitingLines(parent: HTMLElement) {
  parent.querySelectorAll<HTMLElement>('[data-exit="1"]').forEach((line) => line.remove());
}

function syncLines(parent: HTMLElement, lines: SubtitleRenderLine[]) {
  if (parent.dataset.key === "history") {
    syncHistoryLines(parent, lines);
    return;
  }
  const children = activeLineChildren(parent);
  while (children.length > lines.length) {
    const child = children.pop();
    if (child) markLineExiting(parent, child);
  }
  for (let i = 0; i < lines.length; i++) {
    let el = children[i];
    const isNew = !el;
    if (!el) {
      el = document.createElement("div");
      const isPending = lines[i].className.includes("pending");
      el.className = isPending ? lines[i].className : `${lines[i].className} entering`;
      parent.appendChild(el);
      if (!isPending) {
        const enterDuration = 260;
        window.setTimeout(() => {
          el?.classList.remove("entering");
        }, enterDuration);
      }
    }
    const wasPending = el.classList.contains("pending");
    if (!isNew && baseLineClass(el) !== lines[i].className) {
      const enteringClass = el.classList.contains("entering") ? " entering" : "";
      el.className = `${lines[i].className}${enteringClass}`;
    }
    const enteredFromPending = wasPending && !el.classList.contains("pending");
    if (enteredFromPending) {
      el.classList.add("entering");
      window.setTimeout(() => el?.classList.remove("entering"), 320);
    }
    const text = ensureLineText(el);
    const previousText = text.textContent || "";
    const textChanged = previousText !== lines[i].text;
    if (
      parent.dataset.key === "current"
      && !enteredFromPending
      && textChanged
      && shouldResetScrollOnNonContinuation(previousText, lines[i].text)
    ) {
      text.textContent = lines[i].text;
      text.style.transform = "translateX(0)";
      el.classList.remove("rolling");
      delete el.dataset.speedCap;
      const existing = scrollStates.get(el);
      if (existing && existing.raf !== null) cancelAnimationFrame(existing.raf);
      scrollStates.set(el, { rawTarget: 0, target: 0, offset: 0, velocity: 0, raf: null, lastTime: 0, lastTextWidth: 0, holdUntil: 0, hasReadableText: false, speedCapped: false });
      requestAnimationFrame(() => updateLineOverflow(el, text));
      continue;
    }
    if (textChanged) {
      text.textContent = lines[i].text;
      // Flag Chinese lines that receive a large character burst for speed capping.
      if (parent.dataset.key === "current" && lines[i].className.includes("trans")) {
        const delta = lines[i].text.length - previousText.length;
        if (hasCJK(lines[i].text) && delta > SPEED_CAP_DELTA_THRESHOLD) {
          el.dataset.speedCap = "1";
        }
      }
    }
    const staticOffset = lines[i].staticOffset;
    if (staticOffset !== undefined) {
      applyStaticOffset(el, text, staticOffset);
    }
    requestAnimationFrame(() => updateLineOverflow(el, text));
  }
}

function syncHistoryLines(
  parent: HTMLElement,
  lines: SubtitleRenderLine[],
  promoteCandidate: { node: HTMLElement; first: LineRectSnapshot; text: string } | null = null,
) {
  const children = activeLineChildren(parent);
  const used = new Set<HTMLElement>();
  const ordered: HTMLElement[] = [];
  const retained: HTMLElement[] = [];
  const promoted: { node: HTMLElement; first: LineRectSnapshot }[] = [];
  let promoteUsed = false;

  for (const line of lines) {
    const key = line.key || line.text;
    let el = children.find((child) => !used.has(child) && child.dataset.lineKey === key);
    let isPromoted = false;

    if (!el && promoteCandidate && !promoteUsed && promoteCandidate.text === line.text) {
      // Re-parent the live current-trans node into history (same DOM element).
      el = promoteCandidate.node;
      const wasRolling = el.classList.contains("rolling");
      el.dataset.lineKey = key;
      el.className = line.className;
      el.classList.remove("cur", "pending", "entering", "history-entering");
      if (wasRolling) {
        // Preserve the edge mask during the FLIP so a long current line cannot
        // flash its full unclipped text before it reaches the history row.
        el.classList.add("rolling");
        el.dataset.promotingRolling = "1";
      }
      const existing = scrollStates.get(el);
      if (existing?.raf !== null && existing?.raf !== undefined) cancelAnimationFrame(existing.raf);
      scrollStates.delete(el);
      const textNode = ensureLineText(el);
      promoted.push({ node: el, first: promoteCandidate.first });
      promoteUsed = true;
      isPromoted = true;
      attachHistoryAnimationDebug(el);
    }

    if (!el) {
      el = document.createElement("div");
      el.dataset.lineKey = key;
      el.className = line.className;
      attachHistoryAnimationDebug(el);
    } else if (!isPromoted) {
      el.dataset.lineKey = key;
      if (baseLineClass(el) !== line.className) el.className = line.className;
      retained.push(el);
    }

    const text = ensureLineText(el);
    if (text.textContent !== line.text) text.textContent = line.text;
    if (!el.parentElement || el.parentElement !== parent) parent.appendChild(el);
    if (line.staticOffset !== undefined) applyStaticOffset(el, text, line.staticOffset);
    used.add(el);
    ordered.push(el);
    if (!isPromoted) requestAnimationFrame(() => updateLineOverflow(el, text));
  }

  for (const child of children) {
    if (!used.has(child)) markLineExiting(parent, child);
  }
  for (const child of ordered) parent.appendChild(child);
  return { retained, promoted };
}

function applyStaticOffset(line: HTMLElement, text: HTMLElement, offset: number) {
  const clampedOffset = clampHistoryStaticOffset(offset, line.clientWidth, text.scrollWidth);
  text.style.transform = `translateX(${clampedOffset}px)`;
}

function captureCurrentLineOffsets() {
  const offsets = new Map<string, number>();
  const currentLines = lyrics.querySelectorAll<HTMLElement>('[data-key="current"] .line.cur');
  currentLines.forEach((line) => {
    const text = line.querySelector<HTMLElement>(".line-text");
    if (!text?.textContent) return;
    offsets.set(text.textContent, currentTranslateX(text));
  });
  return offsets;
}

function snapshotLineRect(line: HTMLElement): LineRectSnapshot {
  const rect = line.getBoundingClientRect();
  const fontSize = parseFloat(getComputedStyle(line).fontSize) || rect.height || 1;
  return {
    left: rect.left,
    top: rect.top,
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1),
    fontSize,
  };
}

function captureHistoryLineSnapshots() {
  const snapshots = new Map<string, LineRectSnapshot>();
  const historyLines = lyrics.querySelectorAll<HTMLElement>('[data-key="history"] .line:not([data-exit="1"])');
  historyLines.forEach((line) => {
    const key = line.dataset.lineKey;
    if (!key) return;
    snapshots.set(key, snapshotLineRect(line));
  });
  return snapshots;
}

function clearLineMotionStyles(line: HTMLElement) {
  line.style.transition = "";
  line.style.transform = "";
  line.style.transformOrigin = "";
  line.style.opacity = "";
  line.style.zIndex = "";
  line.style.willChange = "";
  line.style.fontSize = "";
  line.style.fontWeight = "";
  line.style.overflow = "";
  if (line.dataset.promotingRolling === "1") {
    line.classList.remove("rolling");
    delete line.dataset.promotingRolling;
  }
  delete line.dataset.promoting;
  delete line.dataset.layoutFlip;
}

function playNodePromoteFlip(node: HTMLElement, first: LineRectSnapshot) {
  if (instantScrollLayout) return;
  void node.offsetWidth;
  const last = snapshotLineRect(node);
  const deltaX = first.left - last.left;
  const deltaY = first.top - last.top;
  const scale = first.fontSize / Math.max(last.fontSize, 1);
  node.dataset.promoting = "1";
  node.style.willChange = "transform";
  node.style.transformOrigin = "left top";
  node.style.zIndex = "5";
  // Keep overflow clipped while scaling a long current line into history.
  // Making it visible exposes the full unscrolled sentence for one frame.
  node.style.overflow = "hidden";
  node.style.transition = "none";
  node.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scale})`;
  void node.offsetWidth;
  const animation = node.animate(
    [
      { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scale})` },
      { transform: "translate(0px, 0px) scale(1)" },
    ],
    {
      duration: HISTORY_PROMOTE_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "forwards",
    },
  );
  const finish = () => {
    clearLineMotionStyles(node);
    try { animation.cancel(); } catch {}
  };
  animation.addEventListener("finish", finish);
  animation.addEventListener("cancel", finish);
  window.setTimeout(finish, HISTORY_PROMOTE_MS + 60);
}

function playHistoryLayoutFlips(retainedLines: HTMLElement[], previous: Map<string, LineRectSnapshot>) {
  if (retainedLines.length === 0 || previous.size === 0 || instantScrollLayout) return;
  for (const line of retainedLines) {
    if (line.dataset.promoting === "1") continue;
    const key = line.dataset.lineKey;
    if (!key) continue;
    const first = previous.get(key);
    if (!first) continue;
    const last = snapshotLineRect(line);
    const deltaX = first.left - last.left;
    const deltaY = first.top - last.top;
    const scale = first.fontSize / Math.max(last.fontSize, 1);
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 && Math.abs(scale - 1) < 0.02) continue;
    line.dataset.layoutFlip = "1";
    line.style.willChange = "transform";
    line.style.transformOrigin = "left top";
    line.style.transition = "none";
    line.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${scale})`;
    void line.offsetWidth;
    const animation = line.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px) scale(${scale})` },
        { transform: "translate(0px, 0px) scale(1)" },
      ],
      {
        duration: HISTORY_LAYOUT_FLIP_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "forwards",
      },
    );
    const finish = () => {
      clearLineMotionStyles(line);
      try { animation.cancel(); } catch {}
    };
    animation.addEventListener("finish", finish);
    animation.addEventListener("cancel", finish);
    window.setTimeout(finish, HISTORY_LAYOUT_FLIP_MS + 60);
  }
}

function currentTranslateX(element: HTMLElement) {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  const match = transform.match(/^matrix\(([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+),/);
  return match ? Number(match[5]) || 0 : 0;
}

function activeLineChildren(parent: HTMLElement) {
  return Array.from(parent.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.exit !== "1");
}

function lineText(line: HTMLElement) {
  return line.querySelector<HTMLElement>(".line-text")?.textContent || line.textContent || "";
}

function markLineExiting(parent: HTMLElement, line: HTMLElement) {
  if (line.dataset.exit === "1") return;
  postDebugLog("H4", "subtitles.ts:markLineExiting", "line exiting", {
    key: line.dataset.lineKey ?? "",
    className: line.className,
    text: previewDebugText(lineText(line), 18),
  });
  const clone = line.cloneNode(true) as HTMLElement;
  const parentRect = parent.getBoundingClientRect();
  const rect = line.getBoundingClientRect();
  clone.dataset.exit = "1";
  clone.classList.remove("entering", "history-entering", "rolling");
  clone.classList.add("line-exiting");
  clone.style.position = "absolute";
  clone.style.left = "0";
  clone.style.right = "0";
  clone.style.top = `${rect.top - parentRect.top}px`;
  clone.style.pointerEvents = "none";
  parent.appendChild(clone);
  postDebugLog("H4", "subtitles.ts:markLineExiting", "append exit clone", {
    key: line.dataset.lineKey ?? "",
    top: clone.style.top,
    className: clone.className,
  });
  window.setTimeout(() => clone.remove(), 360);
  line.remove();
}

function baseLineClass(line: HTMLElement) {
  return Array.from(line.classList)
    .filter((className) => className !== "entering" && className !== "history-entering" && className !== "rolling")
    .join(" ");
}

function ensureLineText(line: HTMLElement) {
  let text = line.firstElementChild as HTMLElement | null;
  if (!text || !text.classList.contains("line-text")) {
    const value = line.textContent || "";
    line.textContent = "";
    text = document.createElement("span");
    text.className = "line-text";
    text.textContent = value;
    line.appendChild(text);
  }
  return text;
}

function updateLineOverflow(line: HTMLElement, text: HTMLElement) {
  const shouldTrack = line.classList.contains("cur") && text.scrollWidth > 0;
  const hasReadableText = Boolean(text.textContent?.trim());
  const rawTarget = computeScrollRawTarget({
    lineClientWidth: line.clientWidth,
    textScrollWidth: text.scrollWidth,
    isCurrentLine: shouldTrack,
    hasText: hasReadableText,
  });
  line.classList.toggle("rolling", rawTarget < 0);
  const lineContent = text.textContent || "";
  // Content changed: require a new readable notification once scroll settles again.
  if (
    line.classList.contains("cur")
    && line.classList.contains("trans")
    && lineContent.trim()
    && lineContent !== lastReadableNotifiedText
  ) {
    lastReadableNotifiedText = "";
  }
  if (!shouldTrack) {
    const existing = scrollStates.get(line);
    if (existing && existing.raf !== null) cancelAnimationFrame(existing.raf);
    scrollStates.set(line, { rawTarget: 0, target: 0, offset: 0, velocity: 0, raf: null, lastTime: 0, lastTextWidth: text.scrollWidth, holdUntil: 0, hasReadableText, speedCapped: false });
    // Not the active current scroller (pending/orig): do not signal readable.
    return;
  }
  if (instantScrollLayout) {
    scrollStates.set(line, { rawTarget, target: rawTarget, offset: rawTarget, velocity: 0, raf: null, lastTime: 0, lastTextWidth: text.scrollWidth, holdUntil: 0, hasReadableText, speedCapped: false });
    const clamped = clampTranslateX(rawTarget, rawTarget);
    text.style.transform = `translateX(${clamped}px)`;
    if (
      isCurrentLineReadable({
        isCurrentTrans: line.classList.contains("trans"),
        text: text.textContent || "",
        rawTarget,
        offset: clamped,
        velocity: 0,
      })
    ) {
      // Instant layout / no overflow: last char is already in view.
      notifyCurrentLineReadable(text.textContent || "");
    }
    return;
  }
  const existingState = scrollStates.get(line);
  const state = existingState ?? { rawTarget, target: 0, offset: 0, velocity: 0, raf: null, lastTime: 0, lastTextWidth: text.scrollWidth, holdUntil: hasReadableText ? performance.now() + SCROLL_READ_HOLD_MS : 0, hasReadableText, speedCapped: false };
  const holdUntil = computeScrollHoldUntil({
    previousHadReadableText: state.hasReadableText,
    nowHasReadableText: hasReadableText,
    nowMs: performance.now(),
  });
  if (holdUntil > 0) {
    state.holdUntil = holdUntil;
    if (line.classList.contains("trans")) lastReadableNotifiedText = "";
  }
  // Growing / changing target means the last char is not settled yet.
  const targetMoved = Math.abs(state.rawTarget - rawTarget) > 0.5;
  if (targetMoved && line.classList.contains("trans")) {
    lastReadableNotifiedText = "";
  }
  state.hasReadableText = hasReadableText;
  state.rawTarget = rawTarget;
  if (line.dataset.speedCap === "1") {
    state.speedCapped = true;
    delete line.dataset.speedCap;
  }
  scrollStates.set(line, state);
  if (state.raf === null) {
    state.raf = requestAnimationFrame((time) => animateLineScroll(line, text, time));
  }
}

function animateLineScroll(line: HTMLElement, text: HTMLElement, time: number) {
  const state = scrollStates.get(line);
  if (!state) return;
  if (time < state.holdUntil) {
    state.lastTime = time;
    state.raf = requestAnimationFrame((nextTime) => animateLineScroll(line, text, nextTime));
    return;
  }
  const dt = state.lastTime > 0 ? Math.min(Math.max((time - state.lastTime) / 1000, 1 / 240), 1 / 20) : 1 / 60;
  const width = Math.max(line.clientWidth, 1);
  const targetBlend = 1 - Math.exp(-dt / SCROLL_TARGET_TAU);
  state.target += (state.rawTarget - state.target) * targetBlend;
  const diff = state.target - state.offset;
  const growthSpeed = Math.max(0, text.scrollWidth - state.lastTextWidth) / dt;
  const curveSpeed = Math.tanh(diff / Math.max(width * SCROLL_SOFTNESS_RATIO, 1)) * width * SCROLL_MAX_SPEED_RATIO;
  const desiredVelocity = diff < 0 ? curveSpeed - growthSpeed * SCROLL_TEXT_GROWTH_GAIN : curveSpeed;
  const blend = 1 - Math.exp(-dt / SCROLL_VELOCITY_TAU);
  state.velocity += (desiredVelocity - state.velocity) * blend;
  // Cap scroll speed when a large CJK burst was detected during layout.
  if (state.speedCapped) {
    const charWidth = parseFloat(getComputedStyle(line).fontSize) || 16;
    const maxVelocityPx = SCROLL_MAX_CHAR_SPEED * charWidth;
    if (state.velocity < -maxVelocityPx) state.velocity = -maxVelocityPx;
    if (state.velocity > maxVelocityPx) state.velocity = maxVelocityPx;
  }
  state.offset += state.velocity * dt;
  if (state.velocity < 0 && state.offset < state.target) state.offset = state.target;
  if (state.velocity > 0 && state.offset > state.target) state.offset = state.target;
  state.offset = clampTranslateX(state.offset, state.rawTarget);
  text.style.transform = `translateX(${state.offset}px)`;
  state.lastTime = time;
  state.lastTextWidth = text.scrollWidth;

  if (Math.abs(state.rawTarget - state.offset) < 0.5 && Math.abs(state.velocity) < 2) {
    state.target = state.rawTarget;
    state.offset = state.rawTarget;
    text.style.transform = `translateX(${state.offset}px)`;
    state.velocity = 0;
    state.raf = null;
    state.lastTime = 0;
    state.speedCapped = false;
    if (
      line.classList.contains("cur")
      && isCurrentLineReadable({
        isCurrentTrans: line.classList.contains("trans"),
        text: text.textContent || "",
        rawTarget: state.rawTarget,
        offset: state.offset,
        velocity: 0,
      })
    ) {
      notifyCurrentLineReadable(text.textContent || "");
    }
    return;
  }
  state.raf = requestAnimationFrame((nextTime) => animateLineScroll(line, text, nextTime));
}

function notifyCurrentLineReadable(text: string) {
  const value = text.trim();
  if (!value || value === "\u00a0") return;
  if (value === lastReadableNotifiedText) return;
  lastReadableNotifiedText = value;
  emit("current-line-readable", { text: value }).catch(() => {});
}

applySettings();
