export type SentenceHistoryItem = { id: number; o: string; t: string };
export type SentenceCutEngineOptions = {
  now?: () => number;
  setTimeoutFn?: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  minCommaBreakChars?: number;
  minPacketTailChars?: number;
  minSentenceCutChars?: number;
  minSentenceCutDelayMs?: number;
  speechIntervalWindowMs?: number;
  defaultShortTailTimeoutMs?: number;
  maxHistory?: number;
  sentenceBreaksEnabled?: () => boolean;
  onChange?: () => void;
  onDebug?: (message: string) => void;
};

const DEFAULT_MIN_COMMA_BREAK_CHARS = 5;
const DEFAULT_MIN_PACKET_TAIL_CHARS = 4;
const DEFAULT_MIN_SENTENCE_CUT_CHARS = 4;
const DEFAULT_MIN_SENTENCE_CUT_DELAY_MS = 500;
const DEFAULT_SPEECH_INTERVAL_WINDOW_MS = 30_000;
const DEFAULT_SHORT_TAIL_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_HISTORY = 50;

export class SentenceCutEngine {
  curO = "";
  curT = "";
  hist: SentenceHistoryItem[] = [];
  nextHistoryId = 1;

  private pendingSentenceCutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSentenceCutAction: (() => void) | null = null;
  private pendingShortTail: { tail: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private pendingCutAwaitingReadable = false;
  private pendingCutText = "";
  private cutHoldActive = false;
  private readyToCommit = false;
  private translationPacketTimes: number[] = [];

  private readonly now: () => number;
  private readonly setTimeoutFn: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void;
  private readonly minCommaBreakChars: number;
  private readonly minPacketTailChars: number;
  private readonly minSentenceCutChars: number;
  private readonly minSentenceCutDelayMs: number;
  private readonly speechIntervalWindowMs: number;
  private readonly defaultShortTailTimeoutMs: number;
  private readonly maxHistory: number;
  private readonly sentenceBreaksEnabled: () => boolean;
  private readonly onChange: () => void;
  private readonly onDebug: (message: string) => void;

  constructor(options: SentenceCutEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
    this.minCommaBreakChars = options.minCommaBreakChars ?? DEFAULT_MIN_COMMA_BREAK_CHARS;
    this.minPacketTailChars = options.minPacketTailChars ?? DEFAULT_MIN_PACKET_TAIL_CHARS;
    this.minSentenceCutChars = options.minSentenceCutChars ?? DEFAULT_MIN_SENTENCE_CUT_CHARS;
    this.minSentenceCutDelayMs = options.minSentenceCutDelayMs ?? DEFAULT_MIN_SENTENCE_CUT_DELAY_MS;
    this.speechIntervalWindowMs = options.speechIntervalWindowMs ?? DEFAULT_SPEECH_INTERVAL_WINDOW_MS;
    this.defaultShortTailTimeoutMs = options.defaultShortTailTimeoutMs ?? DEFAULT_SHORT_TAIL_TIMEOUT_MS;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.sentenceBreaksEnabled = options.sentenceBreaksEnabled ?? (() => true);
    this.onChange = options.onChange ?? (() => {});
    this.onDebug = options.onDebug ?? (() => {});
  }

  reset() {
    this.clearPendingSentenceCut();
    this.clearPendingShortTail();
    this.curO = "";
    this.curT = "";
    this.hist = [];
    this.nextHistoryId = 1;
    this.readyToCommit = false;
    this.translationPacketTimes = [];
    this.onChange();
  }

  resetCurrent() {
    this.clearPendingSentenceCut();
    this.clearPendingShortTail();
    this.curO = "";
    this.curT = "";
    this.readyToCommit = false;
    this.translationPacketTimes = [];
  }

  clearHistory() {
    this.hist = [];
    this.nextHistoryId = 1;
    this.onChange();
  }

  flushReadySentence() {
    if (!this.readyToCommit) return;
    this.readyToCommit = false;
    this.commitCurrentSentenceNow();
    this.onChange();
  }

  appendOriginal(text: string, _finished = false) {
    if (!text) return;
    // Original never cuts: it keeps appending and scrolls on the current line.
    if (this.curO && !/\s$/.test(this.curO) && !/^\s/.test(text)) this.curO += " ";
    this.curO += text;
    this.onChange();
  }

  appendTranslation(text: string) {
    if (!text) return;
    this.trackTranslationPacket();
    this.debug(
      `chunk=${this.formatDebugText(text)} cur=${this.formatDebugText(this.curT)} ` +
        `pendingCut=${Boolean(this.pendingSentenceCutTimer)} ` +
        `pendingTail=${this.formatDebugText(this.pendingShortTail?.tail || "")}`,
    );
    this.processTranslationText(text);
  }

  onCurrentLineReadable(text: string) {
    if (!this.pendingCutAwaitingReadable || this.cutHoldActive) return;
    if (this.pendingCutText && text && text !== this.pendingCutText) {
      this.debug(
        `ignore readable mismatch got=${this.formatDebugText(text)} want=${this.formatDebugText(this.pendingCutText)}`,
      );
      return;
    }
    this.beginCutHoldFromReadable(this.pendingCutText || text || this.curT);
  }

  snapshot() {
    return {
      curO: this.curO,
      curT: this.curT,
      hist: this.hist.map((item) => ({ ...item })),
      awaitingReadable: this.pendingCutAwaitingReadable,
      cutHoldActive: this.cutHoldActive,
      pendingCutText: this.pendingCutText,
      hasPendingCutTimer: this.pendingSentenceCutTimer !== null,
      hasPendingAction: this.pendingSentenceCutAction !== null,
      pendingShortTail: this.pendingShortTail?.tail || "",
    };
  }

  private processTranslationText(text: string) {
    if (!text) return;
    if (this.readyToCommit) {
      this.readyToCommit = false;
      this.commitCurrentSentenceNow();
    }
    if (this.pendingShortTail) {
      const pending = this.pendingShortTail;
      if (pending.timer) this.clearTimeoutFn(pending.timer);
      this.pendingShortTail = null;
      this.debug(
        `merge short tail tail=${this.formatDebugText(pending.tail)} next=${this.formatDebugText(text)}`,
      );
      this.requestSentenceCut(() => this.processTranslationText(`${pending.tail}${text}`));
      return;
    }
    if (this.pendingSentenceCutTimer) {
      this.debug(`queue after pending cut text=${this.formatDebugText(text)}`);
      this.enqueueAfterPendingCut(() => this.processTranslationText(text));
      return;
    }
    if (!this.sentenceBreaksEnabled()) {
      this.curT += text;
      this.onChange();
      return;
    }
    const breakIndex = this.findSentenceBreakIndex(text);
    if (breakIndex < 0) {
      this.curT += text;
      this.debug(`append no break cur=${this.formatDebugText(this.curT)}`);
      this.onChange();
      return;
    }
    const breakEnd = this.extendSentenceBreakEnd(text, breakIndex);
    const head = text.slice(0, breakEnd + 1);
    const tail = text.slice(breakEnd + 1);
    this.curT += head;
    this.debug(
      `break head=${this.formatDebugText(head)} tail=${this.formatDebugText(tail)} ` +
        `cur=${this.formatDebugText(this.curT)} tailChars=${this.sentenceCharLength(tail)}`,
    );
    this.onChange();

    const sentenceLength = this.sentenceCharLength(this.curT);
    if (sentenceLength <= this.minSentenceCutChars) {
      // A short sentence (<=4 content chars) must not move to history, even when
      // it is followed by a longer tail inside the same chunk. Merge the tail in.
      if (tail) {
        this.debug(`hold short head, merge tail=${this.formatDebugText(tail)}`);
        this.processTranslationText(tail);
      } else {
        this.debug(`hold short punctuated cur=${this.formatDebugText(this.curT)}`);
      }
      return;
    }
    if (!tail) {
      this.debug("request cut: punctuation at chunk end");
      this.requestSentenceCut();
      return;
    }
    if (this.sentenceCharLength(tail) > this.minPacketTailChars) {
      this.debug(`request cut: tail >= ${this.minPacketTailChars}`);
      this.requestSentenceCut(() => this.processTranslationText(tail));
      return;
    }
    this.debug(`queue short tail=${this.formatDebugText(tail)}`);
    this.queueShortTail(tail);
  }

  private findSentenceBreakIndex(text: string) {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (this.hasTerminalPunctuation(char)) {
        this.debug(`terminal hit char=${this.formatDebugText(char)} index=${index}`);
        return index;
      }
      if (this.hasCommaPunctuation(char)) {
        const length = this.sentenceCharLength(`${this.curT}${text.slice(0, index + 1)}`);
        this.debug(
          `comma hit index=${index} length=${length} threshold=${this.minCommaBreakChars}`,
        );
        if (length >= this.minCommaBreakChars) return index;
      }
    }
    return -1;
  }

