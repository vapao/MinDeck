import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { openStore } from './db';
import { createAttachmentStore } from './attachments';

// 规则（AGENTS.md 规则 7 / 方案 §9.2）：附件路径只由服务端生成，客户端文件名不参与路径；
// 一条消息只能引用属于本 session 的附件，越界引用整体拒绝。
test('attachment path is server-generated and references are session-scoped', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-att-'));
  try {
    const store = openStore(':memory:');
    const now = new Date().toISOString();
    for (const id of ['a', 'b']) {
      store.createSession({ id, provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
    }
    const attachments = createAttachmentStore(store, root);

    const a = attachments.save('a', '../../etc/passwd.png', 'image/png', Buffer.from('png'));
    const path = attachments.pathOf(a);
    assert.ok(!relative(root, path).startsWith('..'), '路径必须在 uploads 根目录内');
    assert.ok(!path.includes('passwd'), '客户端文件名不能进入路径');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(attachments.read(a).toString(), 'png');

    assert.deepEqual(attachments.forMessage('a', [a.id]), [a]);
    assert.throws(() => attachments.forMessage('b', [a.id]));
    assert.throws(() => attachments.forMessage('a', [a.id, 'missing']));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 规则（切片 9）：删除会话后 data/ 里不留孤儿数据——四张表的行和上传目录一起消失，其他会话不受影响。
test('deleting a session leaves no rows or files behind', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-del-'));
  try {
    const store = openStore(':memory:');
    const now = new Date().toISOString();
    for (const id of ['gone', 'stays']) {
      store.createSession({ id, provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, model: null, effort: null, permissionMode: 'approval', archivedAt: null, parentId: null, createdAt: now, updatedAt: now });
      store.appendEvent(id, { type: 'message.user', payload: { text: 'hi', attachments: [] } });
      store.createPending({ id: `p-${id}`, sessionId: id, kind: 'question', toolUseId: 't', questions: [], status: 'pending', createdAt: now, resolvedAt: null });
    }
    const attachments = createAttachmentStore(store, root);
    const a = attachments.save('gone', 'x.png', 'image/png', Buffer.from('png'));
    const b = attachments.save('stays', 'y.png', 'image/png', Buffer.from('png'));

    store.deleteSession('gone');
    attachments.removeAll('gone');

    assert.equal(store.getSession('gone'), undefined);
    assert.equal(store.lastSeq('gone'), 0);
    assert.equal(store.getPending('p-gone'), undefined);
    assert.equal(store.getAttachment(a.id), undefined);
    assert.ok(!existsSync(join(root, 'gone')), '上传目录必须删掉');

    assert.ok(store.getSession('stays'));
    assert.equal(store.lastSeq('stays'), 1);
    assert.ok(store.getPending('p-stays'));
    assert.equal(attachments.read(b).toString(), 'png');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
