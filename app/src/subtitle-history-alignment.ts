export type AlignedHistoryLine = { id: number; o: string; t: string; edited?: boolean; aligned?: boolean };
export type HistoryAlignmentSnapshot = {
  history: AlignedHistoryLine[];
  curO: string;
  curT: string;
  /** Stable id of the sentence currently being produced, null when idle. */
  curId: number | null;
};

type Track = "original" | "translation";

export class SubtitleHistoryAlignment {
  hist: AlignedHistoryLine[] = [];

  private originalCurrent = "";
  private translationCurrent = "";
  private originalCompleted: string[] = [];
  private translationCompleted: string[] = [];
  /** Pending sentence ids, kept in sync with the completed queues. */
  private originalPendingIds: number[] = [];
  private translationPendingIds: number[] = [];
  private originalCurrentId: number | null = null;
  private translationCurrentId: number | null = null;
  private nextHistoryId = 1;
  private readonly maxHistory: number;
  private readonly onChange: () => void;

  constructor(options: { maxHistory?: number; onChange?: () => void } = {}) {
    this.maxHistory = options.maxHistory ?? 200;
    this.onChange = options.onChange ?? (() => {});
  }

  appendOriginal(text: string, finished = false) {
    this.append("original", text, finished);
  }

  appendTranslation(text: string, finished = false) {
    this.append("translation", text, finished);
  }

  completeTurn() {
    this.finishTrack("original");
    this.finishTrack("translation");
    this.pairCompleted();
    this.flushUnmatched();
    this.onChange();
  }

  reset() {
    this.hist = [];
    this.nextHistoryId = 1;
    this.resetCurrent();
    this.onChange();
  }

  resetCurrent() {
    this.originalCurrent = "";
    this.translationCurrent = "";
    this.originalCompleted = [];
    this.translationCompleted = [];
    this.originalPendingIds = [];
    this.translationPendingIds = [];
    this.originalCurrentId = null;
    this.translationCurrentId = null;
  }

  clearHistory() {
    this.hist = [];
    this.nextHistoryId = 1;
    this.onChange();
  }

  replaceHistory(items: Array<{ o: string; t: string; edited?: boolean; aligned?: boolean }>) {
    const previousIds = new Map<string, number[]>();
    for (const item of this.hist) {
      const key = `${item.o}\u0000${item.t}`;
      const ids = previousIds.get(key) || [];
      ids.push(item.id);
      previousIds.set(key, ids);
    }
    this.hist = items
      .filter((item) => item.o || item.t)
      .map((item) => {
        const o = item.o || "";
        const t = item.t || "";
        const key = `${o}\u0000${t}`;
        const existingId = previousIds.get(key)?.shift();
        return {
          id: existingId ?? this.nextHistoryId++,
          o,
          t,
          ...(item.edited ? { edited: true } : {}),
          ...(item.aligned ? { aligned: true } : {}),
        };
      });
    this.nextHistoryId = Math.max(this.nextHistoryId, this.hist.reduce((max, item) => Math.max(max, item.id + 1), 1));
    this.onChange();
  }

  markEdited(ids: Iterable<number>) {
    const set = new Set(ids);
    this.hist = this.hist.map((line) =>
      set.has(line.id) && !line.edited ? { ...line, edited: true } : line,
    );
    this.onChange();
  }

  replaceHistoryItems(
    items: Array<{ id: number; o: string; t: string }>,
    options: { preserveEdited?: boolean; preserveAligned?: boolean; markAligned?: boolean } = {},
  ) {
    const previousEdited = options.preserveEdited
      ? new Set(this.hist.filter((line) => line.edited).map((line) => line.id))
      : new Set<number>();
    const previousAligned = options.preserveAligned
      ? new Set(this.hist.filter((line) => line.aligned).map((line) => line.id))
      : new Set<number>();
    this.hist = items
      .filter((item) => item.o || item.t)
      .map((item) => ({
        id: item.id,
        o: item.o || "",
        t: item.t || "",
        ...(previousEdited.has(item.id) ? { edited: true } : {}),
        ...(options.markAligned || previousAligned.has(item.id) ? { aligned: true } : {}),
      }));
    this.nextHistoryId = Math.max(this.nextHistoryId, this.hist.reduce((max, item) => Math.max(max, item.id + 1), 1));
    this.onChange();
  }

