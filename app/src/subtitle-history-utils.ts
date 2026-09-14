export type HistoryMode = "zh" | "en" | "zh-sentence" | "en-sentence" | "bilingual";
export type HistoryLine = { id?: number; o: string; t: string; edited?: boolean; aligned?: boolean };
export type HistoryDisplayRow = { id?: number; sourceIds?: number[]; zh: string; en: string };

export const HISTORY_MODES: Array<{ value: HistoryMode; label: string }> = [
  { value: "zh", label: "仅中文" },
  { value: "en", label: "仅英文" },
  { value: "zh-sentence", label: "中文单句" },
  { value: "en-sentence", label: "英文单句" },
  { value: "bilingual", label: "中英双语" },
];

export function isHistoryMode(value: unknown): value is HistoryMode {
  return typeof value === "string" && HISTORY_MODES.some((mode) => mode.value === value);
}

export function isHistoryRevisionFresh(currentRevision: number, nextRevision?: number) {
  return nextRevision === undefined ? currentRevision === 0 : nextRevision >= currentRevision;
}

export function buildHistoryRows(history: HistoryLine[], mode: HistoryMode, editedIds?: Set<number>): HistoryDisplayRow[] {
  if (mode === "zh") {
    const text = joinField(history, "t");
    return text ? [{ id: lastHistoryId(history), sourceIds: historyIds(history), zh: text, en: "" }] : [];
  }
  if (mode === "en") {
    const text = joinField(history, "o");
    return text ? [{ id: lastHistoryId(history), sourceIds: historyIds(history), zh: "", en: text }] : [];
  }
  if (mode === "zh-sentence") {
    return history.flatMap((item) =>
      isFixed(item, editedIds)
        ? [{ id: 1, sourceIds: item.id === undefined ? [] : [item.id], zh: item.t || "", en: "" }]
        : splitSentences(item.t, "zh").map((text, index) => ({
            id: index + 1,
            sourceIds: item.id === undefined ? [] : [item.id],
            zh: text,
            en: "",
          })),
    );
  }
  if (mode === "en-sentence") {
    return history.flatMap((item) =>
      isFixed(item, editedIds)
        ? [{ id: 1, sourceIds: item.id === undefined ? [] : [item.id], zh: "", en: item.o || "" }]
        : splitSentences(item.o, "en").map((text, index) => ({
            id: index + 1,
            sourceIds: item.id === undefined ? [] : [item.id],
            zh: "",
            en: text,
          })),
    );
  }

  const hasMultiSentenceRecord = history.some((item) =>
    !isFixed(item, editedIds)
    && (splitSentences(item.o, "en").length > 1 || splitSentences(item.t, "zh").length > 1),
  );
  if (!hasMultiSentenceRecord) {
    return history
      .filter((item) => item.o || item.t)
      .map((item) => ({ id: item.id, zh: item.t, en: item.o }));
  }

  // Fixed records stay as whole lines; the rest split by sentence for alignment.
  const zh: Array<{ text: string; id?: number }> = [];
  const en: Array<{ text: string; id?: number }> = [];
  for (const item of history) {
    if (isFixed(item, editedIds)) {
      zh.push({ text: item.t, id: item.id });
      en.push({ text: item.o, id: item.id });
      continue;
    }
    for (const text of splitSentences(item.t, "zh")) zh.push({ text, id: item.id });
    for (const text of splitSentences(item.o, "en")) en.push({ text, id: item.id });
  }
  const length = Math.max(zh.length, en.length);
  return Array.from({ length }, (_, index) => ({
    id: index + 1,
    sourceIds: uniqueIds([zh[index]?.id, en[index]?.id]),
    zh: zh[index]?.text || "",
    en: en[index]?.text || "",
  })).filter((row) => row.zh || row.en);
}

function isFixed(item: HistoryLine, editedIds?: Set<number>) {
  return item.aligned === true || (item.id !== undefined && editedIds !== undefined && editedIds.has(item.id));
}

export function historyRowCopyValue(row: HistoryDisplayRow, mode: HistoryMode) {
  if (mode === "en" || mode === "en-sentence") return row.en;
  if (mode === "bilingual") return `${row.zh}${row.zh && row.en ? " " : ""}${row.en}`;
  return row.zh;
}

export function splitSentences(text: string, language: "zh" | "en") {
  const sentenceEndings = language === "zh"
    ? new Set(["。", "！", "？", "!", "?", "；", ";"])
    : new Set([".", "!", "?", "；", ";"]);
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!sentenceEndings.has(char)) continue;
    if (language === "en" && char === "." && /\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) continue;
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function joinField(history: HistoryLine[], field: "o" | "t") {
  const values = history.map((item) => item[field]).filter(Boolean);
  if (field === "t") return values.join("");
  return values.reduce((result, value) => {
    if (!result) return value;
    return `${result}${/\s$/.test(result) || /^\s/.test(value) ? "" : " "}${value}`;
  }, "");
}

function lastHistoryId(history: HistoryLine[]) {
  return history.length ? history[history.length - 1].id : undefined;
}

function historyIds(history: HistoryLine[]) {
  return history.flatMap((item) => item.id === undefined ? [] : [item.id]);
}

function uniqueIds(values: Array<number | undefined>) {
  return Array.from(new Set(values.filter((value): value is number => value !== undefined)));
}