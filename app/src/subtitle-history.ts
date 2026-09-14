import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  buildHistoryRows,
  historyRowCopyValue,
  isHistoryMode,
  isHistoryRevisionFresh,
  type HistoryLine,
  type HistoryMode,
} from "./subtitle-history-utils";
import type { QuickRecord } from "./quick-records";

const historyList = document.getElementById("history-list")!;
const historyBody = document.getElementById("history-body")!;
const emptyState = document.getElementById("empty-state")!;
const emptyTitle = document.getElementById("empty-title")!;
const historyCount = document.getElementById("history-count")!;
const historySessionTitle = document.getElementById("history-session-title")!;
const sessionList = document.getElementById("session-list")!;
const sessionCount = document.getElementById("session-count")!;
const copyAll = document.getElementById("copy-all") as HTMLButtonElement;
const copyAllText = document.getElementById("copy-all-text")!;
const clearHistory = document.getElementById("clear-history") as HTMLButtonElement;
const closeButton = document.getElementById("btn-close") as HTMLButtonElement;
const aiAlign = document.getElementById("ai-align") as HTMLButtonElement;
const aiSummary = document.getElementById("ai-summary") as HTMLButtonElement;
const historyOperationStatus = document.getElementById("history-operation-status")!;
const clearDialog = document.getElementById("clear-dialog")!;
const clearSessionWarning = document.getElementById("clear-session-warning")!;
const cancelClear = document.getElementById("cancel-clear") as HTMLButtonElement;
const confirmClear = document.getElementById("confirm-clear") as HTMLButtonElement;
const sessionContextMenu = document.getElementById("session-context-menu") as HTMLElement;
const mergeSessionAction = document.getElementById("merge-session-action") as HTMLButtonElement;
const sentenceContextMenu = document.getElementById("sentence-context-menu") as HTMLElement;
const sentenceEditDialog = document.getElementById("sentence-edit-dialog") as HTMLElement;
const sentenceEditList = document.getElementById("sentence-edit-list") as HTMLElement;
const cancelSentenceEdit = document.getElementById("cancel-sentence-edit") as HTMLButtonElement;
const saveSentenceEdit = document.getElementById("save-sentence-edit") as HTMLButtonElement;
const sentenceDeleteDialog = document.getElementById("sentence-delete-dialog") as HTMLElement;
const sentenceDeleteWarning = document.getElementById("sentence-delete-warning") as HTMLElement;
const cancelSentenceDelete = document.getElementById("cancel-sentence-delete") as HTMLButtonElement;
const confirmSentenceDelete = document.getElementById("confirm-sentence-delete") as HTMLButtonElement;

let history: HistoryLine[] = [];
let current: HistoryLine = { o: "", t: "" };
let records: QuickRecord[] = [];
let markedSentenceIds = new Set<number>();
let editedSentenceIds = new Set<number>();
let currentSessionId = "";
let latestHistoryRevision = 0;
let readOnly = true;
let liveRunning = false;
let aiAlignmentRunning = false;
let alignmentCancelRequested = false;
type SessionSummary = { id: string; startedAt: string; endedAt: string | null; sentenceCount: number; recordCount: number; active: boolean };
let sessions: SessionSummary[] = [];
let selectedSessionId = "";
let selectedSessionIds = new Set<string>();
let lastSessionIndex = -1;
let expandedRecordKey = "";
let mode = loadMode();
let followBottom = true;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let recordDrawerCloseTimer: ReturnType<typeof setTimeout> | null = null;
const recordOptimizeRequests = new Map<string, string>();
type AiAction = "align" | "summary";
let aiBusy: AiAction | null = null;

const aiButtons: Record<AiAction, HTMLButtonElement> = {
  align: aiAlign,
  summary: aiSummary,
};
const aiButtonLabels: Record<AiAction, string> = {
  align: "AI 对齐",
  summary: "AI 总结",
};
const aiButtonTitles: Record<AiAction, string> = {
  align: "使用总结模型优化中英对齐",
  summary: "使用总结模型生成总结",
};

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" fill="none"/><path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1" fill="none"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none"/></svg>';
const FLAG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4m1 1h10l-2 4 2 4H7" fill="none"/></svg>';
const COMMENT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5Z" fill="none"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" fill="none"/></svg>';
const SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4L22 2Z" fill="none"/><path d="M22 2 11 13" fill="none"/></svg>';
const AI_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.25 4.75L18 9l-4.75 1.25L12 15l-1.25-4.75L6 9l4.75-1.25L12 3ZM19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7L19 14Z" fill="none"/></svg>';

document.body.dataset.mode = mode;

document.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextMode = button.dataset.mode;
    if (!isHistoryMode(nextMode)) return;
    mode = nextMode;
    localStorage.setItem("mt-history-mode", mode);
    document.body.dataset.mode = mode;
    applyModeButtons();
    renderHistory();
  });
});

historyList.addEventListener("scroll", () => {
  followBottom = isAtBottom();
});

aiAlign.addEventListener("click", () => {
  if (aiAlignmentRunning) {
    void emit("subtitle-history-ai-align-cancel", {});
    return;
  }
  startAiAction("align");
});

aiSummary.addEventListener("click", () => startAiAction("summary"));

listen<{ sessions: SessionSummary[]; selectedSessionId: string; revision?: number }>("subtitle-history-sessions", (event) => {
  if (!acceptHistoryRevision(event.payload.revision)) return;
  sessions = event.payload.sessions || [];
  selectedSessionId = event.payload.selectedSessionId || "";
  if (!selectedSessionIds.has(selectedSessionId)) selectedSessionIds = new Set(selectedSessionId ? [selectedSessionId] : []);
  renderSessionList();
  updateHistorySessionTitle();
});

