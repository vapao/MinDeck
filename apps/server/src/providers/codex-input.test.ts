import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createHub } from '../hub';
import { agentdeckMcpFor } from '../mcp';
import { openStore } from '../store/db';
import { createAttachmentStore } from '../store/attachments';

// 真实捕获的 async agentMessage 形状；验证答案不会被排进轮后队列或重复发送。
test('async agent questions become cards and answers reach both active and idle turns exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-input-'));
  const previousPath = process.env.PATH;
  writeFileSync(join(dir, 'codex'), `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => send({ method, params: { threadId: 'thread', ...params } });
let count = 0;
const complete = () => notify('turn/completed', { turn: { id: String(count), status: 'completed', error: null, durationMs: 0 } });
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') send({ id: m.id, result: {
    thread: { id: 'thread' }, model: 'fake', approvalPolicy: m.params.approvalPolicy, sandbox: { type: 'workspaceWrite' }
  } });
  if (m.method === 'turn/start') {
    count++;
    send({ id: m.id, result: { turn: { id: String(count) } } });
    const text = m.params.input[0].text;
    const item = text.includes('：')
      ? { type: 'agentMessage', id: 'answer' + count, text, delivery: null, questions: null }
      : { type: 'agentMessage', id: 'call_' + count, text: '验收选择哪种颜色？\\n- 蓝色\\n- 绿色', phase: 'final_answer', memoryCitation: null, delivery: 'async', questions: [{ title: '验收选择哪种颜色？', options: ['蓝色', '绿色'] }] };
    notify('item/started', { item });
    notify('item/completed', { item });
    if (text === 'idle' || text.includes('：')) complete();
  }
  if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); complete(); }
});
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${previousPath}`;
  const store = openStore(':memory:');
  const hub = createHub(store, createAttachmentStore(store, join(dir, 'uploads')), (id) => agentdeckMcpFor('http://127.0.0.1:0/mcp', id));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (check()) return; await setTimeout(10); }
    assert.fail('Timed out waiting for fake app-server');
  };
  try {
    store.createWorkspace({ id: 'workspace', path: dir, alias: 'test', createdAt: new Date().toISOString() });
    const session = hub.createSession('codex', dir);
    const events = () => store.eventsAfter(session.id, 0);
    const answer = { kind: 'question' as const, answers: { '验收选择哪种颜色？': ['绿色'] } };
    for (const mode of ['active', 'idle']) {
      hub.sendMessage(session.id, mode, []);
      await until(() => hub.pendingRequests(session.id).length === 1 && (mode === 'active' || store.getSession(session.id)?.status === 'idle'));
      const question = hub.pendingRequests(session.id)[0];
      assert.equal(question.kind === 'question' && question.delivery, 'async');
      assert.equal(store.getSession(session.id)?.status, mode === 'active' ? 'running' : 'idle');
      const turns = events().filter((e) => e.type === 'turn.started').length;
      hub.resolvePending(question.id, answer);
      assert.throws(() => hub.resolvePending(question.id, answer), /Already handled/);
      assert.equal(events().filter((e) => e.type === 'turn.started').length, turns + (mode === 'idle' ? 1 : 0));
      await until(() => store.getSession(session.id)?.status === 'idle');
      assert.equal(store.getPending(question.id)?.status, 'resolved');
    }
    const messages = events().filter((e) => e.type === 'message.completed');
    assert.deepEqual(messages.map((e) => e.payload.text), ['验收选择哪种颜色？：绿色', '验收选择哪种颜色？：绿色']);
    assert.ok(!events().some((e) => e.type === 'session.status' && e.payload.status === 'waiting_user'));
    hub.sendMessage(session.id, 'interrupt', []);
    await until(() => hub.pendingRequests(session.id).length === 1);
    const question = hub.pendingRequests(session.id)[0];
    await hub.interrupt(session.id);
    assert.equal(store.getPending(question.id)?.status, 'expired');
    assert.throws(() => hub.resolvePending(question.id, answer), /Already handled/);
  } finally {
    hub.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
