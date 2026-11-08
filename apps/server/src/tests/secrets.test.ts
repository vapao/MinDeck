import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store/db';
import { createAttachmentStore } from '../store/attachments';
import { createHub } from '../hub';
import { createPush } from '../push';
import { agentdeckMcpFor } from '../mcp';

// 规则（2026-11-08 与开发者确认）：request_secret 提交的值只存在 secrets 表里，不进 pending_requests、事件流或发回会话的消息。
test('a submitted secret value is stored only in the secrets table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-secrets-'));
  const dbPath = join(dir, 'agentdeck.db');
  const store = openStore(dbPath);
  const hub = createHub(store, createAttachmentStore(store, join(dir, 'uploads')), (id) => agentdeckMcpFor('http://127.0.0.1:0/mcp', id), createPush(store));
  const value = 'sk-test-7f3a9c1e';
  try {
    store.createWorkspace({ id: 'workspace', path: dir, alias: 'test', createdAt: new Date().toISOString() });
    // 没配 Key 的 DeepSeek 会话：存完密钥后唤醒会话时失败，测试不会真拉起 Provider
    const session = hub.createSession('deepseek', dir);
    const request = hub.fileSecretRequest(session.id, { name: 'API_TOKEN', description: 'test', shared: false });
    assert.throws(() => hub.resolvePending(request.id, { kind: 'question', answers: {}, response: value }), /DeepSeek API Key/);

    const secret = store.listSecrets().find((s) => s.name === 'API_TOKEN');
    assert.equal(secret?.workspaceId, 'workspace');
    assert.equal(store.getSecretValue(secret!.id), value);

    const raw = new DatabaseSync(dbPath);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'secrets'`).all() as { name: string }[]).map((t) => t.name);
    for (const table of tables) {
      for (const row of raw.prepare(`SELECT * FROM "${table}"`).all()) assert.ok(!JSON.stringify(row).includes(value), `value leaked into ${table}`);
    }
    raw.close();
  } finally {
    hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