listen<{ history: HistoryLine[]; curO: string; curT: string; curId?: number | null; sessionId?: string; readOnly?: boolean; liveRunning?: boolean; aiAlignmentRunning?: boolean; records?: QuickRecord[]; markedSentenceIds?: number[]; editedIds?: number[]; revision?: number }>("subtitle-history-update", (event) => {
  if (!acceptHistoryRevision(event.payload.revision)) return;
  const nextHistory = event.payload.history || [];
  const nextCurrent = { id: event.payload.curId ?? undefined, o: event.payload.curO || "", t: event.payload.curT || "" };
  const nextSessionId = event.payload.sessionId || "";
  const recordsOnlyUpdate = currentSessionId === nextSessionId &&
    JSON.stringify([history, current]) === JSON.stringify([nextHistory, nextCurrent]);
  history = nextHistory;
  current = nextCurrent;
  records = event.payload.records || [];
  markedSentenceIds = new Set(event.payload.markedSentenceIds || []);
  editedSentenceIds = new Set(event.payload.editedIds || []);
  currentSessionId = nextSessionId;
  readOnly = event.payload.readOnly !== false;
  liveRunning = event.payload.liveRunning === true;
  aiAlignmentRunning = event.payload.aiAlignmentRunning === true;
  clearHistory.disabled = !nextSessionId;
  updateOperationUi();
  if (recordsOnlyUpdate) {
    updateRecordIndicators();
    updateOpenRecordDrawer();
  } else {
    renderHistory();
  }
});

listen<{ running: boolean }>("subtitle-history-live-state", (event) => {
  liveRunning = event.payload.running === true;
  updateOperationUi();
});

function acceptHistoryRevision(revision?: number) {
  if (!isHistoryRevisionFresh(latestHistoryRevision, revision)) return false;
  if (revision !== undefined) latestHistoryRevision = revision;
  return true;
}

listen<{ action: AiAction; running: boolean; message?: string; cancelRequested?: boolean }>("history-ai-state", (event) => {
  const { action, running, cancelRequested } = event.payload;
  if (running) {
    if (action === "align") {
      aiAlignmentRunning = true;
      alignmentCancelRequested = cancelRequested === true;
    }
    setAiRunning(action);
  } else {
    if (action === "align") {
      aiAlignmentRunning = false;
      alignmentCancelRequested = false;
    }
    setAiIdle(action);
  }
  updateOperationUi();
});

listen<{ action: AiAction; message: string }>("history-ai-error", (event) => {
  setAiError(event.payload.action, event.payload.message);
});

listen<{ requestId: string; success: boolean; text?: string; message?: string }>("subtitle-history-record-optimize-result", (event) => {
  const recordKey = recordOptimizeRequests.get(event.payload.requestId);
  if (!recordKey) return;
  recordOptimizeRequests.delete(event.payload.requestId);
  const panel = historyBody.querySelector<HTMLElement>(".inline-record-details");
  if (!panel || panel.dataset.recordKey !== recordKey) return;
  const optimize = panel.querySelector<HTMLButtonElement>(".inline-record-compose-ai");
  if (!optimize) return;
  optimize.classList.remove("is-running");
  optimize.removeAttribute("aria-busy");
  if (!event.payload.success) {
    optimize.title = `AI 优化失败：${event.payload.message || "未知错误"}`;
    updateComposeButtons(panel);
    return;
  }
  const input = panel.querySelector<HTMLTextAreaElement>(".inline-record-compose textarea");
  if (!input || !event.payload.text) return;
  input.value = event.payload.text;
  optimize.title = "AI 优化备注";
  updateComposeButtons(panel);
});

function startAiAction(action: AiAction) {
  if (action === "align" && liveRunning) {
    setAiError(action, "实时翻译进行中，无法对齐");
    return;
  }
  if (action === "align") {
    aiAlignmentRunning = true;
    alignmentCancelRequested = false;
  }
  setAiRunning(action);
  void emit(action === "align" ? "subtitle-history-ai-align" : "subtitle-history-ai-summary", { sessionId: selectedSessionId || undefined });
}

function setAiRunning(action: AiAction) {
  aiBusy = action;
  (Object.keys(aiButtons) as AiAction[]).forEach((key) => {
    const button = aiButtons[key];
    button.disabled = true;
    button.classList.toggle("is-running", key === action);
    button.classList.remove("is-error");
    button.setAttribute("aria-busy", key === action ? "true" : "false");
    button.setAttribute("aria-label", key === action ? `${aiButtonLabels[key]}进行中` : aiButtonLabels[key]);
    button.title = key === action ? `${aiButtonLabels[key]}进行中` : aiButtonTitles[key];
  });
  updateOperationUi();
}

function setAiIdle(action: AiAction) {
  aiBusy = null;
  (Object.keys(aiButtons) as AiAction[]).forEach((key) => {
    const button = aiButtons[key];
    button.disabled = false;
    button.classList.remove("is-running");
    if (key === action) button.classList.remove("is-error");
    button.setAttribute("aria-busy", "false");
    button.setAttribute("aria-label", aiButtonLabels[key]);
    button.title = aiButtonTitles[key];
  });
  updateOperationUi();
}

function setAiError(action: AiAction, message: string) {
  if (action === "align") {
    aiAlignmentRunning = false;
    alignmentCancelRequested = false;
  }
  aiBusy = null;
  (Object.keys(aiButtons) as AiAction[]).forEach((key) => {
    const button = aiButtons[key];
    button.disabled = false;
    button.classList.remove("is-running");
    button.classList.toggle("is-error", key === action);
    button.setAttribute("aria-busy", "false");
    button.setAttribute("aria-label", key === action ? `${aiButtonLabels[key]}失败，点击重试` : aiButtonLabels[key]);
    button.title = key === action ? `${message}，点击重试` : aiButtonTitles[key];
  });
  updateOperationUi();
}

