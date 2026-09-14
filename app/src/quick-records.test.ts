import { describe, expect, it } from "vitest";
import {
  addRecord,
  bindPendingRecords,
  createArchive,
  createQuickRecord,
  createSession,
  deleteRecord,
  isSessionEmpty,
  mergeSessions,
  parseArchive,
  recordsForSentence,
  replaceSessionSentences,
  serializeArchive,
  toggleSentenceMark,
  updateNote,
} from "./quick-records";

describe("quick records", () => {
  const now = new Date("2026-08-07T10:00:00.000Z");

  it("toggles sentence marks as a boolean set", () => {
    const session = createSession(now);
    session.sentences = [{ id: 2, o: "two", t: "二" }];
    const marked = toggleSentenceMark(session, 2);
    const unmarked = toggleSentenceMark(marked, 2);

    expect(marked.markedSentenceIds).toEqual([2]);
    expect(unmarked.markedSentenceIds).toEqual([]);
    expect(toggleSentenceMark(marked, 2).markedSentenceIds).toEqual([]);
  });

  it("allows multiple notes on one sentence and updates only the selected note", () => {
    const session = createSession(now);
    const withNotes = addRecord(
      addRecord(session, createQuickRecord("note", { sentenceId: 1, text: "first", now })),
      createQuickRecord("note", { sentenceId: 1, text: "second", now }),
    );
    const updated = updateNote(withNotes, withNotes.records[0].id, "edited");

    expect(recordsForSentence(updated, 1).map((record) => record.text)).toEqual(["edited", "second"]);
  });

  it("binds pending notes to the next completed sentence", () => {
    const session = createSession(now);
    const pendingNote = addRecord(session, createQuickRecord("note", { text: "remember", now }));
    const bound = bindPendingRecords(pendingNote, 4);

    expect(bound.records).toHaveLength(1);
    expect(bound.records[0]).toMatchObject({ status: "anchored", sentenceId: 4 });
  });

  it("moves notes to pending and drops marks when their sentence disappears", () => {
    const session = createSession(now);
    const marked = addRecord(session, createQuickRecord("note", { sentenceId: 2, text: "note", now }));
    marked.markedSentenceIds = [2];
    const reconciled = replaceSessionSentences(marked, [{ id: 1, o: "one", t: "一" }]);

    expect(reconciled.records[0]).toMatchObject({ status: "pending", sentenceId: null });
    expect(reconciled.markedSentenceIds).toEqual([]);
  });

  it("migrates records and marks when alignment re-ids unchanged sentences", () => {
    const session = createSession(now);
    session.sentences = [
      { id: 1, o: "First sentence.", t: "第一句。" },
      { id: 2, o: "Second sentence.", t: "第二句。" },
    ];
    const withRecord = addRecord(session, createQuickRecord("note", { sentenceId: 2, text: "note", now }));
    withRecord.markedSentenceIds = [2];
    const reconciled = replaceSessionSentences(withRecord, [
      { id: 5, o: "First sentence.", t: "第一句。" },
      { id: 6, o: "Second sentence.", t: "第二句。" },
    ]);

    expect(reconciled.records[0]).toMatchObject({ status: "anchored", sentenceId: 6 });
    expect(reconciled.markedSentenceIds).toEqual([6]);
  });

  it("keeps records anchored to the original text after alignment repairs pairings", () => {
    const session = createSession(now);
    session.sentences = [
      { id: 1, o: "Hello.", t: "你好。" },
      { id: 2, o: "World.", t: "世界。" },
    ];
    const withRecord = addRecord(session, createQuickRecord("note", { sentenceId: 1, text: "note", now }));
    const reconciled = replaceSessionSentences(withRecord, [
      { id: 3, o: "Hello.", t: "世界。" },
      { id: 4, o: "World.", t: "你好。" },
    ]);

    expect(reconciled.records[0]).toMatchObject({ status: "anchored", sentenceId: 3 });
  });

  it("round-trips malformed archive data into a safe archive", () => {
    const archive = parseArchive(JSON.stringify({ sessions: [{ id: "s", records: [{ kind: "note", text: " x " }] }] }));

    expect(archive.version).toBe(1);
    expect(archive.sessions[0].records[0]).toMatchObject({ kind: "note", status: "pending", sentenceId: null, text: "x" });
    expect(parseArchive("not-json").sessions).toEqual([]);
  });

  it("round-trips edited and AI-aligned sentence metadata", () => {
    const session = createSession(now);
    session.sentences = [
      { id: 1, o: "one", t: "一", edited: true },
      { id: 2, o: "two", t: "二", aligned: true },
    ];

    const restored = parseArchive(serializeArchive(createArchive([session]))).sessions[0];

    expect(restored.sentences).toEqual(session.sentences);
  });

  it("migrates legacy marker records into markedSentenceIds", () => {
    const archive = parseArchive(JSON.stringify({
      sessions: [{
        id: "s",
        sentences: [{ id: 3, o: "three", t: "三" }],
        records: [
          { kind: "marker", sentenceId: 3, id: "m1" },
          { kind: "marker", sentenceId: 99, id: "m2" },
          { kind: "note", sentenceId: 3, id: "n1", text: "keep" },
        ],
      }],
    }));

    expect(archive.sessions[0].markedSentenceIds).toEqual([3]);
    expect(archive.sessions[0].records.map((record) => record.kind)).toEqual(["note"]);
    expect(archive.sessions[0].records[0].text).toBe("keep");
  });

  it("merges sessions chronologically and remaps sentence anchors and marks", () => {
    const first = createSession(new Date("2026-08-07T10:00:00.000Z"));
    first.sentences = [{ id: 1, o: "first", t: "第一句" }];
    first.markedSentenceIds = [1];
    const second = createSession(new Date("2026-08-07T11:00:00.000Z"));
    second.sentences = [{ id: 1, o: "second", t: "第二句" }];
    second.records = [createQuickRecord("note", { sentenceId: 1, text: "note", now })];

    const merged = mergeSessions([second, first], now);

    expect(merged.sentences.map((sentence) => sentence.t)).toEqual(["第一句", "第二句"]);
    expect(merged.records.map((record) => record.sentenceId)).toEqual([2]);
    expect(merged.markedSentenceIds).toEqual([1]);
    expect(merged.endedAt).toBe(second.startedAt);
  });

  it("removes records without changing the rest of the session", () => {
    const session = createSession(now);
    const noted = addRecord(session, createQuickRecord("note", { sentenceId: 1, text: "note", now }));

    expect(deleteRecord(noted, noted.records[0].id).records).toHaveLength(0);
    expect(serializeArchive(createArchive([noted]))).toContain('"sessions"');
  });

  it("recognizes a session without subtitle content as empty", () => {
    const empty = createSession(now);
    expect(isSessionEmpty(empty)).toBe(true);

    empty.sentences = [{ id: 1, o: "  ", t: "" }];
    expect(isSessionEmpty(empty)).toBe(true);

    empty.sentences = [{ id: 1, o: "hello", t: "你好" }];
    expect(isSessionEmpty(empty)).toBe(false);
  });
});
