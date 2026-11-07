import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Attachment, EventType, PendingRequest, PendingRequestBody, PermissionMode, ProviderEvent, Report, Resolution, Schedule, ScheduleConfig, Secret, ServiceConfig, Session, SessionStatus, Settings, Todo, UnfinishedSession, Wakeup, Workspace } from '@agentdeck/shared';

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
    CREATE TABLE IF NOT EXISTS schedules (
      id              TEXT PRIMARY KEY,
      config          TEXT NOT NULL,
      next_run_at     TEXT,
      last_run_at     TEXT,
      last_session_id TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wakeups (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      at         TEXT NOT NULL,
      note       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      title      TEXT NOT NULL,
      summary    TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS todos (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      note       TEXT NOT NULL,
      cwd        TEXT,
      session_id TEXT,
      remind_on  TEXT,
      created_at TEXT NOT NULL,
      done_at    TEXT
    );
    -- workspace_id 为 '' 是 Shared（NULL 在 UNIQUE 里互不相等，挡不住重名）
    CREATE TABLE IF NOT EXISTS secrets (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      value        TEXT NOT NULL,
      description  TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      UNIQUE (workspace_id, name)
    );
  `);
  // 旧库没有就补上（SQLite 没有 ADD COLUMN IF NOT EXISTS）：model / effort 是切片 8 加的，permission_mode 是权限模式那次加的，archived_at 是切片 12 加的，parent_id 是派生会话隶属关系那次加的，spawn_granted_at 是派生授权持久化那次加的，schedule_id 是 Automations 运行记录那次加的，review_* 是没收尾判断那次加的（review_summary 是补会话概况那次），forked_* 是分叉来源那次加的
  const sessionCols = new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name));
  for (const col of ['model', 'effort', 'permission_mode', 'archived_at', 'title', 'parent_id', 'spawn_granted_at', 'schedule_id', 'review_for', 'review_state', 'review_next', 'review_summary', 'forked_from_id']) if (!sessionCols.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
  if (!sessionCols.has('forked_at_seq')) db.exec('ALTER TABLE sessions ADD COLUMN forked_at_seq INTEGER');

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
    `INSERT INTO sessions (id, provider, cwd, provider_session_id, status, model, effort, permission_mode, parent_id, schedule_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  // 删除会话连同它的全部记录；几张表在一个事务里，不留半截
  const deleteSessionRows = [
    db.prepare(`UPDATE todos SET session_id = NULL WHERE session_id = ?`),
    db.prepare(`DELETE FROM wakeups WHERE session_id = ?`),
    db.prepare(`DELETE FROM events WHERE session_id = ?`),
    db.prepare(`DELETE FROM reports WHERE session_id = ?`),
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
  // Inbox 里的待决定事项不挂着 Provider 回调，答案走普通消息，重启后照样能答
  const expireAllPending = db.prepare(`UPDATE pending_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND json_extract(request, '$.filed') IS NOT 1`);
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
  const deleteWorkspaceSecrets = db.prepare(`DELETE FROM secrets WHERE workspace_id = ?`);
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
    scheduleId: (r.schedule_id as string | null) ?? null,
    forkedFrom: r.forked_from_id ? { id: r.forked_from_id as string, seq: Number(r.forked_at_seq) } : null,
    spawnGranted: r.spawn_granted_at != null,
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
  const rowToReport = (r: Record<string, unknown>): Report => ({
    id: r.id as string,
    sessionId: r.session_id as string,
    title: r.title as string,
    summary: r.summary as string,
    body: r.body as string,
    createdAt: r.created_at as string,
    readAt: (r.read_at as string | null) ?? null,
  });
  const rowToTodo = (r: Record<string, unknown>): Todo => ({
    id: r.id as string,
    title: r.title as string,
    note: r.note as string,
    cwd: (r.cwd as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    remindOn: (r.remind_on as string | null) ?? null,
    createdAt: r.created_at as string,
    doneAt: (r.done_at as string | null) ?? null,
  });
  // 判断结果只对 review_for 那次活动有效；会话再有活动 updated_at 就变了，结果自动失效
  const currentReview = `review_for = updated_at`;
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
  const scheduleConfig = ({ name, provider, workspaceId, model, effort, permissionMode, prompt, kind, time, enabled }: ScheduleConfig): ScheduleConfig =>
    ({ name, provider, workspaceId, model, effort, permissionMode, prompt, kind, time, enabled });
  const rowToSchedule = (r: Record<string, unknown>): Schedule => ({
    ...(JSON.parse(r.config as string) as ScheduleConfig),
    id: r.id as string,
    nextRunAt: (r.next_run_at as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastSessionId: (r.last_session_id as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as string,
  });
  const rowToEvent =(r: Record<string, unknown>): AgentEvent =>
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
        session.status, session.model, session.effort, session.permissionMode, session.parentId, session.scheduleId ?? null, session.createdAt, session.updatedAt,
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
          session.status, session.model, session.effort, session.permissionMode, session.parentId, session.scheduleId ?? null, session.createdAt, session.updatedAt,
        );
        if (session.title) db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(session.title, session.id);
        if (session.forkedFrom) db.prepare('UPDATE sessions SET forked_from_id = ?, forked_at_seq = ? WHERE id = ?').run(session.forkedFrom.id, session.forkedFrom.seq, session.id);
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
    setSessionParent(id: string, parentId: string | null) {
      db.prepare('UPDATE sessions SET parent_id = ? WHERE id = ?').run(parentId, id);
    },
    /** 派生授权落库：用户离开时 Hub 可能被 update-when-idle 重启，只放内存会让夜里的下一次 create_session 卡在审批上 */
    setSpawnGranted(id: string, granted: boolean) {
      if (granted) db.prepare('UPDATE sessions SET spawn_granted_at = ? WHERE id = ? AND spawn_granted_at IS NULL').run(new Date().toISOString(), id);
      else db.prepare('UPDATE sessions SET spawn_granted_at = NULL WHERE id = ?').run(id);
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
    allPending(): PendingRequest[] {
      return db.prepare(`SELECT * FROM pending_requests WHERE status = 'pending' ORDER BY created_at`).all().map(rowToPending);
    },
    /** Inbox 的 Done：已答或作废的异步提问；同步审批 / 提问是在会话里当场处理的，不进 Done */
    settledAsyncQuestions(limit: number): (PendingRequest & { resolution: Resolution | null })[] {
      return db.prepare(`SELECT * FROM pending_requests WHERE status != 'pending' AND json_extract(request, '$.delivery') = 'async' ORDER BY resolved_at DESC LIMIT ?`).all(limit)
        .map((r) => ({ ...rowToPending(r), resolution: r.resolution ? JSON.parse(r.resolution as string) as Resolution : null }));
    },
    createWakeup(w: Wakeup) {
      db.prepare(`INSERT INTO wakeups (id, session_id, at, note, created_at) VALUES (?, ?, ?, ?, ?)`).run(w.id, w.sessionId, w.at, w.note, w.createdAt);
    },
    listWakeups(): Wakeup[] {
      return db.prepare(`SELECT * FROM wakeups ORDER BY at`).all().map((r) => ({ id: r.id as string, sessionId: r.session_id as string, at: r.at as string, note: r.note as string, createdAt: r.created_at as string }));
    },
    /** 返回 false 表示已被触发或取消：触发前先删，同一个唤醒最多发一次 */
    deleteWakeup(id: string): boolean {
      return db.prepare(`DELETE FROM wakeups WHERE id = ?`).run(id).changes === 1;
    },
    createReport(r: Report) {
      db.prepare(`INSERT INTO reports (id, session_id, title, summary, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(r.id, r.sessionId, r.title, r.summary, r.body, r.createdAt);
    },
    listReports(read: boolean, limit: number): Report[] {
      return db.prepare(`SELECT * FROM reports WHERE (read_at IS NOT NULL) = ? ORDER BY ${read ? 'read_at' : 'created_at'} DESC LIMIT ?`).all(read ? 1 : 0, limit).map(rowToReport);
    },
    markReportRead(id: string): boolean {
      return db.prepare(`UPDATE reports SET read_at = ? WHERE id = ? AND read_at IS NULL`).run(new Date().toISOString(), id).changes === 1;
    },
    getReport(id: string): Report | undefined {
      const row = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
      return row && rowToReport(row);
    },
    /**
     * 下一个该判断是否收尾的会话：空闲满 cutoff、没归档、不是定时任务运行或子会话（父会话已删的算顶层）、
     * 有过 Agent 回复、当前这次活动还没判断过（或判为没收尾但还没有会话概况，即概况上线前判断的）。新近空闲的优先
     */
    nextSessionToReview(cutoff: string): { id: string; updatedAt: string } | undefined {
      const row = db.prepare(`SELECT id, updated_at FROM sessions s WHERE status IN ('idle', 'error') AND archived_at IS NULL AND schedule_id IS NULL
        AND (parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_id))
        AND updated_at <= ? AND (review_for IS NULL OR NOT ${currentReview} OR (review_state = 'open' AND review_summary IS NULL))
        AND EXISTS (SELECT 1 FROM events WHERE session_id = s.id AND type = 'message.completed')
        ORDER BY updated_at DESC LIMIT 1`).get(cutoff);
      return row && { id: row.id as string, updatedAt: row.updated_at as string };
    },
    /** 最近 limit 条用户消息与 Agent 回复，旧的在前 */
    recentMessages(sessionId: string, limit: number): { role: 'user' | 'agent'; text: string }[] {
      return db.prepare(`SELECT type, json_extract(payload, '$.text') AS text FROM events WHERE session_id = ? AND type IN ('message.user', 'message.completed') ORDER BY seq DESC LIMIT ?`)
        .all(sessionId, limit).reverse().map((r) => ({ role: r.type === 'message.user' ? 'user' as const : 'agent' as const, text: (r.text as string | null) ?? '' }));
    },
    /** state 为 null 表示判断失败：这次活动不再重试 */
    setReview(sessionId: string, reviewedFor: string, state: 'done' | 'open' | null, summary: string, next: string) {
      db.prepare(`UPDATE sessions SET review_for = ?, review_state = ?, review_summary = ?, review_next = ? WHERE id = ?`).run(reviewedFor, state, summary, next, sessionId);
    },
    /** 返回 false 表示它已不在 Inbox 里（有了新活动或已处理） */
    dismissReview(sessionId: string): boolean {
      return db.prepare(`UPDATE sessions SET review_state = 'dismissed' WHERE id = ? AND review_state = 'open' AND ${currentReview}`).run(sessionId).changes === 1;
    },
    unfinishedSessions(): UnfinishedSession[] {
      return db.prepare(`SELECT id, review_summary, review_next, updated_at FROM sessions WHERE review_state = 'open' AND ${currentReview} AND archived_at IS NULL ORDER BY updated_at DESC`).all()
        .map((r) => ({ sessionId: r.id as string, summary: (r.review_summary as string | null) ?? '', next: r.review_next as string, idleSince: r.updated_at as string }));
    },
    /** 判为已收尾、之后再没活动、空闲早于 cutoff 的会话移到 Inactive */
    archiveFinished(cutoff: string) {
      db.prepare(`UPDATE sessions SET archived_at = ? WHERE archived_at IS NULL AND status IN ('idle', 'error') AND review_state = 'done' AND ${currentReview} AND updated_at <= ?`)
        .run(new Date().toISOString(), cutoff);
    },
    createTodo(t: Todo) {
      db.prepare(`INSERT INTO todos (id, title, note, cwd, session_id, remind_on, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, t.title, t.note, t.cwd, t.sessionId, t.remindOn, t.createdAt, t.doneAt);
    },
    getTodo(id: string): Todo | undefined {
      const row = db.prepare(`SELECT * FROM todos WHERE id = ?`).get(id);
      return row && rowToTodo(row);
    },
    updateTodo(t: Todo) {
      db.prepare(`UPDATE todos SET title = ?, note = ?, cwd = ?, remind_on = ?, done_at = ? WHERE id = ?`).run(t.title, t.note, t.cwd, t.remindOn, t.doneAt, t.id);
    },
    deleteTodo(id: string): boolean {
      return db.prepare(`DELETE FROM todos WHERE id = ?`).run(id).changes === 1;
    },
    listTodos(done: boolean): Todo[] {
      return (done
        ? db.prepare(`SELECT * FROM todos WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 100`).all()
        : db.prepare(`SELECT * FROM todos WHERE done_at IS NULL ORDER BY remind_on IS NULL, remind_on, created_at DESC`).all()).map(rowToTodo);
    },
    /** 提醒日期已到（today 为本地日期 YYYY-MM-DD）的未完成待办 */
    dueTodos(today: string): Todo[] {
      return db.prepare(`SELECT * FROM todos WHERE done_at IS NULL AND remind_on <= ? ORDER BY remind_on, created_at`).all(today).map(rowToTodo);
    },
    /** Hub 重启后没有任何 Provider 回调在等这些请求，全部作废（Inbox 的待决定事项除外） */
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
    /** 服务配置和项目私有密钥跟着项目走，一起删；是否还有服务在跑由调用方先检查 */
    deleteWorkspace(id: string): boolean {
      deleteWorkspaceServices.run(id);
      deleteWorkspaceSecrets.run(id);
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
    createSchedule(s: Schedule) {
      db.prepare(`INSERT INTO schedules (id, config, next_run_at, created_at) VALUES (?, ?, ?, ?)`).run(s.id, JSON.stringify(scheduleConfig(s)), s.nextRunAt, s.createdAt);
    },
    listSchedules(): Schedule[] {
      return db.prepare(`SELECT * FROM schedules ORDER BY created_at`).all().map(rowToSchedule);
    },
    getSchedule(id: string): Schedule | undefined {
      const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
      return row && rowToSchedule(row);
    },
    updateSchedule(id: string, config: ScheduleConfig, nextRunAt: string | null): boolean {
      return db.prepare(`UPDATE schedules SET config = ?, next_run_at = ? WHERE id = ?`).run(JSON.stringify(config), nextRunAt, id).changes === 1;
    },
    /** 只有 next_run_at 仍是 expected 时才推进：先认领再执行，同一次到期最多执行一次 */
    claimScheduleRun(id: string, expected: string, nextRunAt: string | null, enabled: boolean): boolean {
      return db.prepare(`UPDATE schedules SET next_run_at = ?, config = json_set(config, '$.enabled', json(?)) WHERE id = ? AND next_run_at = ?`)
        .run(nextRunAt, String(enabled), id, expected).changes === 1;
    },
    recordScheduleRun(id: string, at: string, sessionId: string | null, error: string | null) {
      db.prepare(`UPDATE schedules SET last_run_at = ?, last_session_id = COALESCE(?, last_session_id), last_error = ? WHERE id = ?`).run(at, sessionId, error, id);
    },
    deleteSchedule(id: string): boolean {
      return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes === 1;
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
    listSecrets(): Secret[] {
      return db.prepare(`SELECT id, workspace_id, name, description, updated_at FROM secrets ORDER BY name, workspace_id`).all().map(rowToSecret);
    },
    getSecretValue(id: string): string | undefined {
      return db.prepare(`SELECT value FROM secrets WHERE id = ?`).get(id)?.value as string | undefined;
    },
    /** 同一作用域同名即覆盖，id 不变 */
    saveSecret(workspaceId: string | null, name: string, description: string, value: string): Secret {
      const row = db.prepare(`INSERT INTO secrets (id, workspace_id, name, value, description, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, name) DO UPDATE SET value = excluded.value, description = excluded.description, updated_at = excluded.updated_at
        RETURNING id, workspace_id, name, description, updated_at`).get(randomUUID(), workspaceId ?? '', name, value, description, new Date().toISOString())!;
      return rowToSecret(row);
    },
    /** 改到的作用域已有同名时返回 'conflict' */
    updateSecret(id: string, workspaceId: string | null, description: string, value: string | undefined): Secret | undefined | 'conflict' {
      try {
        const row = db.prepare(`UPDATE secrets SET workspace_id = ?, description = ?, value = COALESCE(?, value), updated_at = ? WHERE id = ?
          RETURNING id, workspace_id, name, description, updated_at`).get(workspaceId ?? '', description, value ?? null, new Date().toISOString(), id);
        return row && rowToSecret(row);
      } catch (err) {
        if ((err as { errcode?: number }).errcode === 2067) return 'conflict'; // SQLITE_CONSTRAINT_UNIQUE
        throw err;
      }
    },
    deleteSecret(id: string): boolean {
      return db.prepare(`DELETE FROM secrets WHERE id = ?`).run(id).changes === 1;
    },
    close() {
      db.close();
    },
  };
}

const rowToSecret = (r: Record<string, unknown>): Secret => ({
  id: r.id as string,
  workspaceId: (r.workspace_id as string) || null,
  name: r.name as string,
  description: r.description as string,
  updatedAt: r.updated_at as string,
});