function updateOperationUi() {
  const editingLocked = readOnly || aiAlignmentRunning;
  const alignRunning = aiAlignmentRunning || aiBusy === "align";
  const canAlign = !liveRunning && !aiBusy;
  aiAlign.disabled = alignRunning ? false : !canAlign;
  aiSummary.disabled = Boolean(aiBusy);
  aiAlign.classList.toggle("is-running", alignRunning);
  aiAlign.classList.toggle("is-cancel-requested", alignmentCancelRequested);
  aiAlign.querySelector<HTMLElement>(".ai-btn-label")!.textContent = alignRunning
    ? alignmentCancelRequested ? "正在停止" : "停止对齐"
    : "AI 对齐";
  aiAlign.title = alignRunning
    ? alignmentCancelRequested ? "正在停止 AI 对齐" : "停止 AI 对齐"
    : liveRunning ? "实时翻译进行中，无法进行 AI 对齐" : aiButtonTitles.align;
  historyOperationStatus.hidden = !liveRunning;
  if (liveRunning) {
    historyOperationStatus.textContent = "实时翻译进行中，AI 对齐暂不可用";
    historyOperationStatus.className = "history-operation-status is-live";
  }
  clearHistory.disabled = aiAlignmentRunning || !currentSessionId;
  updateSessionContextMenu();
  sentenceContextMenu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = aiAlignmentRunning;
    button.title = aiAlignmentRunning ? "AI 对齐进行中，无法编辑" : "";
  });
  if (aiAlignmentRunning) {
    if (!sentenceEditDialog.hidden) sentenceEditDialog.hidden = true;
    if (!sentenceDeleteDialog.hidden) closeSentenceDeleteDialog();
    if (!clearDialog.hidden) clearDialog.hidden = true;
  }
  document.querySelectorAll<HTMLButtonElement>(".row-record").forEach((button) => {
    button.disabled = aiAlignmentRunning;
  });
  document.querySelectorAll<HTMLTextAreaElement>(".inline-record-compose textarea, .inline-record-editor").forEach((input) => { input.disabled = editingLocked; });
  updateOpenRecordDrawer();
}

copyAll.addEventListener("click", async () => {
  const rows = buildHistoryRows(getTranscript(), mode, editedSentenceIds);
  const text = rows.map((row) => historyRowCopyValue(row, mode)).join("");
  if (!text) return;
  await copyText(text);
  copyAllText.textContent = "已复制";
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => {
    copyAllText.textContent = "复制全部";
    copyFeedbackTimer = null;
  }, 1200);
});

clearHistory.addEventListener("click", () => {
  if (!selectedSessionId || aiAlignmentRunning) return;
  openDeleteDialog(selectedSessionId);
});

cancelClear.addEventListener("click", () => {
  clearDialog.hidden = true;
});

confirmClear.addEventListener("click", async () => {
  clearDialog.hidden = true;
  const sessionIds = Array.from(selectedSessionIds);
  if (!sessionIds.length) return;
  await emit("subtitle-history-session-delete", { sessionIds });
});

clearDialog.addEventListener("pointerdown", (event) => {
  if (event.target === clearDialog) clearDialog.hidden = true;
});

sessionList.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-id]");
  if (!target) return;
  const sessionId = target.dataset.sessionId || "";
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return;

  if (event instanceof MouseEvent && event.shiftKey && lastSessionIndex >= 0) {
    const start = Math.min(lastSessionIndex, index);
    const end = Math.max(lastSessionIndex, index);
    selectedSessionIds = new Set(sessions.slice(start, end + 1).map((session) => session.id));
  } else if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey)) {
    const next = new Set(selectedSessionIds);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    selectedSessionIds = next;
  } else {
    selectedSessionIds = new Set([sessionId]);
  }
  lastSessionIndex = index;
  selectedSessionId = sessionId;
  void emit("subtitle-history-session-select", { sessionId });
  renderSessionList();
  updateHistorySessionTitle();
});

sessionList.addEventListener("contextmenu", (event) => {
  if (aiAlignmentRunning) return;
  event.preventDefault();
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-session-id]");
  if (!target) return;
  const sessionId = target.dataset.sessionId || "";
  if (!selectedSessionIds.has(sessionId)) selectedSessionIds = new Set([sessionId]);
  selectedSessionId = sessionId;
  renderSessionList();
  updateHistorySessionTitle();
  updateSessionContextMenu();
  positionSessionContextMenu(event.clientX, event.clientY);
});

function positionContextMenu(menu: HTMLElement, clientX: number, clientY: number) {
  const margin = 6;
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = clientX;
  let top = clientY;
  if (left + width + margin > window.innerWidth) left = clientX - width - margin;
  if (top + height + margin > window.innerHeight) top = clientY - height - margin;
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function positionSessionContextMenu(clientX: number, clientY: number) {
  positionContextMenu(sessionContextMenu, clientX, clientY);
}

let sentenceContextIds: number[] = [];

historyList.addEventListener("contextmenu", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-source-ids]");
  if (!target) return;
  const ids = (target.dataset.sourceIds || "").split(",").map(Number).filter((id) => id > 0);
  if (!ids.length || ids.length > 8) return;
  event.preventDefault();
  sentenceContextIds = ids;
  positionContextMenu(sentenceContextMenu, event.clientX, event.clientY);
});

sessionContextMenu.addEventListener("click", (event) => {
  if (aiAlignmentRunning) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-session-action]");
  if (!target) return;
  const sessionIds = Array.from(selectedSessionIds);
  const action = target.dataset.sessionAction;
  sessionContextMenu.hidden = true;
  if (action === "delete") {
    if (!sessionIds.length) return;
    openDeleteDialog(selectedSessionId);
  } else if (action === "merge" && sessionIds.length > 1) {
    void emit("subtitle-history-session-merge", { sessionIds });
  }
});

sentenceContextMenu.addEventListener("click", (event) => {
  if (aiAlignmentRunning) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sentence-action]");
  if (!target) return;
  const action = target.dataset.sentenceAction;
  sentenceContextMenu.hidden = true;
  if (!sentenceContextIds.length) return;
  if (action === "edit") {
    openSentenceEditDialog(sentenceContextIds);
  } else if (action === "delete") {
    openSentenceDeleteDialog(sentenceContextIds);
  }
});

