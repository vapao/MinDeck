import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './db';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 规则：每个 session 的事件 seq 从 1 开始、严格 +1 单调；不同 session 互不影响；重放按 seq 有序。
test('event seq is strictly monotonic per session', () => {
  const store = openStore(':memory:');
  const now = new Date().toISOString();
  for (const id of ['a', 'b']) {
    store.createSession({ id, provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
  }

  const seqsA = Array.from({ length: 5 }, () => store.appendEvent('a', { type: 'turn.started', payload: {} }).seq);
  const seqsB = Array.from({ length: 3 }, () => store.appendEvent('b', { type: 'turn.started', payload: {} }).seq);

  assert.deepEqual(seqsA, [1, 2, 3, 4, 5]);
  assert.deepEqual(seqsB, [1, 2, 3]);
  assert.equal(store.lastSeq('a'), 5);
  assert.deepEqual(store.eventsAfter('a', 3).map((e) => e.seq), [4, 5]);
  assert.deepEqual(store.eventsAfter('b', 0).map((e) => e.seq), [1, 2, 3]);
});

// 规则：一个 PendingRequest 只能被 resolve 一次；第二个设备的 resolve 必须失败（方案 §10.1）。
test('pending request resolves atomically exactly once', () => {
  const store = openStore(':memory:');
  const now = new Date().toISOString();
  store.createSession({ id: 's', provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
  store.createPending({ id: 'p1', sessionId: 's', status: 'pending', createdAt: now, resolvedAt: null, kind: 'approval', toolName: 'Bash', toolUseId: 't', input: {}, sessionAllowPatterns: [], suggestions: [] });

  assert.equal(store.resolvePending('p1', { kind: 'approval', decision: 'allow_once' }), true);
  assert.equal(store.resolvePending('p1', { kind: 'approval', decision: 'deny' }), false);
  assert.equal(store.getPending('p1')?.status, 'resolved');
  assert.deepEqual(store.pendingBySession('s'), []);
});

// 迁移仅修正 Codex 的旧拼写；重开库幂等，其他 Provider、合法等级及会话数据不变。
test('legacy Codex efforts migrate without changing other session data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-effort-'));
  const path = join(dir, 'hub.sqlite');
  try {
    openStore(path).close();
    const db = new DatabaseSync(path);
    for (const [id, provider, effort] of [
      ['a', 'codex', 'extra-high'], ['b', 'codex', 'light'],
      ['c', 'claude', 'extra-high'], ['d', 'codex', 'ultra'],
    ]) {
      db.prepare(`INSERT INTO sessions (id, provider, cwd, status, model, effort, created_at, updated_at)
        VALUES (?, ?, '/tmp', 'idle', 'gpt-6-sol', ?, 'before', 'before')`).run(id!, provider!, effort!);
    }
    db.prepare(`INSERT INTO settings VALUES ('defaults', ?)`).run(JSON.stringify({
      codex: { model: 'gpt-6-sol', effort: 'extra-high', permissionMode: 'approval' },
      claude: { effort: 'high' },
    }));
    db.close();
    for (let i = 0; i < 2; i++) {
      const store = openStore(path);
      try {
        assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => store.getSession(id)?.effort), ['xhigh', 'low', 'extra-high', 'ultra']);
        assert.equal(store.getSession('a')?.updatedAt, 'before');
        assert.equal(store.getSession('a')?.model, 'gpt-6-sol');
        assert.deepEqual(store.getSettings(), {
          codex: { model: 'gpt-6-sol', effort: 'xhigh', permissionMode: 'approval' },
          claude: { effort: 'high' },
        });
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 规则：派生授权跨 Hub 重启保留，且只属于被授权的会话（无人值守时重启不能让派生重新卡在审批上）。
test('spawn grant survives reopening the store and stays with its session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-spawn-'));
  try {
    const file = join(dir, 'hub.db');
    const now = new Date().toISOString();
    const store = openStore(file);
    for (const id of ['a', 'b']) {
      store.createSession({ id, provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
    }
    store.setSpawnGranted('a', true);

    const reopened = openStore(file);
    assert.equal(reopened.canSpawn('a'), true);
    assert.equal(reopened.canSpawn('b'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 规则（2026-11-04 与开发者确认）：Inbox 里 Agent 提交的待决定事项可能几天后才答，Hub 重启不能作废；挂着 Provider 回调的请求照旧作废。
test('hub restart keeps filed inbox questions and expires the rest', () => {
  const store = openStore(':memory:');
  const now = new Date().toISOString();
  store.createSession({ id: 's', provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
  const question = { sessionId: 's', status: 'pending' as const, createdAt: now, resolvedAt: null, kind: 'question' as const, toolUseId: 't', delivery: 'async' as const, questions: [] };
  store.createPending({ ...question, id: 'filed', filed: true });
  store.createPending({ ...question, id: 'codex-async' });
  store.createPending({ id: 'approval', sessionId: 's', status: 'pending', createdAt: now, resolvedAt: null, kind: 'approval', toolName: 'Bash', toolUseId: 't', input: {}, sessionAllowPatterns: [], suggestions: [] });

  store.expireAllPending();

  assert.deepEqual(store.allPending().map((p) => p.id), ['filed']);
  assert.equal(store.getPending('approval')?.status, 'expired');
});
