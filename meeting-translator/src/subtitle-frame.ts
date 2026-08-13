export type SubtitleHistoryLine = { id?: number; o: string; t: string };

export type SubtitleFrameSettings = {
  bilingual: boolean;
  historyRows: 0 | 1 | 2;
};

export type SubtitleFramePayload = {
  history: SubtitleHistoryLine[];
  curO: string;
  curT: string;
};

export type SubtitleFrameRow = {
  role: "history" | "history-placeholder" | "current-trans" | "current-orig" | "current-placeholder-trans" | "current-placeholder-orig" | "empty" | "empty-sub";
  text: string;
  className: string;
  key?: string;
  age?: number;
};

export type CaptionFrame = {
  historyRows: SubtitleFrameRow[];
  currentRows: SubtitleFrameRow[];
  emptyRows: SubtitleFrameRow[];
  showHistory: boolean;
  showCurrent: boolean;
  showEmpty: boolean;
  visibleHistoryCount: number;
};

const PLACEHOLDER = "\u00a0";

/**
 * Pure display-frame builder. Maps engine state + settings to the rows the
 * overlay should paint. No DOM, timers, or network.
 */
export function buildCaptionFrame(
  payload: SubtitleFramePayload,
  settings: SubtitleFrameSettings,
): CaptionFrame {
  const historyLimit = settings.historyRows === 0 ? 0 : settings.historyRows;
  const visibleHistory = historyLimit === 0
    ? []
    : payload.history.filter((item) => Boolean(item.t)).slice(-historyLimit);
  // Keep the last completed original on screen until the next original chunk.
  const lastOriginal = visibleHistory.length ? visibleHistory[visibleHistory.length - 1].o : "";

  const historyRows: SubtitleFrameRow[] = [];
  const missingHistoryRows = historyLimit - visibleHistory.length;
  for (let index = 0; index < missingHistoryRows; index++) {
    const age = historyLimit - index;
    historyRows.push({
      role: "history-placeholder",
      text: PLACEHOLDER,
      className: `line trans age-${age} pending history-placeholder`,
      key: `history-placeholder:${age}`,
      age,
    });
  }
  for (let index = 0; index < visibleHistory.length; index++) {
    const age = visibleHistory.length - index;
    const item = visibleHistory[index];
    // History never shows original text — only translation.
    historyRows.push({
      role: "history",
      text: item.t,
      className: `line trans age-${age}`,
      key: `${item.id ?? index}:t`,
      age,
    });
  }

  const currentRows: SubtitleFrameRow[] = [];
  if (settings.bilingual) {
    if (payload.curT) {
      currentRows.push({
        role: "current-trans",
        text: payload.curT,
        className: "line trans cur",
        key: "current:trans",
      });
      // Reserve original row so late English does not shift layout.
      const originText = payload.curO || lastOriginal;
      currentRows.push({
        role: "current-orig",
        text: originText || PLACEHOLDER,
        className: originText ? "line orig cur" : "line orig cur pending",
        key: "current:orig",
      });
    } else if (payload.curO) {
      // Keep the current row pair stable while translation is between chunks.
      currentRows.push({
        role: "current-placeholder-trans",
        text: PLACEHOLDER,
        className: "line trans cur pending",
        key: "current:trans",
      });
      currentRows.push({
        role: "current-orig",
        text: payload.curO,
        className: "line orig cur",
        key: "current:orig",
      });
    }
  } else if (payload.curT) {
    currentRows.push({
      role: "current-trans",
      text: payload.curT,
      className: "line trans cur",
      key: "current:trans",
    });
  }

  // Keep current-group structure while history is visible and current is empty
  // (gap between commit and next translation chunk).
  if (currentRows.length === 0 && visibleHistory.length > 0) {
    currentRows.push({
      role: "current-placeholder-trans",
      text: PLACEHOLDER,
      className: "line trans cur pending",
      key: "current:trans",
    });
    if (settings.bilingual) {
      const originText = payload.curO || lastOriginal;
      currentRows.push({
        role: originText ? "current-orig" : "current-placeholder-orig",
        text: originText || PLACEHOLDER,
        className: originText ? "line orig cur" : "line orig cur pending",
        key: "current:orig",
      });
    }
  }

  const isTrulyEmpty = !payload.history.length && !payload.curO && !payload.curT;
  const emptyRows: SubtitleFrameRow[] = [];
  if (isTrulyEmpty) {
    emptyRows.push({
      role: "empty",
      text: "等待音频...",
      className: "empty",
    });
    if (settings.bilingual) {
      emptyRows.push({
        role: "empty-sub",
        text: "Waiting for audio...",
        className: "empty-sub",
      });
    }
  }

  return {
    historyRows,
    currentRows,
    emptyRows,
    showHistory: historyLimit > 0,
    showCurrent: currentRows.length > 0,
    showEmpty: emptyRows.length > 0,
    visibleHistoryCount: visibleHistory.length,
  };
}

/** Whether a history line should be promoted from the live current node. */
export function shouldPromoteCurrentToHistory(
  outgoingCurrentText: string,
  historyRows: SubtitleFrameRow[],
): boolean {
  const trimmed = outgoingCurrentText.trim();
  if (!trimmed || trimmed === PLACEHOLDER) return false;
  return historyRows.some((row) => row.text === trimmed);
}

export function frameRowTexts(frame: CaptionFrame): {
  history: string[];
  current: string[];
  empty: string[];
} {
  return {
    history: frame.historyRows.map((row) => row.text),
    current: frame.currentRows.map((row) => row.text),
    empty: frame.emptyRows.map((row) => row.text),
  };
}
