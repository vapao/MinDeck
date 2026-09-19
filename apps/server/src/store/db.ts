import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Attachment, EventType, PendingRequest, PendingRequestBody, ProviderEvent, Resolution, Session, SessionStatus } from '@agentdeck/shared';

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
    CREATE TABLE IF NOT EXISTS pending_requests (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      status      TEXT NOT NULL,
      request     TEXT NOT NULL,
      resolution  TEXT,
      created_at  TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY,
      session_id TEXT    NOT NULL REFERENCES sessions(id),
      name       TEXT    NOT NULL,
      mime_type  TEXT    NOT NULL,
      size       INTEGER NOT NULL,
      created_at TEXT    NOT NULL
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
  const insertPending = db.prepare(
    `INSERT INTO pending_requests (id, session_id, status, request, created_at) VALUES (?, ?, 'pending', ?, ?)`,
  );
  const selectPending = db.prepare(`SELECT * FROM pending_requests WHERE id = ?`);
  const selectPendingBySession = db.prepare(
    `SELECT * FROM pending_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at`,
  );
  // 只有仍是 pending 的行才会被改：多端同时 resolve 时恰好一个成功（方案 §10.1）
  const settlePending = db.prepare(
    `UPDATE pending_requests SET status = ?, resolution = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
  );
  const expireAllPending = db.prepare(`UPDATE pending_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending'`);
  const insertAttachment = db.prepare(
    `INSERT INTO attachments (id, session_id, name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectAttachment = db.prepare(`SELECT * FROM attachments WHERE id = ?`);

  const rowToSession = (r: Record<string, unknown>): Session => ({
    id: r.id as string,
    provider: r.provider as Session['provider'],
    cwd: r.cwd as string,
    providerSessionId: (r.provider_session_id as string | null) ?? null,
    status: r.status as SessionStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });
  const rowToPending = (r: Record<string, unknown>): PendingRequest => ({
    ...(JSON.parse(r.request as string) as PendingRequestBody),
    id: r.id as string,
    sessionId: r.session_id as string,
    status: r.status as PendingRequest['status'],
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
  });
  const rowToAttachment = (r: Record<string, unknown>): Attachment => ({
    id: r.id as string,
    sessionId: r.session_id as string,
    name: r.name as string,
    mimeType: r.mime_type as Attachment['mimeType'],
    size: r.size as number,
    createdAt: r.created_at as string,
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
    createPending(request: PendingRequest) {
      const { id, sessionId, status: _s, createdAt, resolvedAt: _r, ...body } = request;
      insertPending.run(id, sessionId, JSON.stringify(body), createdAt);
    },
    getPending(id: string): PendingRequest | undefined {
      const row = selectPending.get(id);
      return row && rowToPending(row);
    },
    pendingBySession(sessionId: string): PendingRequest[] {
      return selectPendingBySession.all(sessionId).map(rowToPending);
    },
    /** 原子 resolve：返回 false 表示已被别处处理（或已过期） */
    resolvePending(id: string, resolution: Resolution | null, status: 'resolved' | 'expired' = 'resolved'): boolean {
      return settlePending.run(status, resolution && JSON.stringify(resolution), new Date().toISOString(), id).changes === 1;
    },
    /** Hub 重启后没有任何 Provider 回调在等这些请求，全部作废 */
    expireAllPending() {
      expireAllPending.run(new Date().toISOString());
    },
    createAttachment(a: Attachment) {
      insertAttachment.run(a.id, a.sessionId, a.name, a.mimeType, a.size, a.createdAt);
    },
    getAttachment(id: string): Attachment | undefined {
      const row = selectAttachment.get(id);
      return row && rowToAttachment(row);
    },
    close() {
      db.close();
    },
  };
}
