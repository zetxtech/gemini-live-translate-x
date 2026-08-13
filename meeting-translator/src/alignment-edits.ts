import { splitSentences } from "./subtitle-history-utils";

export type AlignedLine = { id: number; o: string; t: string; edited?: boolean };

export type SentenceUnit = {
  id: string;
  lineId: number;
  text: string;
  source: AlignedLine;
};

export type SentencePair = { o: string | null; t: string | null };

export type AlignmentEdit =
  | { op: "move"; id: number; offset: number }
  | { op: "update"; id: number; o?: string; t?: string }
  | { op: "insert"; after: number; o: string; t: string }
  | { op: "replace"; start: number; end: number; items: Array<{ o: string; t: string }> }
  | { op: "remap"; pairs: Array<{ o: number; t: number | null }> }
  | { op: "sentence-pairs"; pairs: SentencePair[] };

export type ApplyReport = {
  lines: AlignedLine[];
  /** Edits that could not be applied and why, for feeding back to the model. */
  invalid: Array<{ edit: AlignmentEdit; reason: string }>;
  applied: number;
  changed: boolean;
};

export type ChunkRange = { start: number; end: number };

// 把长列表分成带重叠的分块；长度不超过块大小时返回单块。
export function chunkRanges(total: number, chunkSize: number, overlap: number): ChunkRange[] {
  if (total <= 0) return [];
  if (total <= chunkSize) return [{ start: 0, end: total }];
  const ranges: ChunkRange[] = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let start = 0; start < total; start += step) {
    ranges.push({ start, end: Math.min(start + chunkSize, total) });
  }
  return ranges;
}

export function buildSentenceUnits(lines: AlignedLine[]) {
  const originals: SentenceUnit[] = [];
  const translations: SentenceUnit[] = [];
  for (const line of lines) {
    splitSentences(line.o, "en").forEach((text, index) => {
      originals.push({ id: `O${line.id}-${index + 1}`, lineId: line.id, text, source: line });
    });
    splitSentences(line.t, "zh").forEach((text, index) => {
      translations.push({ id: `T${line.id}-${index + 1}`, lineId: line.id, text, source: line });
    });
  }
  return { originals, translations };
}

// 解析模型返回的对齐结果；优先支持 {"rows":[{"o":id,"t":id|0},...]} 配对格式，
// 兼容旧的 {"edits":[...]} 操作指令（含代码块包裹及前后散文）。
export function parseAlignmentEdits(text: string): AlignmentEdit[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const candidates = [cleaned];
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(cleaned.slice(firstBracket, lastBracket + 1));
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rows = !Array.isArray(parsed) ? (parsed as { rows?: unknown }).rows : undefined;
    if (Array.isArray(rows)) {
      const pairs = rows
        .map(parseRemapPair)
        .filter((pair): pair is { o: number; t: number | null } => pair !== null);
      return pairs.length ? [{ op: "remap", pairs }] : [];
    }
    const rawPairs = !Array.isArray(parsed) ? (parsed as { pairs?: unknown }).pairs : undefined;
    if (Array.isArray(rawPairs)) {
      const pairs = rawPairs
        .map(parseSentencePair)
        .filter((pair): pair is SentencePair => pair !== null);
      return pairs.length ? [{ op: "sentence-pairs", pairs }] : [];
    }
    const rawEdits = Array.isArray(parsed) ? parsed : (parsed as { edits?: unknown }).edits;
    if (!Array.isArray(rawEdits)) continue;
    const edits = rawEdits.map(parseEdit).filter((edit): edit is AlignmentEdit => edit !== null);
    if (edits.length) return edits;
  }
  throw new Error(`模型返回的对齐结果为空或格式无效（${cleaned.replace(/\s+/g, " ").slice(0, 120) || "(空)"}）`);
}

function parseRemapPair(value: unknown): { o: number; t: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const pair = value as Record<string, unknown>;
  const o = asId(pair.o);
  if (o === null || o <= 0) return null;
  const t = pair.t === null || pair.t === undefined || pair.t === 0 ? null : asId(pair.t);
  if (pair.t !== null && pair.t !== undefined && pair.t !== 0 && (t === null || t <= 0)) return null;
  return { o, t };
}