  private extendSentenceBreakEnd(text: string, breakIndex: number) {
    let end = breakIndex;
    while (end + 1 < text.length && this.hasBoundaryPunctuation(text[end + 1])) end += 1;
    return end;
  }

  private queueShortTail(tail: string) {
    this.clearPendingShortTail();
    const delay = this.shortTailTimeoutMs();
    this.debug(`short tail wait ${Math.round(delay)}ms tail=${this.formatDebugText(tail)}`);
    const timer = this.setTimeoutFn(() => {
      this.pendingShortTail = null;
      this.debug(`short tail timeout tail=${this.formatDebugText(tail)}`);
      const headSentenceLength = this.sentenceCharLength(this.curT);
      if (headSentenceLength > this.minSentenceCutChars) {
        // The head is a complete, long-enough sentence. Commit it to history now
        // and restart the timed-out tail as the next current sentence, instead of
        // letting the whole sentence stall on the current line indefinitely.
        this.debug(
          `timeout head long (${headSentenceLength}), cut and keep tail as next sentence`,
        );
        this.requestSentenceCut(() => this.processTranslationText(tail));
        // The head has been visible for the entire short-tail wait, so treat it
        // as readable to avoid stalling on a stale overlay scroll signal.
        this.onCurrentLineReadable(this.curT);
        return;
      }
      // Keep an isolated short tail on the current line. It must not trigger a
      // history commit when no subsequent content has arrived yet.
      this.curT += tail;
      this.onChange();
    }, delay);
    this.pendingShortTail = { tail, timer };
  }

