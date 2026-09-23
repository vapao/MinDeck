import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CreateServiceBody, Service, ServiceConfig, ServiceLogResponse } from '@agentdeck/shared';
import type { ServiceRow, Store } from './store/db';
import { HubError } from './hub';

export type Services = ReturnType<typeof createServices>;

const logTailBytes = 64 * 1024;

// ps 报的启动时间；进程不存在时 ps 退出码非 0
function startTime(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms && groupAlive(pgid); t += 100) await new Promise((r) => setTimeout(r, 100));
  return !groupAlive(pgid);
}

// 项目开发服务（切片 14）。进程与 Hub 解耦：detached 自成进程组、输出直写日志文件，
// Hub 重启 / 升级不影响正在测的服务，重启后按库里的 pid 接管。代价是接管后拿不到退出码，只区分运行 / 停止。
export function createServices(store: Store, logsDir: string) {
  mkdirSync(logsDir, { recursive: true });
  const logPath = (id: string) => join(logsDir, `${id}.log`);

  const get = (id: string) => {
    const row = store.getService(id);
    if (!row) throw new HubError(404, 'Service not found');
    return row;
  };

  const cwdOf = (workspaceId: string, subdir: string) => {
    const w = store.getWorkspace(workspaceId);
    if (!w) throw new HubError(404, 'Workspace not found');
    const cwd = resolve(w.path, subdir);
    if (cwd !== w.path && !cwd.startsWith(`${w.path}/`)) throw new HubError(400, 'Directory must be inside the project');
    return cwd;
  };

  // 组长已退出但组里还有进程（pnpm 退了、vite 还在）也算运行：进程组存在期间 pgid 不会被复用。
  // 组长还在时核对启动时间，防止 pid 已被无关进程复用。
  const running = (row: ServiceRow): boolean => {
    if (row.pid === null) return false;
    const leaderStart = startTime(row.pid);
    const alive = groupAlive(row.pid) && (leaderStart === null || leaderStart === row.startedAt);
    if (!alive) store.setServiceProcess(row.id, null, null);
    return alive;
  };

  const toService = (row: ServiceRow): Service => {
    const { pid: _pid, startedAt: _s, ...rest } = row;
    return { ...rest, running: running(row) };
  };

  const start = async (id: string) => {
    const row = get(id);
    if (running(row)) throw new HubError(409, 'Service is already running');
    const cwd = cwdOf(row.workspaceId, row.subdir);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HubError(400, `Directory not found: ${cwd}`);
    // 先删再建：新 inode 让日志游标识别出这是新一次运行
    rmSync(logPath(id), { force: true });
    const log = openSync(logPath(id), 'w');
    // 登录 shell 才有 nvm / pnpm 等 PATH；launchd 不读 ~/.zshrc
    const child = spawn('/bin/zsh', ['-lc', row.command], { cwd, detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    if (child.pid === undefined) throw await new Promise<Error>((r) => child.once('error', r));
    child.unref();
    store.setServiceProcess(id, child.pid, startTime(child.pid));
  };

  const stop = async (id: string) => {
    const row = get(id);
    if (!running(row)) return;
    const pgid = row.pid!;
    signalGroup(pgid, 'SIGTERM');
    if (!(await waitGone(pgid, 5000))) {
      signalGroup(pgid, 'SIGKILL');
      await waitGone(pgid, 1000);
    }
    store.setServiceProcess(id, null, null);
  };

  return {
    list: (): Service[] => store.listServices().map(toService),
    anyRunning: (workspaceId: string) => store.listServices().some((s) => s.workspaceId === workspaceId && running(s)),
    create(body: CreateServiceBody): Service {
      cwdOf(body.workspaceId, body.subdir);
      const row: ServiceRow = { id: randomUUID(), workspaceId: body.workspaceId, name: body.name.trim(), command: body.command, subdir: body.subdir.trim(), url: body.url.trim(), pid: null, startedAt: null, createdAt: new Date().toISOString() };
      store.createService(row);
      return toService(row);
    },
    update(id: string, c: ServiceConfig): Service {
      cwdOf(get(id).workspaceId, c.subdir);
      store.updateService(id, { name: c.name.trim(), command: c.command, subdir: c.subdir.trim(), url: c.url.trim() });
      return toService(get(id));
    },
    remove(id: string) {
      if (running(get(id))) throw new HubError(409, 'Stop the service before deleting it');
      store.deleteService(id);
      rmSync(logPath(id), { force: true });
    },
    start,
    stop,
    async restart(id: string) {
      await stop(id);
      await start(id);
    },
    /** cursor = "inode:字节偏移"；换了文件（重新启动）或没有游标时从末尾 64KB 读，reset 告诉客户端先清空 */
    log(id: string, cursor?: string): ServiceLogResponse {
      get(id);
      const path = logPath(id);
      if (!existsSync(path)) return { text: '', cursor: '', reset: true };
      const { ino, size } = statSync(path);
      const [curIno, curBytes] = (cursor ?? '').split(':').map(Number);
      const reset = curIno !== ino || curBytes! > size;
      const from = reset ? Math.max(0, size - logTailBytes) : curBytes!;
      const buf = Buffer.alloc(size - from);
      const fd = openSync(path, 'r');
      readSync(fd, buf, 0, buf.length, from);
      closeSync(fd);
      return { text: buf.toString('utf8'), cursor: `${ino}:${size}`, reset };
    },
  };
}
