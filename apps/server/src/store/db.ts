import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Attachment, EventType, PendingRequest, PendingRequestBody, PermissionMode, ProviderEvent, Resolution, Session, SessionStatus, Settings, Workspace } from '@agentdeck/shared';

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
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL UNIQUE,
      alias      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 旧库没有就补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）：model / effort 是切片 8 加的，permission_mode 是权限模式那次加的，archived_at 是切片 12 加的
  const sessionCols = new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name));
  for (const col of ['model', 'effort', 'permission_mode', 'archived_at', 'title']) if (!sessionCols.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, provider, cwd, provider_session_id, status, model, effort, permission_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // AI 标题独立保存；旧会话和生成失败时仍展示原来的首条消息。
  const sessionColumns = `sessions.*, (
    SELECT json_extract(payload, '$.text') FROM events
    WHERE events.session_id = sessions.id AND type = 'message.user' ORDER BY seq LIMIT 1
  ) AS fallback_title`;
  const selectSession = db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`);
  const selectSessions = db.prepare(`SELECT ${sessionColumns} FROM sessions ORDER BY updated_at DESC`);
  const updateStatus = db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`);
  // 归档不动 updated_at：它不是会话活动，取消归档后仍按原来的活动时间排
  const updateArchivedAt = db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`);
  // 换 Provider 不动 updated_at：跟归档一样不算会话活动
  const updateProvider = db.prepare(`UPDATE sessions SET provider = ?, model = ?, effort = ? WHERE id = ?`);
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
  // 删除会话连同它的全部记录；四张表在一个事务里，不留半截
  const deleteSessionRows = [
    db.prepare(`DELETE FROM events WHERE session_id = ?`),
    db.prepare(`DELETE FROM pending_requests WHERE session_id = ?`),
    db.prepare(`DELETE FROM attachments WHERE session_id = ?`),
    db.prepare(`DELETE FROM sessions WHERE id = ?`),
  ];
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
  const insertWorkspace = db.prepare(`INSERT INTO workspaces (id, path, alias, created_at) VALUES (?, ?, ?, ?)`);
  const selectWorkspaces = db.prepare(`SELECT * FROM workspaces ORDER BY created_at`);
  const selectWorkspace = db.prepare(`SELECT * FROM workspaces WHERE id = ?`);
  const selectWorkspaceByPath = db.prepare(`SELECT * FROM workspaces WHERE path = ?`);
  const updateWorkspaceAlias = db.prepare(`UPDATE workspaces SET alias = ? WHERE id = ?`);
  const deleteWorkspace = db.prepare(`DELETE FROM workspaces WHERE id = ?`);
  const selectSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const upsertSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

  const rowToSession = (r: Record<string, unknown>): Session => ({
    id: r.id as string,
    provider: r.provider as Session['provider'],
    cwd: r.cwd as string,
    providerSessionId: (r.provider_session_id as string | null) ?? null,
    status: r.status as SessionStatus,
    title: (r.title as string | null) || (r.fallback_title as string | null)?.trim().split('\n')[0].slice(0, 80) || null,
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    // 旧行没有这一列：一直以来的实际行为就是审批，落库时按这个兜底
    permissionMode: (r.permission_mode as PermissionMode | null) ?? 'approval',
    archivedAt: (r.archived_at as string | null) ?? null,
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
  const rowToWorkspace = (r: Record<string, unknown>): Workspace => ({ id: r.id as string, path: r.path as string, alias: r.alias as string, createdAt: r.created_at as string });
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
        session.status, session.model, session.effort, session.permissionMode, session.createdAt, session.updatedAt,
      );
    },
    getSession(id: string): Session | undefined {
      const row = selectSession.get(id);
      return row && rowToSession(row);
    },
    listSessions(): Session[] {
      return selectSessions.all().map(rowToSession);
    },
    deleteSession(id: string) {
      db.exec('BEGIN');
      try {
        for (const stmt of deleteSessionRows) stmt.run(id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    hasUserText(id: string): boolean {
      return db.prepare(`SELECT json_extract(payload, '$.text') AS text FROM events WHERE session_id = ? AND type = 'message.user'`).all(id).some((row) => (row.text as string).trim().length > 0);
    },
    setSessionTitle(id: string, title: string) {
      // 元数据更新不改变最近活动时间；删除后的迟到结果不会重建会话。
      db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL').run(title, id);
    },
    setSessionStatus(id: string, status: SessionStatus) {
      updateStatus.run(status, new Date().toISOString(), id);
    },
    setSessionArchivedAt(id: string, archivedAt: string | null) {
      updateArchivedAt.run(archivedAt, id);
    },
    setSessionProvider(id: string, provider: Session['provider'], model: string | null, effort: string | null) {
      updateProvider.run(provider, model, effort, id);
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
    createWorkspace(w: Workspace) {
      insertWorkspace.run(w.id, w.path, w.alias, w.createdAt);
    },
    listWorkspaces(): Workspace[] {
      return selectWorkspaces.all().map(rowToWorkspace);
    },
    getWorkspace(id: string): Workspace | undefined {
      const row = selectWorkspace.get(id);
      return row && rowToWorkspace(row);
    },
    getWorkspaceByPath(path: string): Workspace | undefined {
      const row = selectWorkspaceByPath.get(path);
      return row && rowToWorkspace(row);
    },
    setWorkspaceAlias(id: string, alias: string): boolean {
      return updateWorkspaceAlias.run(alias, id).changes === 1;
    },
    deleteWorkspace(id: string): boolean {
      return deleteWorkspace.run(id).changes === 1;
    },
    /** 应用级默认值整份存一行 JSON；没存过时返回 null */
    getSettings(): Settings | null {
      const row = selectSetting.get('defaults');
      return row ? (JSON.parse(row.value as string) as Settings) : null;
    },
    getDeepseekApiKey(): string {
      return (selectSetting.get('deepseek_api_key')?.value as string | undefined) ?? '';
    },
    setDeepseekApiKey(apiKey: string) {
      upsertSetting.run('deepseek_api_key', apiKey);
    },
    setSettings(settings: Settings) {
      upsertSetting.run('defaults', JSON.stringify(settings));
    },
    close() {
      db.close();
    },
  };
}