  private requestSentenceCut(afterCut?: () => void) {
    if (!this.sentenceBreaksEnabled()) {
      afterCut?.();
      return;
    }
    this.pendingSentenceCutAction = afterCut || this.pendingSentenceCutAction;
    if (this.cutHoldActive) {
      this.debug(
        `cut hold already active, update action hasAction=${Boolean(afterCut)} cur=${this.formatDebugText(this.curT)}`,
      );
      return;
    }
    this.pendingCutAwaitingReadable = true;
    this.cutHoldActive = false;
    this.pendingCutText = this.curT;
    this.debug(
      `await readable before cut hold hasAction=${Boolean(afterCut)} cur=${this.formatDebugText(this.curT)}`,
    );
    if (this.pendingSentenceCutTimer) this.clearTimeoutFn(this.pendingSentenceCutTimer);
    const fallbackDelay = Math.max(this.minSentenceCutDelayMs * 4, 2_000);
    this.pendingSentenceCutTimer = this.setTimeoutFn(() => {
      if (!this.pendingCutAwaitingReadable) return;
      this.debug(`readable signal timeout, force cut hold cur=${this.formatDebugText(this.curT)}`);
      this.beginCutHoldFromReadable(this.pendingCutText || this.curT);
    }, fallbackDelay);
  }

