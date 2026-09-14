export const SESSION_ARCHIVE_VERSION = 1;

export type SessionSentence = {
  id: number;
  o: string;
  t: string;
  /** True when the user manually edited this sentence; display layers must keep it as one line. */
  edited?: boolean;
  /** True when an AI alignment pass fixed this row pairing; display it as one line. */
  aligned?: boolean;
};

export type QuickRecordKind = "note";
export type QuickRecordStatus = "anchored" | "pending";

export type QuickRecord = {
  id: string;
  kind: QuickRecordKind;
  status: QuickRecordStatus;
  sentenceId: number | null;
  createdAt: string;
  text?: string;
};

export type Session = {
  id: string;
  startedAt: string;
  endedAt?: string;
  sentences: SessionSentence[];
  records: QuickRecord[];
  markedSentenceIds: number[];
};

export type SessionArchive = {
  version: typeof SESSION_ARCHIVE_VERSION;
  sessions: Session[];
};

let idSequence = 0;

export function createSession(now = new Date()): Session {
  const timestamp = now.toISOString();
  return {
    id: createId("session", now),
    startedAt: timestamp,
    sentences: [],
    records: [],
    markedSentenceIds: [],
  } satisfies Session;
}

export function createQuickRecord(
  kind: QuickRecordKind,
  options: { sentenceId?: number | null; text?: string; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const sentenceId = options.sentenceId ?? null;
  const text = options.text?.trim();
  return {
    id: createId(kind, now),
    kind,
    status: sentenceId === null ? "pending" : "anchored",
    sentenceId,
    createdAt: now.toISOString(),
    ...(kind === "note" && text ? { text } : {}),
  } satisfies QuickRecord;
}

export function addRecord(session: Session, record: QuickRecord): Session {
  return { ...session, records: [...session.records, normalizeRecord(record)] };
}

export function toggleSentenceMark(session: Session, sentenceId: number): Session {
  if (!session.sentences.some((sentence) => sentence.id === sentenceId)) return session;
  const marked = session.markedSentenceIds.includes(sentenceId);
  return {
    ...session,
    markedSentenceIds: marked
      ? session.markedSentenceIds.filter((id) => id !== sentenceId)
      : [...session.markedSentenceIds, sentenceId],
  };
}

export function updateNote(session: Session, recordId: string, text: string): Session {
  const normalizedText = text.trim();
  if (!normalizedText) return session;
  return {
    ...session,
    records: session.records.map((record) =>
      record.id === recordId && record.kind === "note"
        ? { ...record, text: normalizedText }
        : record,
    ),
  };
}

export function deleteRecord(session: Session, recordId: string): Session {
  return { ...session, records: session.records.filter((record) => record.id !== recordId) };
}

export function bindPendingRecords(session: Session, sentenceId: number): Session {
  return {
    ...session,
    records: session.records.map((record) =>
      record.status === "pending"
        ? { ...record, status: "anchored", sentenceId }
        : record,
    ),
  };
}

export function replaceSessionSentences(
  session: Session,
  sentences: SessionSentence[],
  extra: SessionSentence[] = [],
): Session {
  const histIds = new Set(sentences.map((sentence) => sentence.id));
  const nextSentences = [
    ...sentences.map((sentence) => ({
      id: sentence.id,
      o: sentence.o || "",
      t: sentence.t || "",
      ...(sentence.edited ? { edited: true } : {}),
      ...(sentence.aligned ? { aligned: true } : {}),
    })),
    ...extra.filter((sentence) => !histIds.has(sentence.id)),
  ];
  const validIds = new Set(nextSentences.map((sentence) => sentence.id));
  const migratedIds = sentenceIdMigration(session.sentences, nextSentences);
  return {
    ...session,
    sentences: nextSentences,
    records: session.records.map((record) => {
      if (record.status !== "anchored") return record;
      const migrated = record.sentenceId === null ? undefined : migratedIds.get(record.sentenceId);
      if (migrated !== undefined) return { ...record, sentenceId: migrated };
      return record.sentenceId === null || validIds.has(record.sentenceId)
        ? record
        : { ...record, status: "pending", sentenceId: null };
    }),
    markedSentenceIds: Array.from(new Set(session.markedSentenceIds.flatMap((id) => {
      const migrated = migratedIds.get(id);
      return migrated !== undefined ? [migrated] : validIds.has(id) ? [id] : [];
    }))),
  };
}

// 句子 id 重排后（如 AI 对齐重建），按非空一侧文本把旧 id 迁到内容相同的新 id。
function sentenceIdMigration(oldSentences: SessionSentence[], nextSentences: SessionSentence[]) {
  const buckets = new Map<string, number[]>();
  for (const sentence of oldSentences) {
    const key = sentenceKey(sentence);
    if (!key) continue;
    const ids = buckets.get(key) || [];
    ids.push(sentence.id);
    buckets.set(key, ids);
  }
  const migration = new Map<number, number>();
  for (const sentence of nextSentences) {
    const key = sentenceKey(sentence);
    if (!key) continue;
    const ids = buckets.get(key);
    const oldId = ids?.shift();
    if (oldId !== undefined) migration.set(oldId, sentence.id);
  }
  return migration;
}

function sentenceKey(sentence: SessionSentence) {
  return sentence.o.trim() || sentence.t.trim();
}

export function recordsForSentence(session: Session, sentenceId: number) {
  return session.records.filter((record) => record.status === "anchored" && record.sentenceId === sentenceId);
}

export function isSessionEmpty(session: Session) {
  return session.records.length === 0
    && session.markedSentenceIds.length === 0
    && session.sentences.every((sentence) => !sentence.o.trim() && !sentence.t.trim());
}

export function createArchive(sessions: Session[] = []): SessionArchive {
  return { version: SESSION_ARCHIVE_VERSION, sessions: sessions.map(normalizeSession) };
}

export function upsertSession(archive: SessionArchive, session: Session): SessionArchive {
  const normalized = normalizeSession(session);
  const index = archive.sessions.findIndex((item) => item.id === normalized.id);
  const sessions = [...archive.sessions];
  if (index < 0) sessions.push(normalized);
  else sessions[index] = normalized;
  return { version: SESSION_ARCHIVE_VERSION, sessions };
}

export function removeSessions(archive: SessionArchive, sessionIds: string[]) {
  const ids = new Set(sessionIds);
  return {
    version: SESSION_ARCHIVE_VERSION,
    sessions: archive.sessions.filter((session) => !ids.has(session.id)),
  } satisfies SessionArchive;
}

export function mergeSessions(sessions: Session[], now = new Date()) {
  const ordered = sessions.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const merged = createSession(now);
  merged.startedAt = ordered[0]?.startedAt || merged.startedAt;
  const lastSession = ordered[ordered.length - 1];
  merged.endedAt = lastSession?.endedAt || lastSession?.startedAt;

  let nextSentenceId = 1;
  const sentenceMaps = new Map<string, Map<number, number>>();
  for (const session of ordered) {
    const mapping = new Map<number, number>();
    for (const sentence of session.sentences) {
      const mappedId = nextSentenceId++;
      mapping.set(sentence.id, mappedId);
      merged.sentences.push({ ...sentence, id: mappedId });
    }
    sentenceMaps.set(session.id, mapping);
  }

  for (const session of ordered) {
    const mapping = sentenceMaps.get(session.id)!;
    for (const record of session.records) {
      const sentenceId = record.sentenceId === null ? null : mapping.get(record.sentenceId) ?? null;
      merged.records.push({
        ...record,
        id: createId(record.kind, now),
        sentenceId,
        status: sentenceId === null ? "pending" : "anchored",
      });
    }
  }

  merged.markedSentenceIds = Array.from(new Set(ordered.flatMap((session) => {
    const mapping = sentenceMaps.get(session.id)!;
    return session.markedSentenceIds.flatMap((id) => {
      const mapped = mapping.get(id);
      return mapped === undefined ? [] : [mapped];
    });
  })));

  return normalizeSession(merged);
}

export function parseArchive(raw: string | null | undefined) {
  if (!raw) return createArchive();
  try {
    return normalizeArchive(JSON.parse(raw) as unknown);
  } catch {
    return createArchive();
  }
}

export function serializeArchive(archive: SessionArchive) {
  return JSON.stringify(normalizeArchive(archive));
}

function normalizeArchive(value: unknown): SessionArchive {
  const source = value && typeof value === "object" ? value as { sessions?: unknown } : {};
  const sessions = Array.isArray(source.sessions) ? source.sessions.flatMap((session) => {
    if (!session || typeof session !== "object") return [];
    return [normalizeSession(session as Partial<Session>)];
  }) : [];
  return createArchive(sessions);
}

function normalizeSession(value: Partial<Session>): Session {
  const sentences = Array.isArray(value.sentences)
    ? value.sentences.flatMap((sentence) => {
        if (!sentence || typeof sentence !== "object") return [];
        const item = sentence as Partial<SessionSentence>;
        if (typeof item.id !== "number" || !Number.isFinite(item.id)) return [];
        return [{
          id: item.id,
          o: typeof item.o === "string" ? item.o : "",
          t: typeof item.t === "string" ? item.t : "",
          ...(item.edited ? { edited: true } : {}),
          ...(item.aligned ? { aligned: true } : {}),
        }];
      })
    : [];
  const rawRecords = Array.isArray(value.records) ? value.records : [];
  const legacyMarkedIds = rawRecords.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const item = record as { kind?: unknown; sentenceId?: unknown };
    return item.kind === "marker" && typeof item.sentenceId === "number" && Number.isFinite(item.sentenceId)
      ? [item.sentenceId]
      : [];
  });
  const records = rawRecords
    .filter((record) => {
      if (!record || typeof record !== "object") return false;
      return (record as { kind?: unknown }).kind !== "marker";
    })
    .flatMap((record) => {
      if (!record || typeof record !== "object") return [];
      return [normalizeRecord(record as Partial<QuickRecord>)];
    });
  const rawMarkedIds = Array.isArray(value.markedSentenceIds) ? value.markedSentenceIds : [];
  const markedSentenceIds = Array.from(new Set([
    ...legacyMarkedIds,
    ...rawMarkedIds,
  ].filter((id): id is number => typeof id === "number" && Number.isFinite(id))));
  const validSentenceIds = new Set(sentences.map((sentence) => sentence.id));
  return {
    id: typeof value.id === "string" && value.id ? value.id : createId("session"),
    startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
    ...(typeof value.endedAt === "string" ? { endedAt: value.endedAt } : {}),
    sentences,
    records,
    markedSentenceIds: markedSentenceIds.filter((id) => validSentenceIds.has(id)),
  };
}

function normalizeRecord(value: Partial<QuickRecord>): QuickRecord {
  const kind: QuickRecordKind = "note";
  const sentenceId = typeof value.sentenceId === "number" && Number.isFinite(value.sentenceId) ? value.sentenceId : null;
  const status: QuickRecordStatus = sentenceId === null ? "pending" : "anchored";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  return {
    id: typeof value.id === "string" && value.id ? value.id : createId(kind),
    kind,
    status,
    sentenceId,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    ...(kind === "note" && text ? { text } : {}),
  };
}

function createId(prefix: string, now = new Date()) {
  idSequence += 1;
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : `${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${now.getTime().toString(36)}-${idSequence.toString(36)}-${random}`;
}