  updateHistoryItems(items: Array<{ id: number; o: string; t: string }>) {
    const changes = new Map(items.map((item) => [item.id, item]));
    this.replaceHistoryItems(this.hist.map((item) => changes.get(item.id) || item), {
      preserveEdited: true,
      preserveAligned: true,
    });
  }

  snapshot(): HistoryAlignmentSnapshot {
    return {
      history: this.hist.map((item) => ({ ...item })),
      curO: joinFragments([...this.originalCompleted, this.originalCurrent], "original"),
      curT: joinFragments([...this.translationCompleted, this.translationCurrent], "translation"),
      curId:
        this.originalPendingIds[0] ??
        this.originalCurrentId ??
        this.translationPendingIds[0] ??
        this.translationCurrentId ??
        null,
    };
  }

  private append(track: Track, text: string, finished: boolean) {
    if (text) this.setCurrent(track, `${this.getCurrent(track)}${text}`);
    this.drainCompleted(track);
    if (finished) this.finishTrack(track);
    this.pairCompleted();
    this.onChange();
  }

  private drainCompleted(track: Track) {
    const current = this.getCurrent(track);
    const language = track === "original" ? "en" : "zh";
    const { sentences, remainder } = splitCompletedSentences(current, language);
    this.setCurrent(track, remainder);
    let currentId = this.getCurrentId(track);
    if (current && currentId === null) currentId = this.nextHistoryId++;
    for (let index = 0; index < sentences.length; index++) {
      this.getPendingIds(track).push(currentId ?? this.nextHistoryId++);
      currentId = null;
    }
    if (remainder && currentId === null) currentId = this.nextHistoryId++;
    this.setCurrentId(track, currentId);
    this.getCompleted(track).push(...sentences);
  }

  private finishTrack(track: Track) {
    const current = this.getCurrent(track).trim();
    if (current) {
      this.getCompleted(track).push(current);
      this.getPendingIds(track).push(this.getCurrentId(track) ?? this.nextHistoryId++);
    }
    this.setCurrent(track, "");
    this.setCurrentId(track, null);
  }

  private pairCompleted() {
    while (this.originalCompleted.length > 0 && this.translationCompleted.length > 0) {
      this.commit(
        this.originalCompleted.shift()!,
        this.translationCompleted.shift()!,
        this.originalPendingIds.shift() ?? null,
        this.translationPendingIds.shift() ?? null,
      );
    }
  }

  private flushUnmatched() {
    while (this.originalCompleted.length > 0 || this.translationCompleted.length > 0) {
      this.commit(
        this.originalCompleted.shift() || "",
        this.translationCompleted.shift() || "",
        this.originalPendingIds.shift() ?? null,
        this.translationPendingIds.shift() ?? null,
      );
    }
  }

  private commit(o: string, t: string, originalId: number | null, translationId: number | null) {
    if (!o && !t) return;
    this.hist.push({ id: originalId ?? translationId ?? this.nextHistoryId++, o, t });
    if (this.hist.length > this.maxHistory) this.hist.shift();
  }

  private getCurrent(track: Track) {
    return track === "original" ? this.originalCurrent : this.translationCurrent;
  }

  private setCurrent(track: Track, text: string) {
    if (track === "original") this.originalCurrent = text;
    else this.translationCurrent = text;
  }

  private getCompleted(track: Track) {
    return track === "original" ? this.originalCompleted : this.translationCompleted;
  }

  private getPendingIds(track: Track) {
    return track === "original" ? this.originalPendingIds : this.translationPendingIds;
  }

  private getCurrentId(track: Track) {
    return track === "original" ? this.originalCurrentId : this.translationCurrentId;
  }

  private setCurrentId(track: Track, id: number | null) {
    if (track === "original") this.originalCurrentId = id;
    else this.translationCurrentId = id;
  }
}

export function splitCompletedSentences(text: string, language: "zh" | "en") {
  const endings = language === "zh"
    ? new Set(["。", "！", "？", "!", "?", "；", ";"])
    : new Set([".", "!", "?", "；", ";"]);
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!endings.has(char)) continue;
    if (language === "en" && char === "." && /\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) continue;
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }

  return { sentences, remainder: text.slice(start) };
}

function joinFragments(fragments: string[], track: Track) {
  return fragments.filter(Boolean).reduce((result, fragment) => {
    if (!result) return fragment;
    if (track === "translation") return `${result}${fragment}`;
    return `${result}${/\s$/.test(result) || /^\s/.test(fragment) ? "" : " "}${fragment}`;
  }, "");
}