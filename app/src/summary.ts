import { emit } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { renderMarkdown } from "./markdown";

type SummaryPageItem =
  | { kind: "marker"; time: string; sessionId?: string }
  | { kind: "summary"; time: string; text: string; sessionId?: string }
  | { kind: "qa"; time: string; question: string; answer: string; sessionId?: string };

const summaryList = document.getElementById("summary-list")!;
const summaryEmpty = document.getElementById("summary-empty")!;
const summaryContent = document.querySelector<HTMLElement>(".summary-content")!;
const closeButton = document.getElementById("btn-close") as HTMLButtonElement;
const questionInput = document.getElementById("summary-question") as HTMLInputElement;
const askButton = document.getElementById("btn-ask") as HTMLButtonElement;
const regenerateButton = document.getElementById("btn-regenerate") as HTMLButtonElement;
const summaryStatus = document.getElementById("summary-status")!;

let items: SummaryPageItem[] = [];
let lastSignature = "";

function itemsSignature(list: SummaryPageItem[]) {
  return list.map((item) => {
    switch (item.kind) {
      case "marker": return `m:${item.time}`;
      case "summary": return `s:${item.time}:${item.text}`;
      case "qa": return `q:${item.time}:${item.question}:${item.answer}`;
    }
  }).join("\n");
}

listen<{ items: SummaryPageItem[]; running?: boolean; busyAction?: "summary" | "qa" | null; status?: string; statusKind?: "idle" | "running" | "error" }>("summary-page-state", (event) => {
  setBusy(event.payload.running === true, event.payload.busyAction || null);
  setStatus(event.payload.status || "", event.payload.statusKind || "idle");
  const nextItems = event.payload.items || [];
  const signature = itemsSignature(nextItems);
  // 内容未变化时不重建 DOM，避免滚动位置被重置。
  if (signature === lastSignature) return;
  lastSignature = signature;
  items = nextItems;
  render();
  requestAnimationFrame(() => { summaryContent.scrollTop = summaryContent.scrollHeight; });
});

function setBusy(running: boolean, busyAction: "summary" | "qa" | null) {
  askButton.disabled = running;
  regenerateButton.disabled = running;
  questionInput.disabled = running;
  askButton.classList.toggle("is-busy", running && busyAction === "qa");
  regenerateButton.classList.toggle("is-busy", running && busyAction === "summary");
}

function setStatus(text: string, kind: "idle" | "running" | "error") {
  summaryStatus.hidden = !text;
  summaryStatus.textContent = text;
  summaryStatus.className = `summary-status is-${kind}`;
}

function ask() {
  const question = questionInput.value.trim();
  if (!question) return;
  questionInput.value = "";
  void emit("summary-ask-request", { question });
}

askButton.addEventListener("click", ask);
questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ask();
});
regenerateButton.addEventListener("click", () => {
  void emit("summary-regenerate-request", {});
});

closeButton.addEventListener("click", () => {
  invoke("hide_summary_window").catch(console.error);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") invoke("hide_summary_window").catch(console.error);
});

function renderMarkdownOrPending(text: string) {
  return text.trim() ? renderMarkdown(text) : '<span class="summary-pending">正在生成...</span>';
}

function render() {
  summaryEmpty.hidden = items.length > 0;
  summaryList.textContent = "";

  items.forEach((item) => {
    if (item.kind === "marker") {
      const divider = document.createElement("div");
      divider.className = "summary-divider";
      const label = document.createElement("span");
      label.textContent = `历史总结 ${item.time}`;
      divider.appendChild(label);
      summaryList.appendChild(divider);
      return;
    }

    const card = document.createElement("article");
    card.className = "summary-card";
    const time = document.createElement("time");
    time.textContent = item.time;
    card.appendChild(time);

    if (item.kind === "qa") {
      card.classList.add("summary-qa");
      const question = document.createElement("div");
      question.className = "summary-question";
      question.textContent = `Q：${item.question}`;
      const answer = document.createElement("div");
      answer.className = "summary-text";
      answer.innerHTML = renderMarkdownOrPending(item.answer);
      card.append(question, answer);
      summaryList.appendChild(card);
      return;
    }

    const content = document.createElement("div");
    content.className = "summary-text";
    content.innerHTML = renderMarkdownOrPending(item.text);
    card.appendChild(content);
    summaryList.appendChild(card);
  });
}

render();
void emit("summary-page-request", {});