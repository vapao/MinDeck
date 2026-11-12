import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const log = resolve(root, 'data/logs/update-when-idle.log');
const dataDir = dirname(process.env.MINDECK_DB ?? resolve(root, 'data/mindeck.db'));
const statusPath = resolve(dataDir, 'update-status.json');
const lockPath = resolve(dataDir, 'update-when-idle.pid');

if (process.argv[2] !== '--worker') {
  mkdirSync(resolve(root, 'data/logs'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(log, 'a');
  // 脱离调用方进程组，Agent 本轮结束后仍能继续等空闲并重启 Hub。
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    cwd: root, detached: true, stdio: ['ignore', fd, fd, 'ipc'],
  });
  closeSync(fd);
  child.on('error', (error) => { throw error; });
  // 等待进程写好初始状态再返回，避免把重复安排或启动失败报成成功。
  child.once('message', ({ message, ok }) => {
    console.log(`${message}；日志：${log}`);
    if (!ok) process.exitCode = 1;
    child.disconnect();
    child.unref();
  });
  child.once('exit', (code) => { if (code) process.exitCode = code; });
} else {
  // 上次被强制结束或机器重启留下的锁可以清理；活进程持有的锁不能覆盖。
  try {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw error;
        rmSync(lockPath);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let lock;
  try { lock = openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    process.send?.({ ok: false, message: '已有空闲后更新任务，本次未重复安排' });
    process.exit(1);
  }
  writeFileSync(lock, String(process.pid));
  closeSync(lock);
  process.once('exit', () => rmSync(lockPath, { force: true }));

  const deadline = Date.now() + 10 * 60 * 1000;
  const baseUrl = `http://127.0.0.1:${process.env.MINDECK_PORT ?? 8004}`;
  const status = { id: randomUUID(), pid: process.pid, requestedAt: new Date().toISOString() };
  const report = (message) => console.log(`[${new Date().toISOString()} PID ${process.pid}] ${message}`);
  let phase = 'waiting';
  const save = (nextPhase, error) => {
    phase = nextPhase;
    // 原子替换，避免 Hub 读到只写了一半的 JSON。
    writeFileSync(`${statusPath}.tmp`, JSON.stringify({ ...status, phase, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) }));
    renameSync(`${statusPath}.tmp`, statusPath);
  };
  process.once('SIGTERM', () => {
    save('failed', 'Update cancelled');
    process.exit(143);
  });
  const readHub = async (path, until = Date.now() + 60_000) => {
    while (true) {
      try {
        const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(Math.max(1, Math.min(3000, until - Date.now()))) });
        // 首次部署时旧 Hub 尚无状态接口；重启后的就绪检查仍须拿到有效实例 ID。
        if (path === '/api/update-status' && response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        const reason = error.cause?.code ?? error.name;
        const reconnectable = ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(reason) || error.name === 'TimeoutError';
        if (!reconnectable || Date.now() >= until) {
          throw new Error(`Reading ${path} failed: ${error.cause?.code ?? error.message}`, { cause: error });
        }
        report(`Hub 暂时不可访问（${path}: ${reason}），等待重连`);
        await setTimeout(1000);
      }
    }
  };
  const waitUntilIdle = async () => {
    while (Date.now() < deadline) {
      const sessions = await readHub('/api/sessions', Math.min(deadline, Date.now() + 60_000));
      // 后台任务跑在 Provider 子进程里，重启会把它连同之后的自动唤醒一起杀掉
      if (sessions.every((session) => (session.status === 'idle' || session.status === 'error') && !session.backgroundTasks)) return;
      await setTimeout(2000);
    }
    throw new Error('Timed out waiting for idle sessions (10 minutes); Hub was not restarted');
  };
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${signal ?? code}`)));
  });

  try {
    save('waiting');
    process.send?.({ ok: true, message: `已安排空闲后更新，PID ${process.pid}；取消等待：kill ${process.pid}` });
    report('等待所有会话空闲；running / waiting_user 及后台任务均阻止更新');
    await waitUntilIdle();
    save('building');
    report('开始构建前端');
    await run('pnpm', ['build']);
    const previousInstance = (await readHub('/api/update-status'))?.instanceId ?? null;
    // 构建期间可能开始了新一轮；不能沿用构建前的空闲判断。
    save('waiting');
    await waitUntilIdle();
    save('restarting');
    report('会话空闲，重启 Hub');
    await run('/bin/zsh', [resolve(root, 'scripts/launchd.sh'), 'restart']);
    const readyDeadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const current = await readHub('/api/update-status', readyDeadline);
      if (typeof current?.instanceId === 'string' && current.instanceId !== previousInstance) {
        ready = true;
        break;
      }
      await setTimeout(1000);
    }
    if (!ready) throw new Error('Hub did not become ready within 60 seconds after restart');
    save('completed');
    report('更新完成，新 Hub 已就绪');
  } catch (error) {
    save('failed', `${phase}: ${error.message}`);
    report(inspect(error, { depth: 5 }));
    process.exitCode = 1;
  }
}