function openSentenceDeleteDialog(ids: number[]) {
  if (!ids.length || aiAlignmentRunning) return;
  sentenceContextIds = [...ids];
  const label = ids.length > 1 ? `选中的 ${ids.length} 句字幕` : "这一句字幕";
  sentenceDeleteWarning.textContent = `${label}即将被删除，无法恢复。`;
  sentenceDeleteDialog.hidden = false;
  confirmSentenceDelete.focus();
}

function closeSentenceDeleteDialog() {
  sentenceDeleteDialog.hidden = true;
}

cancelSentenceDelete.addEventListener("click", closeSentenceDeleteDialog);

confirmSentenceDelete.addEventListener("click", () => {
  if (!sentenceContextIds.length) return;
  const ids = [...sentenceContextIds];
  closeSentenceDeleteDialog();
  void emit("subtitle-history-sentence-delete", { sessionId: currentSessionId, ids });
});

function openSentenceEditDialog(ids: number[]) {
  if (aiAlignmentRunning) return;
  const transcript = getTranscript();
  const target = ids
    .map((id) => transcript.find((line) => line.id === id))
    .filter((line): line is { id: number; o: string; t: string } => !!line && line.id !== undefined);
  if (!target.length) return;
  const targetIndex = transcript.findIndex((line) => line.id === target[0].id);
  const rows: Array<{ line: { id: number; o: string; t: string }; label: string }> = [];
  if (targetIndex > 0 && transcript[targetIndex - 1].id !== undefined) {
    rows.push({ line: transcript[targetIndex - 1] as { id: number; o: string; t: string }, label: "上一句" });
  }
  rows.push({ line: target[0], label: "当前句" });
  if (targetIndex >= 0 && targetIndex < transcript.length - 1 && transcript[targetIndex + 1].id !== undefined) {
    rows.push({ line: transcript[targetIndex + 1] as { id: number; o: string; t: string }, label: "下一句" });
  }
  target.slice(1).forEach((line) => rows.push({ line, label: `句子 ${line.id}` }));
  sentenceEditList.textContent = "";
  rows.forEach((row) => {
    const wrap = document.createElement("div");
    wrap.className = "sentence-edit-item";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "sentence-edit-header";
    header.title = row.label === "当前句" ? "当前句（收起/展开）" : "收起/展开";
    const heading = document.createElement("span");
    heading.className = "sentence-edit-heading";
    heading.textContent = row.label;
    const preview = document.createElement("span");
    preview.className = "sentence-edit-preview";
    preview.textContent = row.line.t || "";
    const chevron = document.createElement("span");
    chevron.className = "sentence-edit-chevron";
    header.append(heading, preview, chevron);
    const body = document.createElement("div");
    body.className = "sentence-edit-body";
    const oLabel = document.createElement("label");
    oLabel.className = "sentence-edit-label";
    oLabel.textContent = "原文";
    body.append(oLabel, createSentenceEditInput(row.line.id, "o", row.line.o || ""));
    const tLabel = document.createElement("label");
    tLabel.className = "sentence-edit-label";
    tLabel.textContent = "译文";
    body.append(tLabel, createSentenceEditInput(row.line.id, "t", row.line.t || ""));
    wrap.append(header, body);
    if (row.label === "当前句") wrap.classList.add("expanded");
    sentenceEditList.appendChild(wrap);
  });
  sentenceEditDialog.hidden = false;
  sentenceEditList.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

sentenceEditList.addEventListener("click", (event) => {
  const header = (event.target as HTMLElement).closest<HTMLElement>(".sentence-edit-header");
  if (!header) return;
  const item = header.closest<HTMLElement>(".sentence-edit-item");
  if (!item) return;
  const wasExpanded = item.classList.contains("expanded");
  sentenceEditList.querySelectorAll<HTMLElement>(".sentence-edit-item.expanded").forEach((el) => el.classList.remove("expanded"));
  if (!wasExpanded) item.classList.add("expanded");
});

function createSentenceEditInput(id: number, field: "o" | "t", value: string) {
  const input = document.createElement("textarea");
  input.className = "sentence-edit-input";
  input.dataset.editId = String(id);
  input.dataset.editField = field;
  input.value = value;
  return input;
}

function collectSentenceEdits() {
  const byId = new Map<number, { o: string; t: string }>();
  sentenceEditList.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((input) => {
    const id = Number(input.dataset.editId);
    if (!id) return;
    const current = byId.get(id) || { o: "", t: "" };
    if (input.dataset.editField === "o") current.o = input.value;
    else current.t = input.value;
    byId.set(id, current);
  });
  return Array.from(byId, ([id, value]) => ({ id, o: value.o, t: value.t }));
}

saveSentenceEdit.addEventListener("click", () => {
  const items = collectSentenceEdits();
  if (!items.length) return;
  sentenceEditDialog.hidden = true;
  void emit("subtitle-history-sentence-edit", { sessionId: currentSessionId, items });
});

cancelSentenceEdit.addEventListener("click", () => {
  sentenceEditDialog.hidden = true;
});

sentenceEditDialog.addEventListener("pointerdown", (event) => {
  if (event.target === sentenceEditDialog) sentenceEditDialog.hidden = true;
});

sentenceDeleteDialog.addEventListener("pointerdown", (event) => {
  if (event.target === sentenceDeleteDialog) closeSentenceDeleteDialog();
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!sessionContextMenu.contains(target as Node)) sessionContextMenu.hidden = true;
  if (!sentenceContextMenu.contains(target as Node)) sentenceContextMenu.hidden = true;
  const drawer = historyBody.querySelector<HTMLElement>(".inline-record-details");
  const element = target instanceof Element ? target : null;
  if (drawer && element && !drawer.contains(element) && !element.closest(".row-record")) {
    closeRecordDrawer();
  }
});

