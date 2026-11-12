import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store/db';
import { createServices } from '../services';

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

// 规则：停止服务必须杀掉整个进程组（pnpm → vite / tsx 这类子进程），否则孤儿进程静默占着端口；
// Hub 重启（新的 createServices）后仍能认出还在跑的服务，而不是当成已停止再起一份。
test('stop kills the whole process group, and a restarted hub still sees it running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindeck-services-'));
  try {
    const store = openStore(':memory:');
    store.createWorkspace({ id: 'w', path: dir, alias: 'w', createdAt: new Date().toISOString() });
    const services = createServices(store, join(dir, 'logs'));
    // 后台子进程 + 前台子进程，组长 zsh 之外至少还有两个成员
    const { id } = services.create({ workspaceId: 'w', name: 'svc', command: 'sleep 30 & sleep 30; wait', subdir: '', url: '' });
    await services.start(id);
    const pgid = store.getService(id)!.pid!;

    assert.equal(createServices(store, join(dir, 'logs')).list()[0]!.running, true);

    await services.stop(id);
    assert.equal(groupAlive(pgid), false);
    assert.equal(services.list()[0]!.running, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
