import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { QuickRecord } from "./quick-records";

type RecordWindowState = {
  mode: "note" | "details";
  sessionId: string;
  sentenceId: number | null;
  sentenceText: string;
  records: QuickRecord[];
  readOnly: boolean;
  marked: boolean;
};

const recordTitle = document.getElementById("record-title")!;
const recordShell = document.querySelector<HTMLElement>(".record-shell")!;
const recordSentence = document.getElementById("record-sentence")!;
const recordCount = document.getElementById("record-count")!;
const noteCompose = document.getElementById("note-compose")!;
const noteInput = document.getElementById("note-input") as HTMLTextAreaElement;
const noteCancel = document.getElementById("note-cancel") as HTMLButtonElement;
const noteSave = document.getElementById("note-save") as HTMLButtonElement;
const recordDetails = document.getElementById("record-details")!;
const recordList = document.getElementById("record-list")!;
const detailNoteInput = document.getElementById("detail-note-input") as HTMLTextAreaElement;
const detailMarker = document.getElementById("detail-marker") as HTMLButtonElement;
const detailNote = document.getElementById("detail-note") as HTMLButtonElement;
const closeButton = document.getElementById("btn-close") as HTMLButtonElement;

let state: RecordWindowState = {
  mode: "note",
  sessionId: "",
  sentenceId: null,
  sentenceText: "",
  records: [],
  readOnly: true,
  marked: false,
};

const NOTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h6M8 16h4" fill="none"/></svg>';

listen<RecordWindowState>("quick-record-window-state", (event) => {
  state = event.payload;
  render();
});

function render() {
  recordShell.classList.remove("is-entering");
  void recordShell.offsetWidth;
  recordShell.classList.add("is-entering");
  const details = state.mode === "details";
  recordTitle.textContent = details ? "句子记录" : "快速笔记";
  recordSentence.textContent = details ? "" : state.sentenceText || "暂无当前内容";
  noteCompose.hidden = details;
  recordDetails.hidden = !details;
  noteCompose.setAttribute("aria-hidden", details ? "true" : "false");
  recordDetails.setAttribute("aria-hidden", details ? "false" : "true");
  noteInput.value = "";
  detailNoteInput.value = "";
  noteCancel.disabled = state.readOnly;
  noteSave.disabled = state.readOnly;
  detailMarker.disabled = state.readOnly;
  detailMarker.classList.toggle("is-active", Boolean(state.marked));
  detailMarker.textContent = state.marked ? "移除标记" : "加标记";
  detailMarker.title = state.marked ? "移除标记" : "添加标记";
  detailNote.disabled = state.readOnly;
  detailNoteInput.disabled = state.readOnly;
  if (details) renderDetails();
  else noteInput.focus();
}

function renderDetails() {
  recordList.textContent = "";
  recordCount.textContent = `${state.records.length} 条`;
  if (!state.records.length) {
    const empty = document.createElement("div");
    empty.className = "record-empty";
    empty.textContent = "暂无记录";
    recordList.appendChild(empty);
    return;
  }

  state.records.forEach((record) => {
    const item = document.createElement("article");
    item.className = "record-item";
    const icon = document.createElement("span");
    icon.className = "record-item-icon note";
    icon.innerHTML = NOTE_ICON;
    const content = document.createElement("div");
    content.className = "record-item-content";
    const time = document.createElement("time");
    time.textContent = formatTime(record.createdAt);
    content.appendChild(time);

    const text = document.createElement("div");
    text.className = "record-item-text";
    text.textContent = record.text || "";
    content.appendChild(text);
    const edit = document.createElement("button");
    edit.className = "record-item-action";
    edit.type = "button";
    edit.textContent = "编辑";
    edit.disabled = state.readOnly;
    edit.addEventListener("click", () => {
      if (text.contentEditable !== "true") {
        text.contentEditable = "true";
        edit.textContent = "保存";
        text.focus();
        return;
      }
      void emit("quick-record-update", {
        sessionId: state.sessionId,
        recordId: record.id,
        text: text.textContent || "",
      });
      text.contentEditable = "false";
      edit.textContent = "编辑";
    });
    content.appendChild(edit);

    const remove = document.createElement("button");
    remove.className = "record-item-action record-item-remove";
    remove.type = "button";
    remove.textContent = "删除";
    remove.disabled = state.readOnly;
    remove.addEventListener("click", () => {
      void emit("quick-record-delete", { sessionId: state.sessionId, recordId: record.id });
    });
    content.appendChild(remove);
    item.append(icon, content);
    recordList.appendChild(item);
  });
}

noteSave.addEventListener("click", () => {
  const text = noteInput.value.trim();
  if (!text || state.readOnly) return;
  void emit("quick-record-submit", {
    kind: "note",
    text,
    sessionId: state.sessionId,
    sentenceId: state.sentenceId,
  });
});

noteCancel.addEventListener("click", closeWindow);
detailMarker.addEventListener("click", () => {
  if (state.readOnly || state.sentenceId === null) return;
  void emit("quick-record-submit", {
    kind: "marker",
    sessionId: state.sessionId,
    sentenceId: state.sentenceId,
  });
});
detailNote.addEventListener("click", () => {
  const text = detailNoteInput.value.trim();
  if (!text || state.readOnly || state.sentenceId === null) return;
  void emit("quick-record-submit", {
    kind: "note",
    text,
    sessionId: state.sessionId,
    sentenceId: state.sentenceId,
  });
  detailNoteInput.value = "";
});

noteInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    noteSave.click();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeWindow();
  }
});

closeButton.addEventListener("click", closeWindow);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWindow();
});

function closeWindow() {
  invoke("hide_quick_record_window").catch(console.error);
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

void emit("quick-record-window-request", {});
