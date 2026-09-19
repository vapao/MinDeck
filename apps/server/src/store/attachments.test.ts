import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
      store.createSession({ id, provider: 'claude', cwd: '/tmp', providerSessionId: null, status: 'idle', title: null, createdAt: now, updatedAt: now });
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