closeButton.addEventListener("click", () => {
  invoke("hide_subtitle_history").catch(console.error);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!sessionContextMenu.hidden) {
    sessionContextMenu.hidden = true;
    return;
  }
  if (!sentenceContextMenu.hidden) {
    sentenceContextMenu.hidden = true;
    return;
  }
  if (!sentenceEditDialog.hidden) {
    sentenceEditDialog.hidden = true;
    return;
  }
  if (!sentenceDeleteDialog.hidden) {
    closeSentenceDeleteDialog();
    return;
  }
  if (!clearDialog.hidden) {
    clearDialog.hidden = true;
    return;
  }
  if (expandedRecordKey) {
    closeRecordDrawer();
    return;
  }
  invoke("hide_subtitle_history").catch(console.error);
});

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function renderSessionList() {
  sessionCount.textContent = String(sessions.length);
  sessionList.textContent = "";
  sessions.forEach((session) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "session-item";
    item.dataset.sessionId = session.id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", selectedSessionIds.has(session.id) ? "true" : "false");
    item.classList.toggle("selected", selectedSessionIds.has(session.id));

    const title = document.createElement("strong");
    title.textContent = formatSessionTitle(session.startedAt);
    const meta = document.createElement("span");
    meta.textContent = `${session.sentenceCount} 句 · ${session.recordCount} 条记录`;
    item.append(title, meta);
    sessionList.appendChild(item);
  });
  updateSessionContextMenu();
}

function updateHistorySessionTitle() {
  const session = sessions.find((item) => item.id === selectedSessionId);
  historySessionTitle.textContent = session ? formatSessionTitle(session.startedAt) : "字幕记录";
}

function updateSessionContextMenu() {
  sessionContextMenu.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = aiAlignmentRunning || (button === mergeSessionAction && selectedSessionIds.size < 2);
  });
}

function openDeleteDialog(sessionId: string) {
  selectedSessionId = sessionId;
  if (selectedSessionIds.size > 1) {
    clearSessionWarning.textContent = `已选 ${selectedSessionIds.size} 条字幕记录即将被删除，无法恢复。`;
  } else {
    const session = sessions.find((item) => item.id === sessionId);
    const noteCount = session?.recordCount || 0;
    const noteSuffix = noteCount > 0 ? `（含 ${noteCount} 条备注）` : "";
    const sessionTitle = session ? formatSessionTitle(session.startedAt) : "当前记录";
    clearSessionWarning.textContent = `字幕记录 ${sessionTitle} 即将被删除${noteSuffix}，无法恢复。`;
  }
  clearDialog.hidden = false;
  confirmClear.focus();
}

function formatSessionTitle(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未命名记录";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
}

function renderHistory(preserveScroll = false) {
  const rows = buildHistoryRows(getTranscript(), mode, editedSentenceIds);
  const shouldFollowBottom = !preserveScroll && followBottom;
  const historyScrollTop = historyList.scrollTop;
  historyCount.textContent = `${rows.length} 句`;
  emptyState.hidden = rows.length > 0;
  emptyTitle.textContent = "暂无历史字幕";
  const existingDrawer = historyBody.querySelector<HTMLElement>(".inline-record-details");
  if (!expandedRecordKey && existingDrawer && !existingDrawer.classList.contains("is-closing")) {
    existingDrawer.remove();
  }
  historyList.textContent = "";
  let expandedSourceIds: number[] | null = null;
  let expandedSentenceRecords: QuickRecord[] = [];

  rows.forEach((dataRow, index) => {
    const entry = document.createElement("div");
    entry.className = "history-entry";
    const row = document.createElement("article");
    row.className = "history-item";
    const sourceIds = dataRow.sourceIds || (dataRow.id === undefined ? [] : [dataRow.id]);
    if (sourceIds.length) row.dataset.sourceIds = sourceIds.join(",");

    const number = document.createElement("span");
    number.className = "history-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const body = document.createElement("div");
    body.className = "history-item-body";
    const sentenceRecords = records.filter((record) =>
      record.status === "anchored" && record.sentenceId !== null && sourceIds.includes(record.sentenceId),
    );

    if (mode === "bilingual") {
      body.appendChild(createTextLine("history-primary", dataRow.zh || "\u00a0"));
      body.appendChild(createTextLine("history-secondary", dataRow.en || "\u00a0"));
    } else if (dataRow.zh) {
      const line = createTextLine("history-primary", dataRow.zh);
      if (mode === "zh") line.appendChild(createRecordButton(sourceIds, sentenceRecords, true));
      body.appendChild(line);
    } else if (dataRow.en) {
      const line = createTextLine("history-primary history-primary-english", dataRow.en);
      if (mode === "en") line.appendChild(createRecordButton(sourceIds, sentenceRecords, true));
      body.appendChild(line);
    }

    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    if (mode !== "zh" && mode !== "en" && sourceIds.length) {
      rowActions.appendChild(createRecordButton(sourceIds, sentenceRecords, false));
    }

    const copyButton = document.createElement("button");
    copyButton.className = "row-copy";
    copyButton.type = "button";
    copyButton.title = "复制这一句";
    copyButton.innerHTML = COPY_ICON;
    let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
    copyButton.addEventListener("click", async () => {
      await copyText(historyRowCopyValue(dataRow, mode));
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyButton.classList.add("copied");
      copyButton.title = "已复制";
      copyButton.innerHTML = CHECK_ICON;
      copyResetTimer = setTimeout(() => {
        copyButton.classList.remove("copied");
        copyButton.title = "复制这一句";
        copyButton.innerHTML = COPY_ICON;
        copyResetTimer = null;
      }, 1200);
    });

    rowActions.appendChild(copyButton);
    row.append(number, body, rowActions);
    entry.appendChild(row);
    const recordKey = sourceIds.join(",");
    if (expandedRecordKey && expandedRecordKey === recordKey) {
      expandedSourceIds = sourceIds;
      expandedSentenceRecords = sentenceRecords;
    }
    historyList.appendChild(entry);
  });

  if (expandedSourceIds) {
    if (recordDrawerCloseTimer) {
      clearTimeout(recordDrawerCloseTimer);
      recordDrawerCloseTimer = null;
    }
    const nextDrawer = createInlineRecordDetails(expandedSourceIds, expandedSentenceRecords);
    const currentDrawer = historyBody.querySelector<HTMLElement>(".inline-record-details");
    if (!currentDrawer) {
      historyBody.appendChild(nextDrawer);
    } else if (currentDrawer.classList.contains("is-closing")) {
      currentDrawer.remove();
      historyBody.appendChild(nextDrawer);
    } else {
      updateRecordDrawer(currentDrawer, nextDrawer);
    }
  } else {
    const drawer = historyBody.querySelector<HTMLElement>(".inline-record-details");
    if (!drawer || !drawer.classList.contains("is-closing")) {
      drawer?.remove();
    }
  }

  if (shouldFollowBottom) {
    requestAnimationFrame(() => { historyList.scrollTop = historyList.scrollHeight; });
  } else {
    historyList.scrollTop = historyScrollTop;
  }
}

