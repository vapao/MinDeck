import { randomUUID } from 'node:crypto';
import type { Schedule, ScheduleConfig } from '@agentdeck/shared';
import type { Store } from './store/db';
import { HubError, type createHub } from './hub';

type Hub = ReturnType<typeof createHub>;

// 停机（重启、断电）错过的执行：1 小时内的启动后补跑一次，更早的只记一条错过，不逐次补跑
const catchUpMs = 60 * 60 * 1000;
const tickMs = 30 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 严格晚于 after 的下一次执行时间，按本机时区；once 不看 after，直接返回它的时间 */
export function nextRun(kind: Schedule['kind'], time: string, after: Date): Date {
  if (kind === 'once') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(time);
    if (!m) throw new HubError(400, 'Time must be YYYY-MM-DDTHH:mm');
    return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  }
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || +m[1]! > 23 || +m[2]! > 59) throw new HubError(400, 'Time must be HH:mm');
  const at = new Date(after.getFullYear(), after.getMonth(), after.getDate(), +m[1]!, +m[2]!);
  while (at <= after || (kind === 'weekdays' && (at.getDay() === 0 || at.getDay() === 6))) at.setDate(at.getDate() + 1);
  return at;
}

export function createScheduler(store: Store, hub: Hub, now = () => new Date()) {
  function validate(config: ScheduleConfig): string | null {
    if (!config.name.trim() || !config.prompt.trim()) throw new HubError(400, 'Name and prompt are required');
    if (!['once', 'daily', 'weekdays'].includes(config.kind)) throw new HubError(400, `Unknown schedule kind ${config.kind}`);
    if (!store.getWorkspace(config.workspaceId)) throw new HubError(400, 'Project not found');
    hub.resolveSessionConfig(config.provider, config);
    const at = nextRun(config.kind, config.time, now());
    if (!config.enabled) return null;
    if (at <= now()) throw new HubError(400, 'This time has already passed');
    return at.toISOString();
  }

  function get(id: string): Schedule {
    const schedule = store.getSchedule(id);
    if (!schedule) throw new HubError(404, 'Scheduled task not found');
    return schedule;
  }

  function execute(s: Schedule): string {
    const workspace = store.getWorkspace(s.workspaceId);
    if (!workspace) throw new HubError(400, 'Project was removed');
    const session = hub.createSession(s.provider, workspace.path, { model: s.model, effort: s.effort, permissionMode: s.permissionMode, scheduleId: s.id });
    // 先占住标题：每次执行都是同一句 prompt，AI 标题分不出是哪天的
    store.setSessionTitle(session.id, `${s.name} · ${localDate(now())}`);
    try {
      hub.sendMessage(session.id, s.prompt, []);
    } catch (error) {
      if (hub.lastSeq(session.id) === 0) hub.deleteSession(session.id);
      throw error;
    }
    return session.id;
  }

  function run(s: Schedule) {
    const at = now().toISOString();
    try {
      store.recordScheduleRun(s.id, at, execute(s), null);
    } catch (error) {
      store.recordScheduleRun(s.id, at, null, (error as Error).message);
    }
  }

  function tick() {
    const t = now();
    hub.fireDueWakeups(t);
    for (const s of store.listSchedules()) {
      if (!s.enabled || !s.nextRunAt || new Date(s.nextRunAt) > t) continue;
      // 下一次从现在算而不是从这次的到期时间算：停机多天回来不会连跑多次
      const next = s.kind === 'once' ? null : nextRun(s.kind, s.time, t).toISOString();
      if (!store.claimScheduleRun(s.id, s.nextRunAt, next, s.kind !== 'once')) continue;
      if (t.getTime() - new Date(s.nextRunAt).getTime() > catchUpMs) {
        const due = new Date(s.nextRunAt);
        store.recordScheduleRun(s.id, t.toISOString(), null, `Missed the run at ${localDate(due)} ${localTime(due)}: AgentDeck was not running`);
      } else run(s);
    }
  }

  return {
    list: () => store.listSchedules(),
    validate: (config: ScheduleConfig) => void validate(config),
    create(config: ScheduleConfig): Schedule {
      const schedule: Schedule = { ...config, id: randomUUID(), nextRunAt: validate(config), lastRunAt: null, lastSessionId: null, lastError: null, createdAt: now().toISOString() };
      store.createSchedule(schedule);
      return get(schedule.id);
    },
    update(id: string, config: ScheduleConfig): Schedule {
      get(id);
      store.updateSchedule(id, config, validate(config));
      return get(id);
    },
    remove(id: string) {
      if (!store.deleteSchedule(id)) throw new HubError(404, 'Scheduled task not found');
    },
    /** 手动执行一次：不动下次执行时间，失败直接报给调用方 */
    runNow(id: string): string {
      const s = get(id);
      const sessionId = execute(s);
      store.recordScheduleRun(id, now().toISOString(), sessionId, null);
      return sessionId;
    },
    tick,
    start() {
      tick();
      const timer = setInterval(tick, tickMs);
      return () => clearInterval(timer);
    },
  };
}
