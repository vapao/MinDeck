import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openStore } from '../store/db';
import { createAttachmentStore } from '../store/attachments';
import { createHub } from '../hub';
import { createServices } from '../services';
import { agentdeckMcpFor, createMcpServer } from '../mcp';

// 规则（2026-09-23 与开发者确认）：Agent 经 MCP 派生会话必须由用户在调用方会话的审批卡上批准；拒绝或审批作废都不能建出会话。
test('create_session needs approval and leaves no empty session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-mcp-'));
  const store = openStore(':memory:');
  const hub = createHub(store, createAttachmentStore(store, join(dir, 'uploads')), (id) => agentdeckMcpFor('http://127.0.0.1:0/mcp', id));
  const services = createServices(store, join(dir, 'logs'));
  try {
    store.createWorkspace({ id: 'workspace', path: dir, alias: 'test', createdAt: new Date().toISOString() });
    const caller = hub.createSession('claude', dir);
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 200; i++) { if (check()) return; await setTimeout(10); }
      assert.fail('Timed out waiting for the approval card');
    };

    for (const outcome of ['deny', 'abort', 'already-aborted', 'deepseek-without-key'] as const) {
      const controller = new AbortController();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createMcpServer(hub, store, services, caller.id, controller.signal).connect(serverSide);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(clientSide);

      if (outcome === 'already-aborted') controller.abort();
      const call = client.callTool({ name: 'create_session', arguments: { provider: outcome === 'deepseek-without-key' ? 'deepseek' : 'codex', prompt: 'do something' } });
      // already-aborted / deepseek-without-key 在弹卡前就失败，不该让用户批一张注定失败的卡
      if (outcome === 'deny' || outcome === 'abort') {
        await until(() => hub.pendingRequests(caller.id).length === 1);
        assert.equal(hub.listSessions().length, 1, 'no session before approval');
        const request = hub.pendingRequests(caller.id)[0];
        if (outcome === 'abort') controller.abort();
        else hub.resolvePending(request.id, { kind: 'approval', decision: 'deny' });
      }

      const result = await call;
      assert.equal(result.isError, true);
      assert.equal(hub.listSessions().length, 1, `no session after ${outcome}`);
      assert.equal(hub.pendingRequests(caller.id).length, 0, `no pending approval after ${outcome}`);
      await client.close();
    }
  } finally {
    hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 规则：move_session 不能让隶属关系成环（挂到自己或后代下），否则侧栏展开和连子树删除会死循环。
test('move_session rejects cycles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-mcp-'));
  const store = openStore(':memory:');
  const hub = createHub(store, createAttachmentStore(store, join(dir, 'uploads')), (id) => agentdeckMcpFor('http://127.0.0.1:0/mcp', id));
  try {
    store.createWorkspace({ id: 'workspace', path: dir, alias: 'test', createdAt: new Date().toISOString() });
    const a = hub.createSession('claude', dir);
    const child = hub.createSession('claude', dir, { parentId: a.id });
    const grandchild = hub.createSession('claude', dir, { parentId: child.id });
    for (const [id, parent] of [[a.id, a.id], [a.id, child.id], [a.id, grandchild.id], [child.id, grandchild.id]]) {
      assert.throws(() => hub.moveSession(id, parent), /under itself/);
    }
    assert.deepEqual(hub.listSessions().map((s) => [s.id, s.parentId]).sort(), [[a.id, null], [child.id, a.id], [grandchild.id, child.id]].sort());

    const b = hub.createSession('claude', dir);
    hub.moveSession(grandchild.id, b.id);
    hub.moveSession(child.id, null);
    assert.equal(hub.getSession(grandchild.id).parentId, b.id);
    assert.equal(hub.getSession(child.id).parentId, null);
  } finally {
    hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