function getTranscript() {
  return current.o || current.t ? [...history, current] : history;
}

function createTextLine(className: string, text: string) {
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  return line;
}

function createRecordButton(sourceIds: number[], sentenceRecords: QuickRecord[], inline: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.recordKey = sourceIds.join(",");
  button.dataset.inline = inline ? "true" : "false";
  updateRecordButton(button, sentenceRecords);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const recordKey = sourceIds.join(",");
    if (expandedRecordKey === recordKey) {
      closeRecordDrawer();
      return;
    }
    openRecordDrawer(sourceIds, recordsForSourceIds(sourceIds));
  });
  return button;
}

function updateRecordButton(button: HTMLButtonElement, sentenceRecords: QuickRecord[]) {
  const hasNote = sentenceRecords.some((record) => record.kind === "note");
  const sourceIds = (button.dataset.recordKey || "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  const hasMarker = sourceIds.some((id) => markedSentenceIds.has(id));
  const inline = button.dataset.inline === "true";
  button.className = `row-record ${inline ? "row-record-inline" : ""} ${hasNote ? "has-notes" : ""} ${hasMarker ? "has-marker" : ""} ${!hasNote && !hasMarker ? "empty-record" : ""}`.trim();
  button.title = hasNote && hasMarker ? "查看备注，已标记" : hasNote ? "查看备注" : hasMarker ? "已标记，查看备注" : "添加备注或标记";
  button.setAttribute("aria-label", button.title);
  button.innerHTML = hasMarker ? FLAG_ICON : COMMENT_ICON;
}

function recordsForSourceIds(sourceIds: number[]) {
  return records.filter((record) =>
    record.status === "anchored" && record.sentenceId !== null && sourceIds.includes(record.sentenceId),
  );
}

function updateRecordIndicators() {
  document.querySelectorAll<HTMLButtonElement>(".row-record[data-record-key]").forEach((button) => {
    const sourceIds = (button.dataset.recordKey || "")
      .split(",")
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
    updateRecordButton(button, recordsForSourceIds(sourceIds));
  });
}

function updateOpenRecordDrawer() {
  const panel = historyBody.querySelector<HTMLElement>(".inline-record-details");
  if (!panel || !expandedRecordKey) return;
  const sourceIds = expandedRecordKey.split(",").filter(Boolean).map(Number).filter(Number.isFinite);
  const nextPanel = createInlineRecordDetails(sourceIds, recordsForSourceIds(sourceIds));
  updateRecordDrawer(panel, nextPanel);
}

function openRecordDrawer(sourceIds: number[], sentenceRecords: QuickRecord[]) {
  expandedRecordKey = sourceIds.join(",");
  if (recordDrawerCloseTimer) {
    clearTimeout(recordDrawerCloseTimer);
    recordDrawerCloseTimer = null;
  }
  const nextDrawer = createInlineRecordDetails(sourceIds, sentenceRecords);
  const currentDrawer = historyBody.querySelector<HTMLElement>(".inline-record-details");
  if (currentDrawer?.classList.contains("is-closing")) currentDrawer.remove();
  const drawer = historyBody.querySelector<HTMLElement>(".inline-record-details");
  if (drawer) updateRecordDrawer(drawer, nextDrawer);
  else historyBody.appendChild(nextDrawer);
  const input = historyBody.querySelector<HTMLTextAreaElement>(".inline-record-details .inline-record-compose textarea");
  if (input && !readOnly) requestAnimationFrame(() => input.focus());
}

function createNoteText(record: QuickRecord) {
  const text = document.createElement("div");
  text.className = "inline-record-text";
  text.dataset.recordId = record.id;
  text.textContent = record.text || "";
  text.setAttribute("role", "textbox");
  text.setAttribute("aria-label", "备注内容");
  let pointerMoved = false;
  let pointerX = 0;
  let pointerY = 0;
  text.addEventListener("pointerdown", (event) => {
    pointerMoved = false;
    pointerX = event.clientX;
    pointerY = event.clientY;
  });
  text.addEventListener("pointermove", (event) => {
    if (Math.hypot(event.clientX - pointerX, event.clientY - pointerY) > 4) pointerMoved = true;
  });
  text.addEventListener("click", (event) => {
    event.stopPropagation();
    if (pointerMoved) {
      pointerMoved = false;
      return;
    }
    if (readOnly || aiAlignmentRunning) return;
    const selection = window.getSelection();
    const selectionInsideText = selection && !selection.isCollapsed &&
      (text.contains(selection.anchorNode) || text.contains(selection.focusNode));
    if (selectionInsideText) return;

    const editor = document.createElement("textarea");
    editor.className = "inline-record-editor";
    editor.rows = 3;
    editor.dataset.recordId = record.id;
    editor.value = record.text || "";
    editor.maxLength = 2000;
    editor.setAttribute("aria-label", "备注内容");
    const finishEditing = () => {
      const nextText = editor.value.trim();
      editor.removeEventListener("blur", finishEditing);
      const display = createNoteText({ ...record, text: nextText || record.text });
      editor.replaceWith(display);
      if (nextText && nextText !== (record.text || "").trim()) {
        void emit("subtitle-history-record-update", {
          sessionId: currentSessionId,
          recordId: record.id,
          text: nextText,
        });
      }
    };
    editor.addEventListener("blur", finishEditing);
    text.replaceWith(editor);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });
  return text;
}

function createInlineRecordDetails(sourceIds: number[], sentenceRecords: QuickRecord[]) {
  const panel = document.createElement("section");
  panel.className = "inline-record-details";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "备注");
  panel.dataset.recordKey = sourceIds.join(",");
  panel.dataset.recordSignature = JSON.stringify([
    readOnly,
    aiAlignmentRunning,
    sourceIds,
    sourceIds.map((id) => markedSentenceIds.has(id)),
    sentenceRecords.map((record) => [record.id, record.kind, record.status, record.sentenceId, record.createdAt, record.text || ""]),
  ]);
  const noteRecords = sentenceRecords.filter((record) => record.kind === "note");
  const hasMarker = sourceIds.some((id) => markedSentenceIds.has(id));

  const head = document.createElement("div");
  head.className = "inline-record-head";
  const title = document.createElement("strong");
  title.textContent = "备注";
  const count = document.createElement("span");
  count.textContent = `${noteRecords.length} 条`;
  const headActions = document.createElement("div");
  headActions.className = "inline-record-head-actions";
  const headMarker = document.createElement("button");
  headMarker.className = `inline-record-head-button ${hasMarker ? "is-active" : ""}`;
  headMarker.type = "button";
  headMarker.title = hasMarker ? "移除标记" : "添加标记";
  headMarker.setAttribute("aria-label", headMarker.title);
  headMarker.innerHTML = FLAG_ICON;
  headMarker.disabled = readOnly || aiAlignmentRunning || !sourceIds.length;
  headMarker.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void emit("subtitle-history-record-request", { kind: "marker", sessionId: currentSessionId, sentenceId: sourceIds[0] });
  });
  const clear = document.createElement("button");
  clear.className = "inline-record-head-button inline-record-clear";
  clear.type = "button";
  clear.title = "清除全部备注";
  clear.setAttribute("aria-label", clear.title);
  clear.innerHTML = TRASH_ICON;
  clear.disabled = readOnly || aiAlignmentRunning || !noteRecords.length;
  clear.addEventListener("click", () => {
    sentenceRecords.filter((record) => record.kind === "note").forEach((record) => {
      void emit("subtitle-history-record-delete", { sessionId: currentSessionId, recordId: record.id });
    });
  });
  const close = document.createElement("button");
  close.className = "inline-record-close";
  close.type = "button";
  close.title = "关闭备注";
  close.setAttribute("aria-label", close.title);
  close.innerHTML = CLOSE_ICON;
  close.addEventListener("click", () => {
    closeRecordDrawer();
  });
  headActions.append(headMarker, clear, close);
  head.append(title, count, headActions);
  panel.appendChild(head);

  const list = document.createElement("div");
  list.className = "inline-record-list";
  if (!noteRecords.length) {
    const empty = document.createElement("div");
    empty.className = "inline-record-empty";
    empty.textContent = "还没有备注";
    list.appendChild(empty);
  }

  noteRecords.forEach((record) => {
    const item = document.createElement("article");
    item.className = "inline-record-item note";
    const content = document.createElement("div");
    content.className = "inline-record-content";

    if (record.kind === "note") {
      content.appendChild(createNoteText(record));
    }

    const remove = document.createElement("button");
    remove.className = "inline-record-action inline-record-remove";
    remove.type = "button";
    remove.title = "删除备注";
    remove.setAttribute("aria-label", remove.title);
    remove.innerHTML = TRASH_ICON;
    remove.disabled = readOnly || aiAlignmentRunning;
    remove.addEventListener("click", () => {
      void emit("subtitle-history-record-delete", { sessionId: currentSessionId, recordId: record.id });
    });
    content.appendChild(remove);
    item.append(content);
    list.appendChild(item);
  });
  panel.appendChild(list);

  const compose = document.createElement("div");
  compose.className = "inline-record-compose";
  const input = document.createElement("textarea");
  input.rows = 2;
  input.maxLength = 2000;
  input.placeholder = "写下备注…";
  input.disabled = readOnly || aiAlignmentRunning;
  const inputWrap = document.createElement("div");
  inputWrap.className = "inline-record-input-wrap";
  const marker = document.createElement("button");
  marker.className = `inline-record-compose-action inline-record-compose-marker ${hasMarker ? "is-active" : ""}`;
  marker.type = "button";
  marker.title = hasMarker ? "移除标记" : "添加标记";
  marker.setAttribute("aria-label", marker.title);
  marker.innerHTML = FLAG_ICON;
  marker.disabled = readOnly || aiAlignmentRunning || !sourceIds.length;
  marker.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void emit("subtitle-history-record-request", { kind: "marker", sessionId: currentSessionId, sentenceId: sourceIds[0] });
  });
  const note = document.createElement("button");
  note.className = "inline-record-submit";
  note.type = "button";
  note.title = "记录备注（Ctrl+Enter）";
  note.setAttribute("aria-label", note.title);
  note.innerHTML = SEND_ICON;
  note.disabled = readOnly || aiAlignmentRunning || !sourceIds.length || !input.value.trim();
  const optimize = document.createElement("button");
  optimize.className = "inline-record-compose-action inline-record-compose-ai";
  optimize.type = "button";
  optimize.title = "AI 优化备注";
  optimize.setAttribute("aria-label", optimize.title);
  optimize.innerHTML = AI_ICON;
  optimize.disabled = readOnly || aiAlignmentRunning || !sourceIds.length || !input.value.trim();
  input.addEventListener("input", () => {
    resizeRecordInput(input, inputWrap);
    const currentPanel = input.closest<HTMLElement>(".inline-record-details");
    updateComposeButtons(currentPanel || panel);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.ctrlKey) return;
    event.preventDefault();
    note.click();
  });
  note.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    void emit("subtitle-history-record-request", { kind: "note", text, sessionId: currentSessionId, sentenceId: sourceIds[0] });
    input.value = "";
    resizeRecordInput(input, inputWrap);
    updateComposeButtons(input.closest<HTMLElement>(".inline-record-details") || panel);
  });
  optimize.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = input.value.trim();
    if (!text || optimize.disabled) return;
    const requestId = crypto.randomUUID();
    recordOptimizeRequests.set(requestId, sourceIds.join(","));
    optimize.disabled = true;
    optimize.classList.add("is-running");
    optimize.setAttribute("aria-busy", "true");
    void emit("subtitle-history-record-optimize", {
      requestId,
      sessionId: currentSessionId,
      sentenceId: sourceIds[0],
      text,
    });
  });
  inputWrap.append(input);
  const actions = document.createElement("div");
  actions.className = "inline-record-actions";
  const tools = document.createElement("div");
  tools.className = "inline-record-tools";
  tools.append(marker, optimize);
  actions.append(note);
  inputWrap.append(tools, actions);
  compose.append(inputWrap);
  resizeRecordInput(input, inputWrap);
  panel.appendChild(compose);
  return panel;
}

