import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, EventType, ProviderEvent, Session, SessionStatus } from '@agentdeck/shared';

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id                  TEXT PRIMARY KEY,
      provider            TEXT NOT NULL,
      cwd                 TEXT NOT NULL,
      provider_session_id TEXT,
      status              TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT    NOT NULL REFERENCES sessions(id),
      seq        INTEGER NOT NULL,
      type       TEXT    NOT NULL,
      payload    TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
  `);

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, provider, cwd, provider_session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectSession = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const updateStatus = db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`);
  const updateProviderSessionId = db.prepare(
    `UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?`,
  );
  // seq 在同一条 INSERT 里由子查询分配：SQLite 单写者，保证每个 session 内严格单调递增
  const insertEvent = db.prepare(
    `INSERT INTO events (session_id, seq, type, payload, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?), ?, ?, ?)
     RETURNING seq`,
  );
  const selectEventsAfter = db.prepare(
    `SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`,
  );
  const selectLastSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?`);

  const rowToSession = (r: Record<string, unknown>): Session => ({
    id: r.id as string,
    provider: r.provider as Session['provider'],
    cwd: r.cwd as string,
    providerSessionId: (r.provider_session_id as string | null) ?? null,
    status: r.status as SessionStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });
  const rowToEvent = (r: Record<string, unknown>): AgentEvent =>
    ({
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload as string),
      createdAt: r.created_at,
    }) as AgentEvent;

  return {
    createSession(session: Session) {
      insertSession.run(
        session.id, session.provider, session.cwd, session.providerSessionId,
        session.status, session.createdAt, session.updatedAt,
      );
    },
    getSession(id: string): Session | undefined {
      const row = selectSession.get(id);
      return row && rowToSession(row);
    },
    setSessionStatus(id: string, status: SessionStatus) {
      updateStatus.run(status, new Date().toISOString(), id);
    },
    setProviderSessionId(id: string, providerSessionId: string) {
      updateProviderSessionId.run(providerSessionId, new Date().toISOString(), id);
    },
    appendEvent<T extends EventType>(sessionId: string, event: ProviderEvent<T>): AgentEvent<T> {
      const createdAt = new Date().toISOString();
      const row = insertEvent.get(sessionId, sessionId, event.type, JSON.stringify(event.payload), createdAt)!;
      return { sessionId, seq: row.seq as number, type: event.type, payload: event.payload, createdAt } as AgentEvent<T>;
    },
    eventsAfter(sessionId: string, afterSeq: number): AgentEvent[] {
      return selectEventsAfter.all(sessionId, afterSeq).map(rowToEvent);
    },
    lastSeq(sessionId: string): number {
      return selectLastSeq.get(sessionId)!.seq as number;
    },
    close() {
      db.close();
    },
  };
}
