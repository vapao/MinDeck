import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import type { Session, StewardBrief, StewardMemory, StewardResponse } from '@agentdeck/shared';
import type { Store } from './store/db';
import type { Services } from './services';
import { HubError, type createHub } from './hub';
import { listChanges } from './changes';
import { nextRun } from './schedules';

type Hub = ReturnType<typeof createHub>;
export type Steward = ReturnType<typeof createSteward>;

// 管家（docs/features.md「管家 Steward」）：界面上是一段连续对话，底层按天、按上下文大小、按模型设置换会话，
// 每个新会话开头由 Hub 附上说明、记忆、最新简报和上一段对话的结尾，用户看不到压缩，管家也不靠上下文记事
const rotateAtTokens = 150_000;
// 和定时任务一样：停机错过的 1 小时内补跑，更晚就不跑了，简报过了上班时间没意义
const catchUpMs = 60 * 60 * 1000;
const autoBriefKey = 'steward_auto_brief';

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const local = (iso: string | null) => (iso ? `${localDate(new Date(iso))} ${pad(new Date(iso).getHours())}:${pad(new Date(iso).getMinutes())}` : null);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const instructions = (briefTime: string) => `You are the user's steward in AgentDeck, a self-hosted console where the user runs many Claude / Codex / DeepSeek coding sessions across projects. Your job is to keep track of the state of their work and tell them what needs their attention, so they don't have to open sessions one by one.

How you work:
- AgentDeck asks you for a brief every weekday at ${briefTime} (host local time) and whenever the user clicks Run brief; no scheduled task is needed for it.
- You can only look and advise. You cannot start, message or stop sessions, or change services and scheduled tasks; tell the user what to do instead. Use add_todo when the user asks you to note something down.
- For the current state call work_snapshot (sessions, approvals and questions waiting for the user, unread reports, todos, scheduled tasks, services, uncommitted files). Use get_session to read a session's conversation when you need details. Never answer about the state of work from memory.
- Link a session as [title](session:ID) so the user can open it.
- Long-term memory: the list below is all you keep beyond this conversation. When the user states a lasting preference, rule, goal or standing request, or asks you to remember something, call remember with one self-contained sentence. When an item becomes wrong or outdated, call forget with its id (and remember the corrected version). Do not store the state of work; it changes daily and is in work_snapshot.
- This conversation moves to a fresh thread every day and when it grows long. Each thread starts with your memory, the latest brief and the end of the previous thread. Do not mention this to the user.
- Be concise and lead with what needs the user. Reply in the user's language (Simplified Chinese unless your memory says otherwise).`;

const briefRequest = (reason: string, snapshot: unknown) => `[AgentDeck] Time for the brief (${reason}). Current state:

${JSON.stringify(snapshot)}

This state is current; do not call work_snapshot for it. Write the brief, publish it with publish_brief, then reply with one short line. Markdown with these sections, leaving out empty ones:
## Needs you
What is blocked on the user or waiting for their decision, most urgent first; for each, why and the next step.
## Watch
Running or recently failed work, problems in services or scheduled tasks, unfinished work worth a look.
## Can clean up
Sessions that look done and can be archived or deleted, stale todos.
Group sessions that are about the same thing into one item. Leave out what needs nothing. Follow your memory about what the user wants in the brief.`;