function parseSentencePair(value: unknown): SentencePair | null {
  if (!value || typeof value !== "object") return null;
  const pair = value as Record<string, unknown>;
  const o = typeof pair.o === "string" && pair.o.trim() ? pair.o.trim() : null;
  const t = typeof pair.t === "string" && pair.t.trim() ? pair.t.trim() : null;
  if (o === null && t === null) return null;
  return { o, t };
}

function parseEdit(value: unknown): AlignmentEdit | null {
  if (!value || typeof value !== "object") return null;
  const edit = value as Record<string, unknown>;
  switch (edit.op) {
    case "move": {
      const id = asId(edit.id);
      const offset = asId(edit.offset);
      if (id === null || offset === null || offset === 0) return null;
      return { op: "move", id, offset };
    }
    case "update": {
      const id = asId(edit.id);
      if (id === null) return null;
      const o = typeof edit.o === "string" ? edit.o : undefined;
      const t = typeof edit.t === "string" ? edit.t : undefined;
      if (o === undefined && t === undefined) return null;
      return { op: "update", id, o, t };
    }
    case "insert": {
      const after = asId(edit.after);
      if (after === null || typeof edit.o !== "string" || typeof edit.t !== "string") return null;
      return { op: "insert", after, o: edit.o, t: edit.t };
    }
    case "replace": {
      const start = asId(edit.start);
      const end = asId(edit.end);
      if (start === null || end === null || end < start) return null;
      const items = Array.isArray(edit.items)
        ? edit.items
            .filter((item): item is { o: unknown; t: unknown } => !!item && typeof item === "object")
            .map((item) => ({ o: typeof item.o === "string" ? item.o : "", t: typeof item.t === "string" ? item.t : "" }))
        : [];
      return { op: "replace", start, end, items };
    }
    case "remap": {
      if (!Array.isArray(edit.pairs)) return null;
      const pairs = edit.pairs
        .map(parseRemapPair)
        .filter((pair): pair is { o: number; t: number | null } => pair !== null);
      if (!pairs.length) return null;
      return { op: "remap", pairs };
    }
    default:
      return null;
  }
}

function asId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

