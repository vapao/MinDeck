import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Attachment, EventType, PendingRequest, PendingRequestBody, PermissionMode, ProviderEvent, Resolution, ServiceConfig, Session, SessionStatus, Settings, Workspace } from '@agentdeck/shared';

export type Store = ReturnType<typeof openStore>;
/** pid 是服务进程组的组长；startedAt 是它在 ps 里的启动时间，用来识别 pid 是否已被别的进程复用 */
export type ServiceRow = ServiceConfig & { id: string; workspaceId: string; pid: number | null; startedAt: string | null; createdAt: string };

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
    CREATE TABLE IF NOT EXISTS workspace_services (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name         TEXT NOT NULL,
      command      TEXT NOT NULL,
      subdir       TEXT NOT NULL,
      url          TEXT NOT NULL,
      pid          INTEGER,
      started_at   TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 旧库没有就补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）：model / effort 是切片 8 加的，permission_mode 是权限模式那次加的，archived_at 是切片 12 加的，parent_id 是派生会话隶属关系那次加的，spawn_granted_at 是派生授权持久化那次加的
  const sessionCols = new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name));
  for (const col of ['model', 'effort', 'permission_mode', 'archived_at', 'title', 'parent_id', 'spawn_granted_at']) if (!sessionCols.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);

  // 修正旧版下拉框保存的 Codex effort 拼写，不改变模型、会话排序或其他 Provider。
  for (const [oldEffort, effort] of [['light', 'low'], ['extra-high', 'xhigh']]) {
    db.prepare(`UPDATE sessions SET effort = ? WHERE provider = 'codex' AND effort = ?`).run(effort!, oldEffort!);
    db.prepare(`UPDATE settings SET value = json_set(value, '$.codex.effort', ?)
      WHERE key = 'defaults' AND json_extract(value, '$.codex.effort') = ?`).run(effort!, oldEffort!);
  }

  // Claude 设置从 SDK 别名改为具体 ID（换算到当前下拉框里的对应 ID），否则设置页选不中、保存会被校验拒绝。
  // 已有会话的 model 不动：resume 时别名仍被 SDK 接受。
  for (const [alias, model] of [['fable', 'claude-fable-5-1'], ['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-4-5']]) {
    db.prepare(`UPDATE settings SET value = json_set(value, '$.claude.model', ?)
      WHERE key = 'defaults' AND json_extract(value, '$.claude.model') = ?`).run(model!, alias!);
    db.prepare(`UPDATE settings SET value = json_set(value, '$.titles.model', ?)
      WHERE key = 'defaults' AND json_extract(value, '$.titles.provider') = 'claude' AND json_extract(value, '$.titles.model') = ?`).run(model!, alias!);
  }

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, provider, cwd, provider_session_id, status, model, effort, permission_mode, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const insertService = db.prepare(`INSERT INTO workspace_services (id, workspace_id, name, command, subdir, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const selectServices = db.prepare(`SELECT * FROM workspace_services ORDER BY created_at`);
  const selectService = db.prepare(`SELECT * FROM workspace_services WHERE id = ?`);
  const updateService = db.prepare(`UPDATE workspace_services SET name = ?, command = ?, subdir = ?, url = ? WHERE id = ?`);
  const updateServiceProcess = db.prepare(`UPDATE workspace_services SET pid = ?, started_at = ? WHERE id = ?`);
  const deleteService = db.prepare(`DELETE FROM workspace_services WHERE id = ?`);
  const deleteWorkspaceServices = db.prepare(`DELETE FROM workspace_services WHERE workspace_id = ?`);
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
    parentId: (r.parent_id as string | null) ?? null,
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
  const rowToService = (r: Record<string, unknown>): ServiceRow => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    command: r.command as string,
    subdir: r.subdir as string,
    url: r.url as string,
    pid: (r.pid as number | null) ?? null,
    startedAt: (r.started_at as string | null) ?? null,
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
        session.status, session.model, session.effort, session.permissionMode, session.parentId, session.createdAt, session.updatedAt,
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
    /** 分叉：新会话、复制过来的事件（seq 从 1 重排，保留原时间）和附件行在一个事务里写入 */
    copySession(session: Session, events: (ProviderEvent & { createdAt: string })[], attachments: Attachment[]) {
      db.exec('BEGIN');
      try {
        insertSession.run(
          session.id, session.provider, session.cwd, session.providerSessionId,
          session.status, session.model, session.effort, session.permissionMode, session.parentId, session.createdAt, session.updatedAt,
        );
        if (session.title) db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(session.title, session.id);
        for (const a of attachments) insertAttachment.run(a.id, a.sessionId, a.name, a.mimeType, a.size, a.createdAt);
        for (const e of events) insertEvent.get(session.id, session.id, e.type, JSON.stringify(e.payload), e.createdAt);
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
    /** 派生授权落库：用户离开时 Hub 可能被 update-when-idle 重启，只放内存会让夜里的下一次 create_session 卡在审批上 */
    grantSpawn(id: string) {
      db.prepare('UPDATE sessions SET spawn_granted_at = ? WHERE id = ? AND spawn_granted_at IS NULL').run(new Date().toISOString(), id);
    },
    canSpawn(id: string): boolean {
      return !!db.prepare('SELECT 1 FROM sessions WHERE id = ? AND spawn_granted_at IS NOT NULL').get(id);
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
    /** 服务配置跟着项目走，一起删；是否还有服务在跑由调用方先检查 */
    deleteWorkspace(id: string): boolean {
      deleteWorkspaceServices.run(id);
      return deleteWorkspace.run(id).changes === 1;
    },
    createService(s: ServiceRow) {
      insertService.run(s.id, s.workspaceId, s.name, s.command, s.subdir, s.url, s.createdAt);
    },
    listServices(): ServiceRow[] {
      return selectServices.all().map(rowToService);
    },
    getService(id: string): ServiceRow | undefined {
      const row = selectService.get(id);
      return row && rowToService(row);
    },
    updateService(id: string, c: ServiceConfig): boolean {
      return updateService.run(c.name, c.command, c.subdir, c.url, id).changes === 1;
    },
    setServiceProcess(id: string, pid: number | null, startedAt: string | null) {
      updateServiceProcess.run(pid, startedAt, id);
    },
    deleteService(id: string): boolean {
      return deleteService.run(id).changes === 1;
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
