import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './db';

// 规则：每个 session 的事件 seq 从 1 开始、严格 +1 单调；不同 session 互不影响；重放按 seq 有序。
test('event seq is strictly monotonic per session', () => {
  const store = openStore(':memory:');
  const now = new Date().toISOString();
  for (const id of ['a', 'b']) {
    store.createSession({ id, provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', createdAt: now, updatedAt: now });
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
  store.createSession({ id: 's', provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', createdAt: now, updatedAt: now });
  store.createPending({ id: 'p1', sessionId: 's', status: 'pending', createdAt: now, resolvedAt: null, kind: 'approval', toolName: 'Bash', toolUseId: 't', input: {}, sessionAllowPatterns: [], suggestions: [] });

  assert.equal(store.resolvePending('p1', { kind: 'approval', decision: 'allow_once' }), true);
  assert.equal(store.resolvePending('p1', { kind: 'approval', decision: 'deny' }), false);
  assert.equal(store.getPending('p1')?.status, 'resolved');
  assert.deepEqual(store.pendingBySession('s'), []);
});