function resizeRecordInput(input: HTMLTextAreaElement, inputWrap: HTMLElement) {
  const inputStyle = getComputedStyle(input);
  const lineHeight = Number.parseFloat(inputStyle.lineHeight) || 22;
  const padding = (Number.parseFloat(inputStyle.paddingTop) || 0) + (Number.parseFloat(inputStyle.paddingBottom) || 0);
  const actionHeight = 30;
  const minWrapHeight = Number.parseFloat(getComputedStyle(inputWrap).minHeight) || 108;
  const maxWrapHeight = Number.parseFloat(getComputedStyle(inputWrap).maxHeight) || 268;
  const minContentHeight = Math.max(minWrapHeight - actionHeight, lineHeight + padding);
  const maxContentHeight = Math.min(lineHeight * 10 + padding, maxWrapHeight - actionHeight);

  input.style.height = "0px";
  input.style.overflowY = "hidden";
  const contentHeight = input.scrollHeight;
  const targetContentHeight = Math.min(Math.max(contentHeight, minContentHeight), maxContentHeight);
  inputWrap.style.height = `${targetContentHeight + actionHeight}px`;
  inputWrap.style.gridTemplateRows = `${targetContentHeight}px ${actionHeight}px`;
  input.style.height = `${targetContentHeight}px`;
  input.style.overflowY = contentHeight > maxContentHeight ? "auto" : "hidden";
}