// 按顺序应用编辑指令（id 全局唯一，按 id 定位，不受位置偏移影响）。
// 无法应用的编辑不会静默跳过：收集到 invalid 明细，供调用方反馈给模型重试。
export function applyAlignmentEdits(lines: AlignedLine[], edits: AlignmentEdit[]): ApplyReport {
  let nextId = lines.reduce((max, line) => Math.max(max, line.id + 1), 1);
  const result = lines.map((line) => ({ ...line }));
  const invalid: Array<{ edit: AlignmentEdit; reason: string }> = [];
  let applied = 0;
  for (const edit of edits) {
    switch (edit.op) {
      case "update": {
        const index = result.findIndex((line) => line.id === edit.id);
        if (index < 0) {
          invalid.push({ edit, reason: `id ${edit.id} 不存在` });
          break;
        }
        if (edit.o !== undefined && result[index].o && !edit.o.trim()) {
          invalid.push({ edit, reason: `id ${edit.id} 不能清空已有的 ORIGINAL 内容` });
          break;
        }
        if (edit.t !== undefined && result[index].t && !edit.t.trim()) {
          invalid.push({ edit, reason: `id ${edit.id} 不能清空已有的 TRANSLATION 内容` });
          break;
        }
        const next = { ...result[index], o: edit.o ?? result[index].o, t: edit.t ?? result[index].t };
        if (next.o === result[index].o && next.t === result[index].t) {
          invalid.push({ edit, reason: `id ${edit.id} 的 update 与当前内容相同` });
          break;
        }
        result[index] = next;
        applied++;
        break;
      }
      case "move": {
        const index = result.findIndex((line) => line.id === edit.id);
        if (index < 0) {
          invalid.push({ edit, reason: `id ${edit.id} 不存在` });
          break;
        }
        const target = index + edit.offset;
        if (target < 0 || target >= result.length) {
          invalid.push({ edit, reason: `偏移 ${edit.offset} 越界（id ${edit.id} 当前在第 ${index + 1} 位，共 ${result.length} 行）` });
          break;
        }
        [result[index], result[target]] = [result[target], result[index]];
        applied++;
        break;
      }
      case "insert": {
        const index = result.findIndex((line) => line.id === edit.after);
        if (index < 0) {
          invalid.push({ edit, reason: `锚点 id ${edit.after} 不存在` });
          break;
        }
        result.splice(index + 1, 0, { id: nextId++, o: edit.o, t: edit.t });
        applied++;
        break;
      }
      case "replace": {
        const startIndex = result.findIndex((line) => line.id === edit.start);
        if (startIndex < 0) {
          invalid.push({ edit, reason: `起始 id ${edit.start} 不存在` });
          break;
        }
        const endIndex = result.findIndex((line) => line.id === edit.end);
        if (endIndex < 0) {
          invalid.push({ edit, reason: `结束 id ${edit.end} 不存在` });
          break;
        }
        if (endIndex < startIndex) {
          invalid.push({ edit, reason: `结束 id ${edit.end} 在起始 id ${edit.start} 之前` });
          break;
        }
        const replacedLines = result.slice(startIndex, endIndex + 1);
        const loss = replacementContentLoss(replacedLines, edit.items);
        if (loss) {
          invalid.push({ edit, reason: loss });
          break;
        }
        const items = edit.items.map((item) => ({ id: nextId++, o: item.o, t: item.t }));
        result.splice(startIndex, endIndex - startIndex + 1, ...items);
        applied++;
        break;
      }
      case "remap": {
        const reason = validateRemap(edit.pairs, result);
        if (reason) {
          invalid.push({ edit, reason });
          break;
        }
        // 部分覆盖：只移动被列出的译文，未提及的行保持原样；被借走译文的行自动置空。
        const translations = new Map<number, string>();
        const oIds = new Set(edit.pairs.map((pair) => pair.o));
        for (const pair of edit.pairs) {
          const tIndex = pair.t === null ? -1 : result.findIndex((line) => line.id === pair.t);
          translations.set(pair.o, tIndex < 0 ? "" : result[tIndex].t);
        }
        for (const pair of edit.pairs) {
          if (pair.t !== null && !oIds.has(pair.t)) translations.set(pair.t, "");
        }
        for (let i = 0; i < result.length; i++) {
          const translation = translations.get(result[i].id);
          if (translation !== undefined) result[i] = { ...result[i], t: translation };
        }
        applied++;
        break;
      }
      case "sentence-pairs": {
        const report = applySentencePairs(result, edit.pairs);
        if (report.reason) {
          invalid.push({ edit, reason: report.reason });
          break;
        }
        result.splice(0, result.length, ...report.lines);
        applied++;
        break;
      }
    }
  }
  const duplicate = findNewDuplicate(lines, result);
  if (duplicate) {
    result.splice(0, result.length, ...lines.map((line) => ({ ...line })));
    applied = 0;
    invalid.push({
      edit: edits[edits.length - 1],
      reason: `编辑会新增重复的 ${duplicate} 内容`,
    });
  }
  const changed = lines.length !== result.length || lines.some((line, index) => {
    const next = result[index];
    return !next || line.o !== next.o || line.t !== next.t;
  });
  return { lines: result, invalid, applied, changed };
}

function applySentencePairs(lines: AlignedLine[], pairs: SentencePair[]) {
  const { originals, translations } = buildSentenceUnits(lines);
  const originalsById = new Map(originals.map((unit) => [unit.id, unit]));
  const translationsById = new Map(translations.map((unit) => [unit.id, unit]));
  const usedOriginals = new Set<string>();
  const usedTranslations = new Set<string>();

  for (const pair of pairs) {
    if (pair.o !== null) {
      if (!originalsById.has(pair.o)) return { lines, reason: `sentence pair 引用的 ORIGINAL ${pair.o} 不存在` };
      if (usedOriginals.has(pair.o)) return { lines, reason: `sentence pair 重复引用 ORIGINAL ${pair.o}` };
      usedOriginals.add(pair.o);
    }
    if (pair.t !== null) {
      if (!translationsById.has(pair.t)) return { lines, reason: `sentence pair 引用的 TRANSLATION ${pair.t} 不存在` };
      if (usedTranslations.has(pair.t)) return { lines, reason: `sentence pair 重复引用 TRANSLATION ${pair.t}` };
      usedTranslations.add(pair.t);
    }
  }
  if (usedOriginals.size !== originals.length) {
    return { lines, reason: `sentence pairs 遗漏了 ${originals.length - usedOriginals.size} 个 ORIGINAL` };
  }
  if (usedTranslations.size !== translations.length) {
    return { lines, reason: `sentence pairs 遗漏了 ${translations.length - usedTranslations.size} 个 TRANSLATION` };
  }

  const originalPositions = new Map(originals.map((unit, index) => [unit.id, index]));
  const translationPositions = new Map(translations.map((unit, index) => [unit.id, index]));
  const orderedPairs = pairs
    .map((pair, index) => ({ pair, index }))
    .sort((left, right) => {
      const leftPosition = left.pair.o === null
        ? translationPositions.get(left.pair.t!)!
        : originalPositions.get(left.pair.o)!;
      const rightPosition = right.pair.o === null
        ? translationPositions.get(right.pair.t!)!
        : originalPositions.get(right.pair.o)!;
      return leftPosition - rightPosition || left.index - right.index;
    })
    .map(({ pair }) => pair);

  const usedLineIds = new Set<number>();
  let nextId = lines.reduce((max, line) => Math.max(max, line.id + 1), 1);
  const rebuilt = orderedPairs.map((pair) => {
    const original = pair.o === null ? undefined : originalsById.get(pair.o);
    const translation = pair.t === null ? undefined : translationsById.get(pair.t);
    const preferredId = original?.lineId ?? translation?.lineId;
    let id = preferredId;
    if (id === undefined || usedLineIds.has(id)) {
      while (usedLineIds.has(nextId)) nextId++;
      id = nextId++;
    }
    usedLineIds.add(id);
    const source = original?.source ?? translation!.source;
    return {
      id,
      o: original?.text || "",
      t: translation?.text || "",
      ...(source.edited ? { edited: true } : {}),
    };
  });
  return { lines: rebuilt, reason: null };
}

