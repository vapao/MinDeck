import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './db';

// 升级旧库不能丢失原标题；生成标题必须持久化且不能改变排序、重复覆盖或复活已删除会话。
test('AI titles survive migration and restart without changing activity or overwriting titles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-title-store-'));
  const path = join(dir, 'test.db');
  let store = openStore(path);
  const now = '2026-09-01T00:00:00.000Z';
  try {
    store.createSession({ id: 's', provider: 'claude', cwd: dir, providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
    store.appendEvent('s', { type: 'message.user', payload: { text: '  \n\t ', attachments: [] } });
    assert.equal(store.hasUserText('s'), false);
    store.appendEvent('s', { type: 'message.user', payload: { text: '帮我增加 AI 会话标题', attachments: [] } });
    assert.equal(store.hasUserText('s'), true);
    store.createSession({ ...store.getSession('s')!, id: 'legacy' });
    store.appendEvent('legacy', { type: 'message.user', payload: { text: '旧会话第一行\n第二行', attachments: [] } });
    store.close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE sessions DROP COLUMN title');
    old.close();
    store = openStore(path);
    assert.equal(store.getSession('s')?.title, null);
    assert.equal(store.getSession('legacy')?.title, '旧会话第一行');
    store.setSessionTitle('s', 'AI 会话标题');
    store.setSessionTitle('s', '不能覆盖');
    store.close();
    store = openStore(path);
    assert.equal(store.getSession('s')?.title, 'AI 会话标题');
    assert.equal(store.getSession('s')?.updatedAt, now);
    assert.equal(store.hasUserText('s'), true);
    store.deleteSession('s');
    store.setSessionTitle('s', '迟到结果');
    assert.equal(store.getSession('s'), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