function updateComposeButtons(panel: HTMLElement) {
  const input = panel.querySelector<HTMLTextAreaElement>(".inline-record-compose textarea");
  if (!input) return;
  const hasText = Boolean(input.value.trim());
  const submit = panel.querySelector<HTMLButtonElement>(".inline-record-submit");
  const optimize = panel.querySelector<HTMLButtonElement>(".inline-record-compose-ai");
  if (submit) submit.disabled = readOnly || aiAlignmentRunning || !panel.dataset.recordKey || !hasText;
  if (optimize && !optimize.classList.contains("is-running")) {
    optimize.disabled = readOnly || aiAlignmentRunning || !panel.dataset.recordKey || !hasText;
  }
}

function updateRecordDrawer(panel: HTMLElement, nextPanel: HTMLElement) {
  if (panel.dataset.recordSignature === nextPanel.dataset.recordSignature) return;
  const sameRecord = panel.dataset.recordKey === nextPanel.dataset.recordKey;
  const currentInput = sameRecord ? panel.querySelector<HTMLTextAreaElement>(".inline-record-compose textarea") : null;
  const currentDraft = currentInput?.value;
  const currentEditor = sameRecord ? panel.querySelector<HTMLTextAreaElement>(".inline-record-editor") : null;
  const editingRecordId = currentEditor?.dataset.recordId;
  const editingText = currentEditor?.value || "";
  const editorHasFocus = currentEditor === document.activeElement;
  const inputHasFocus = currentInput === document.activeElement;

  panel.dataset.recordKey = nextPanel.dataset.recordKey || "";
  panel.dataset.recordSignature = nextPanel.dataset.recordSignature || "";
  panel.replaceChildren(...Array.from(nextPanel.childNodes));

  const nextInput = panel.querySelector<HTMLTextAreaElement>(".inline-record-compose textarea");
  const nextInputWrap = panel.querySelector<HTMLElement>(".inline-record-input-wrap");
  if (nextInput && currentDraft !== undefined) {
    nextInput.value = currentDraft;
    if (nextInputWrap) resizeRecordInput(nextInput, nextInputWrap);
    updateComposeButtons(panel);
    if (inputHasFocus) nextInput.focus();
  }
  if (editingRecordId) {
    const nextEditor = Array.from(panel.querySelectorAll<HTMLTextAreaElement>(".inline-record-editor"))
      .find((item) => item.dataset.recordId === editingRecordId);
    if (nextEditor) {
      nextEditor.value = editingText;
      if (editorHasFocus) {
        nextEditor.focus();
        nextEditor.setSelectionRange(nextEditor.value.length, nextEditor.value.length);
      }
    }
  }
}

function closeRecordDrawer() {
  const panel = historyBody.querySelector<HTMLElement>(".inline-record-details");
  expandedRecordKey = "";
  if (recordDrawerCloseTimer) clearTimeout(recordDrawerCloseTimer);
  recordDrawerCloseTimer = null;
  if (!panel) {
    renderHistory();
    return;
  }
  panel.classList.add("is-closing");
  recordDrawerCloseTimer = setTimeout(() => {
    if (panel.isConnected) panel.remove();
    recordDrawerCloseTimer = null;
  }, 200);
}

function applyModeButtons() {
  document.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function loadMode(): HistoryMode {
  const value = localStorage.getItem("mt-history-mode");
  return isHistoryMode(value) ? value : "bilingual";
}

function isAtBottom() {
  return historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight <= 24;
}

applyModeButtons();
renderSessionList();
renderHistory();
void emit("subtitle-history-request", {});