  private beginCutHoldFromReadable(text: string) {
    if (this.cutHoldActive) return;
    this.pendingCutAwaitingReadable = false;
    this.cutHoldActive = true;
    this.pendingCutText = text;
    const delay = this.minSentenceCutDelayMs;
    this.debug(
      `schedule cut after readable delay=${delay}ms hasAction=${Boolean(this.pendingSentenceCutAction)} ` +
        `cur=${this.formatDebugText(text)}`,
    );
    if (this.pendingSentenceCutTimer) this.clearTimeoutFn(this.pendingSentenceCutTimer);
    this.pendingSentenceCutTimer = this.setTimeoutFn(() => {
      this.pendingSentenceCutTimer = null;
      const action = this.pendingSentenceCutAction;
      this.pendingSentenceCutAction = null;
      this.pendingCutAwaitingReadable = false;
      this.cutHoldActive = false;
      this.pendingCutText = "";
      this.debug(`execute cut cur=${this.formatDebugText(this.curT)} hasQueued=${Boolean(action)}`);
      if (action) {
        this.commitCurrentSentenceNow();
        // Apply the queued tail before publishing the committed state. This
        // prevents the overlay from receiving an empty current row between
        // the history commit and the next sentence's first render.
        action();
      } else {
        this.readyToCommit = true;
      }
      this.onChange();
    }, delay);
  }

  private enqueueAfterPendingCut(action: () => void) {
    const previousAction = this.pendingSentenceCutAction;
    this.debug(`append queued action previous=${Boolean(previousAction)}`);
    this.pendingSentenceCutAction = () => {
      previousAction?.();
      action();
    };
  }

  private trackTranslationPacket() {
    const now = this.now();
    this.translationPacketTimes.push(now);
    this.translationPacketTimes = this.translationPacketTimes.filter(
      (time) => now - time <= this.speechIntervalWindowMs,
    );
  }

  private shortTailTimeoutMs() {
    if (this.translationPacketTimes.length < 2) {
      this.debug(
        `packet interval fallback=${this.defaultShortTailTimeoutMs}ms samples=${this.translationPacketTimes.length}`,
      );
      return this.defaultShortTailTimeoutMs;
    }
    let total = 0;
    for (let index = 1; index < this.translationPacketTimes.length; index++) {
      total += this.translationPacketTimes[index] - this.translationPacketTimes[index - 1];
    }
    const average = total / (this.translationPacketTimes.length - 1);
    return Math.max(this.minSentenceCutDelayMs, average * 1.5);
  }

  private hasTerminalPunctuation(text: string) {
    return /[。！？!?；;：:\n—]/.test(text);
  }

  private hasCommaPunctuation(text: string) {
    return /[，,、]/.test(text);
  }

  private hasBoundaryPunctuation(text: string) {
    return this.hasTerminalPunctuation(text) || this.hasCommaPunctuation(text);
  }

  private sentenceCharLength(text: string) {
    return Array.from(text).filter((char) => !/[\s。！？!?；;，,、：:\n—]/.test(char)).length;
  }

  private commitCurrentSentenceNow() {
    if (!this.curT) {
      this.debug("skip commit: empty current translation");
      return;
    }
    const id = this.nextHistoryId++;
    this.debug(
      `commit history id=${id} o=${this.formatDebugText(this.curO)} t=${this.formatDebugText(this.curT)}`,
    );
    this.hist.push({ id, o: this.curO, t: this.curT });
    this.curT = "";
    // curO is kept: the original line never cuts and keeps scrolling.
    if (this.hist.length > this.maxHistory) this.hist.shift();
  }

  clearPendingSentenceCut() {
    if (this.pendingSentenceCutTimer) this.clearTimeoutFn(this.pendingSentenceCutTimer);
    this.pendingSentenceCutTimer = null;
    this.pendingSentenceCutAction = null;
    this.pendingCutAwaitingReadable = false;
    this.pendingCutText = "";
    this.cutHoldActive = false;
    this.readyToCommit = false;
  }

  clearPendingShortTail() {
    if (this.pendingShortTail?.timer) this.clearTimeoutFn(this.pendingShortTail.timer);
    this.pendingShortTail = null;
  }

  private debug(message: string) {
    this.onDebug(message);
  }

  private formatDebugText(text: string) {
    if (!text) return "<empty>";
    return JSON.stringify(text.length > 36 ? `${text.slice(0, 36)}...` : text);
  }
}
