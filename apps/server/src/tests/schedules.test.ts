import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleConfig } from '@mindeck/shared';
import { openStore } from '../store/db';
import { createScheduler, nextRun } from '../schedules';

// 规则：下一次执行严格晚于当前时间；工作日跳过周六周日
test('nextRun is strictly later and weekdays skip the weekend', () => {
  const fri = new Date(2026, 10, 6, 9, 0); // 2026-11-06 周五 09:00
  assert.deepEqual(nextRun('daily', '09:00', fri), new Date(2026, 10, 7, 9, 0));
  assert.deepEqual(nextRun('daily', '09:01', fri), new Date(2026, 10, 6, 9, 1));
  assert.deepEqual(nextRun('weekdays', '09:00', fri), new Date(2026, 10, 9, 9, 0));
  assert.deepEqual(nextRun('weekdays', '08:00', new Date(2026, 10, 7, 12, 0)), new Date(2026, 10, 9, 8, 0));
});

function setup(start: Date) {
  const store = openStore(':memory:');
  store.createWorkspace({ id: 'w', path: '/tmp/w', alias: 'w', createdAt: start.toISOString() });
  const runs: string[] = [];
  let seq = 0;
  const hub = {
    resolveSessionConfig: () => ({}),
    createSession: () => ({ id: `s${++seq}` }),
    sendMessage: (id: string) => void runs.push(id),
    lastSeq: () => 1,
    deleteSession: () => {},
    fireDueWakeups: () => {},
    reviewIdleSessions: async () => {},
  };
  let t = start;
  const scheduler = createScheduler(store, hub as never, () => t);
  return { store, runs, scheduler, at: (d: Date) => { t = d; } };
}

const config = (kind: ScheduleConfig['kind'], time: string): ScheduleConfig => ({ name: 'n', provider: 'claude', workspaceId: 'w', model: '', effort: '', permissionMode: 'approval', prompt: 'p', kind, time, enabled: true });

// 规则：一次到期只执行一次；一次性任务执行后停用
test('a due run executes once and a one-off task disables itself', () => {
  const { runs, scheduler, at } = setup(new Date(2026, 10, 2, 8, 0));
  const s = scheduler.create(config('once', '2026-11-02T09:00'));
  at(new Date(2026, 10, 2, 9, 0, 10));
  scheduler.tick();
  scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(scheduler.list()[0]!.enabled, false);
  assert.equal(scheduler.list()[0]!.nextRunAt, null);
  assert.equal(scheduler.list()[0]!.id, s.id);
});

// 规则：停机错过多次也不逐次补跑；超过 1 小时的只记错过，不执行
test('missed runs are not backfilled, and runs over an hour late are skipped', () => {
  const { runs, scheduler, at } = setup(new Date(2026, 10, 2, 8, 0));
  scheduler.create(config('daily', '09:00'));
  at(new Date(2026, 10, 5, 9, 30)); // 停机三天，09:30 回来
  scheduler.tick();
  assert.equal(runs.length, 0);
  assert.match(scheduler.list()[0]!.lastError!, /Missed/);
  assert.equal(scheduler.list()[0]!.nextRunAt, new Date(2026, 10, 6, 9, 0).toISOString());

  at(new Date(2026, 10, 6, 9, 40)); // 晚 40 分钟：补跑一次
  scheduler.tick();
  scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(scheduler.list()[0]!.lastError, null);
});