function replacementContentLoss(
  replacedLines: AlignedLine[],
  replacementItems: Array<{ o: string; t: string }>,
) {
  const fields: Array<["o" | "t", string]> = [
    ["o", "ORIGINAL"],
    ["t", "TRANSLATION"],
  ];
  for (const [field, label] of fields) {
    const before = normalizeConservedText(replacedLines.map((line) => line[field]).join(""));
    const after = normalizeConservedText(replacementItems.map((item) => item[field]).join(""));
    if (before !== after) return `replace 不能丢失或新增已有的 ${label} 内容`;
  }
  return null;
}

// remap 部分覆盖：o/t 引用 LINES 块中显示的 id，同一原文至多一次、非空译文至多一次；
// 未提及的行保持原样，被借走译文的行自动置空，译文不会丢失或复制。
function validateRemap(pairs: Array<{ o: number; t: number | null }>, lines: AlignedLine[]): string | null {
  const indexOf = (id: number) => lines.findIndex((line) => line.id === id);
  const usedO = new Set<number>();
  const usedT = new Set<number>();
  for (const pair of pairs) {
    const oIndex = indexOf(pair.o);
    if (oIndex < 0) return `remap 引用的 o=${pair.o} 不存在`;
    if (usedO.has(oIndex)) return `remap 重复引用了 id ${pair.o} 的 ORIGINAL`;
    usedO.add(oIndex);
    if (pair.t === null) {
      if (lines[oIndex].t) return `remap 不能置空 id ${pair.o} 的非空 TRANSLATION（译文只能通过被其他行引用而移走）`;
      continue;
    }
    const tIndex = indexOf(pair.t);
    if (tIndex < 0) return `remap 引用的 t=${pair.t} 不存在`;
    if (usedT.has(tIndex)) return `remap 重复使用了 id ${pair.t} 的 TRANSLATION`;
    usedT.add(tIndex);
    if (!lines[tIndex].t) return `remap 引用的 t=${pair.t} 没有可移动的 TRANSLATION`;
  }
  return null;
}

function normalizeConservedText(text: string) {
  return text.replace(/\s+/g, "");
}

function findNewDuplicate(before: AlignedLine[], after: AlignedLine[]) {
  const fields: Array<["o" | "t", string]> = [
    ["o", "ORIGINAL"],
    ["t", "TRANSLATION"],
  ];
  for (const [field, label] of fields) {
    const beforeCounts = countText(before, field);
    const afterCounts = countText(after, field);
    for (const [text, count] of afterCounts) {
      if (count > 1 && count > (beforeCounts.get(text) || 0)) return label;
    }
  }
  return null;
}

function countText(lines: AlignedLine[], field: "o" | "t") {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const language = field === "o" ? "en" : "zh";
    for (const sentence of splitSentences(line[field], language)) {
      const text = sentence.replace(/\s+/g, " ").trim();
      if (text) counts.set(text, (counts.get(text) || 0) + 1);
    }
  }
  return counts;
}