export function createSteward(store: Store, hub: Hub, services: Services, dir: string) {
  mkdirSync(dir, { recursive: true });
  // 用户在页面上改了记忆：当前会话下一条消息开头补上最新记忆。只在内存里，Hub 重启丢了也只是等到下一次换会话
  const memoryStale = new Set<string>();

  const sessions = () => store.listSessions().filter((s) => s.steward).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const memoryList = () => store.listStewardMemories().map((m) => `- [${m.id}] ${m.text}`).join('\n') || '(empty)';

  // 运行中的不换：消息插入当前轮。否则不是今天的、上下文太大、或模型设置变了就换新会话
  function reusable(s: Session, now: Date): boolean {
    if (s.status === 'running' || s.status === 'waiting_user') return true;
    const { provider, model, effort } = hub.settings().steward;
    const config = hub.resolveSessionConfig(provider, { model, effort });
    return localDate(new Date(s.createdAt)) === localDate(now) && s.provider === provider && s.model === config.model && s.effort === config.effort
      && (hub.contextTokens(s.id) ?? 0) < rotateAtTokens;
  }

  function setup(prior: Session | undefined): string {
    const brief = store.listStewardBriefs(1)[0];
    const tail = prior ? store.recentMessages(prior.id, 12).map((m) => `[${m.role === 'user' ? 'USER' : 'STEWARD'}] ${clip(m.text, 1500)}`).join('\n\n') : '';
    return [
      instructions(hub.settings().steward.briefTime),
      `Your memory:\n${memoryList()}`,
      brief ? `Latest brief (${local(brief.createdAt)}):\n${brief.body}` : 'No brief yet.',
      tail ? `End of the previous thread:\n${tail}` : '',
      '---',
    ].filter(Boolean).join('\n\n');
  }

  function send(text: string, providerText: string) {
    const now = new Date();
    const latest = sessions()[0];
    let session = latest;
    let prefix = '';
    if (!session || !reusable(session, now)) {
      const { provider, model, effort } = hub.settings().steward;
      session = hub.createSession(provider, dir, { model, effort, steward: true });
      store.setSessionTitle(session.id, `Steward · ${localDate(now)}`);
      prefix = `${setup(latest)}\n\n`;
    } else if (memoryStale.has(session.id)) {
      prefix = `[AgentDeck] The user edited your memory. It now reads:\n${memoryList()}\n\n---\n\n`;
    }
    try {
      const result = hub.sendMessage(session.id, text, [], 'user', prefix + providerText);
      memoryStale.delete(session.id);
      return { sessionId: session.id, ...result };
    } catch (error) {
      if (hub.lastSeq(session.id) === 0) hub.deleteSession(session.id);
      throw error;
    }
  }

  async function snapshot(now = new Date()) {
    const workspaces = store.listWorkspaces();
    const project = (cwd: string) => workspaces.find((w) => w.path === cwd)?.alias ?? cwd;
    const title = (id: string) => store.getSession(id)?.title ?? null;
    const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
    const unfinished = new Map(store.unfinishedSessions().map((u) => [u.sessionId, u]));
    return {
      now: local(now.toISOString()),
      sessions: hub.listSessions().filter((s) => !s.archivedAt && s.updatedAt >= since).slice(0, 80).map((s) => {
        const u = unfinished.get(s.id);
        return {
          id: s.id, title: s.title, project: project(s.cwd), provider: s.provider, status: s.status, updatedAt: local(s.updatedAt),
          ...(s.parentId ? { parentId: s.parentId } : {}),
          ...(s.scheduleId ? { scheduledRun: true } : {}),
          ...(s.backgroundTasks ? { backgroundTasks: s.backgroundTasks } : {}),
          ...(u ? { unfinished: { summary: u.summary, next: u.next } } : {}),
        };
      }),
      waitingOnUser: store.allPending().filter((p) => !store.getSession(p.sessionId)?.steward).map((p) => ({
        sessionId: p.sessionId, sessionTitle: title(p.sessionId), since: local(p.createdAt),
        ...(p.kind === 'approval' ? { kind: 'approval', tool: p.toolName } : { kind: p.delivery === 'async' ? 'decision' : 'question', question: p.questions.map((q) => q.question).join(' / ') }),
      })),
      unreadReports: store.listReports(false, 50).map((r) => ({ sessionId: r.sessionId, title: r.title, summary: r.summary, at: local(r.createdAt) })),
      todos: store.listTodos(false).map((t) => ({ title: t.title, note: clip(t.note, 300), remindOn: t.remindOn, project: t.cwd && project(t.cwd), sessionId: t.sessionId })),
      scheduledTasks: store.listSchedules().map((s) => ({ name: s.name, enabled: s.enabled, nextRunAt: local(s.nextRunAt), lastRunAt: local(s.lastRunAt), lastError: s.lastError, lastSessionId: s.lastSessionId })),
      services: services.list().map((s) => ({ project: workspaces.find((w) => w.id === s.workspaceId)?.alias ?? null, name: s.name, running: s.running })),
      projects: await Promise.all(workspaces.map(async (w) => ({
        project: w.alias, path: w.path,
        uncommittedFiles: existsSync(w.path) ? (await listChanges(w.path)).files.length : 'directory missing',
      }))),
    };
  }

  async function brief(reason: string) {
    return send(`[AgentDeck] Brief requested (${reason})`, briefRequest(reason, await snapshot()));
  }

  return {
    snapshot,
    brief: () => brief('run by the user'),
    send: (text: string) => send(text, text),

    view(): StewardResponse {
      const all = sessions();
      return {
        sessionId: all[0]?.id ?? null,
        sessions: all.map((s) => ({ id: s.id, title: s.title, status: s.status, createdAt: s.createdAt })),
        briefs: store.listStewardBriefs(30),
        memories: store.listStewardMemories(),
        nextAutoBriefAt: nextRun('weekdays', hub.settings().steward.briefTime, new Date()).toISOString(),
        lastAutoBrief: store.getState<{ date: string; error: string | null }>(autoBriefKey),
      };
    },

    /** 调度器每次 tick 调：工作日设定时间起一小时内、当天还没跑过就跑一次。先记日期再跑，失败只记原因不重试 */
    tick(now: Date) {
      if (now.getDay() === 0 || now.getDay() === 6) return;
      const today = localDate(now);
      const time = hub.settings().steward.briefTime;
      const [h, m] = time.split(':').map(Number);
      const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      if (now < due || now.getTime() - due.getTime() > catchUpMs) return;
      if (store.getState<{ date: string }>(autoBriefKey)?.date === today) return;
      store.setState(autoBriefKey, { date: today, error: null });
      brief(`scheduled ${time}`).catch((err: Error) => store.setState(autoBriefKey, { date: today, error: err.message }));
    },

    publishBrief(sessionId: string, body: string): StewardBrief {
      const row: StewardBrief = { id: randomUUID(), sessionId, body, createdAt: new Date().toISOString() };
      store.createStewardBrief(row);
      return row;
    },

    /** byUser：页面上改的，要让当前会话知道；管家自己经 MCP 改的它本来就知道 */
    remember(text: string, byUser: boolean): StewardMemory {
      if (!text.trim()) throw new HubError(400, 'Memory text is required');
      const now = new Date().toISOString();
      const row: StewardMemory = { id: randomUUID().slice(0, 8), text: text.trim(), createdAt: now, updatedAt: now };
      store.createStewardMemory(row);
      if (byUser) markStale();
      return row;
    },
    updateMemory(id: string, text: string) {
      if (!text.trim()) throw new HubError(400, 'Memory text is required');
      if (!store.updateStewardMemory(id, text.trim())) throw new HubError(404, 'Memory not found');
      markStale();
    },
    forget(id: string, byUser: boolean) {
      if (!store.deleteStewardMemory(id)) throw new HubError(404, 'Memory not found');
      if (byUser) markStale();
    },
  };

  function markStale() {
    const current = sessions()[0];
    if (current) memoryStale.add(current.id);
  }
}
