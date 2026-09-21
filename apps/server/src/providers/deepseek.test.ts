import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../hub';
import { openStore } from '../store/db';
import { createAttachmentStore } from '../store/attachments';
import { deepseekEnv } from './claude';

// 密钥不能混入普通设置响应；不带新密钥的保存必须保留原密钥，重启也不能丢失。
test('DeepSeek settings keep credentials separate and survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-settings-'));
  let store = openStore(join(dir, 'test.db'));
  let hub = createHub(store, createAttachmentStore(store, join(dir, 'uploads')));
  try {
    const defaults = hub.settings();
    store.createWorkspace({ id: 'w', path: dir, alias: 'test', createdAt: new Date().toISOString() });
    const session = hub.createSession('claude', dir);
    const next = { ...defaults, deepseek: { ...defaults.deepseek, apiKey: 'test-secret', model: 'deepseek-v4-pro', permissionMode: 'bypass' as const } };
    hub.updateSettings(next);
    assert.equal(store.getDeepseekApiKey(), 'test-secret');
    assert.equal(JSON.stringify(hub.settings()).includes('test-secret'), false);
    assert.equal(JSON.stringify(store.getSettings()).includes('test-secret'), false);
    hub.updateSettings(hub.settings());
    assert.equal(store.getDeepseekApiKey(), 'test-secret');
    const switched = hub.setProvider(session.id, 'deepseek');
    assert.equal(switched.model, 'deepseek-v4-pro');
    assert.equal(switched.permissionMode, 'approval');
    const created = hub.createSession('deepseek', dir);
    assert.equal(created.permissionMode, 'bypass');
    hub.close();
    store.close();
    store = openStore(join(dir, 'test.db'));
    hub = createHub(store, createAttachmentStore(store, join(dir, 'uploads')));
    assert.equal(store.getDeepseekApiKey(), 'test-secret');
    assert.equal(hub.settings().deepseek.apiKeyConfigured, true);
    assert.equal(hub.getSession(session.id).provider, 'deepseek');
    assert.deepEqual(hub.settings().claude, defaults.claude);
    hub.updateSettings({ ...hub.settings(), deepseek: { ...hub.settings().deepseek, apiKey: '' } });
    assert.equal(store.getDeepseekApiKey(), '');
    assert.equal(hub.settings().deepseek.apiKeyConfigured, false);
  } finally {
    hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 按会话构造认证和模型映射，不允许配置一个会话时改写 Hub 或另一个会话的环境。
test('DeepSeek credentials and model routing are isolated per session', () => {
  const before = { ...process.env };
  const flash = deepseekEnv({ baseUrl: 'https://one.example/anthropic', apiKey: 'first' }, 'deepseek-flash');
  const pro = deepseekEnv({ baseUrl: 'https://two.example/anthropic', apiKey: 'second' }, 'deepseek-v4-pro');
  assert.equal(flash.ANTHROPIC_AUTH_TOKEN, 'first');
  assert.equal(pro.ANTHROPIC_AUTH_TOKEN, 'second');
  assert.equal(flash.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-flash[1m]');
  assert.equal(pro.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-pro');
  assert.equal(pro.ANTHROPIC_API_KEY, '');
  assert.equal(pro.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.deepEqual({ ...process.env }, before);
});
