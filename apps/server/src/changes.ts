import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, DiffResponse, FileResponse, ListChangesResponse } from '@agentdeck/shared';
import { HubError } from './hub';

// 改动侧栏（切片 10）：只读地看工作区里改了什么。全是 git 只读命令 + 读文件，Hub 不写任何东西。
// 大仓库 git status 慢就慢，超时返回错误，不影响会话主流程。

const run = promisify(execFile);
const gitTimeoutMs = 10_000;
const maxFileBytes = 512 * 1024;

async function git(cwd: string, args: string[], okExitCodes: number[] = [0]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: gitTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    if (typeof e.code === 'number' && okExitCodes.includes(e.code)) return e.stdout ?? '';
    if (e.killed) throw new HubError(504, 'git 超时');
    throw new HubError(500, `git 失败：${(e.stderr ?? '').trim() || String(e.code)}`);
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: gitTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** 客户端给的相对路径必须落在 cwd 内（含 symlink 解析后） */
async function insideCwd(cwd: string, rel: string): Promise<string> {
  const abs = resolve(cwd, rel);
  const root = await realpath(cwd);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    // 文件不存在（已删除的文件看 diff 时）：按字面路径判断
    real = abs;
  }
  if (real !== root && !real.startsWith(root + sep) && abs !== root && !abs.startsWith(root + sep)) throw new HubError(400, '路径不在工作区内');
  return abs;
}

export async function listChanges(cwd: string): Promise<ListChangesResponse> {
  if (!(await isGitRepo(cwd))) return { git: false, files: [] };
  // -z：路径不转义、NUL 分隔；重命名会跟一个额外的原路径条目
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const x = p[0];
    const y = p[1];
    const path = p.slice(3);
    if (x === 'R' || x === 'C') i++; // 跳过原路径
    // 合并 index / worktree 两列成一个字母：未跟踪 ?、删除 D、新增 A、其余按修改 M
    const status: ChangedFile['status'] = x === '?' ? '?' : x === 'D' || y === 'D' ? 'D' : x === 'A' ? 'A' : x === 'R' ? 'R' : 'M';
    files.push({ path, status });
  }
  return { git: true, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function fileDiff(cwd: string, rel: string): Promise<DiffResponse> {
  // 用相对 cwd 的规范路径调 git，diff 头里才是 a/<相对路径>
  const path = relative(cwd, await insideCwd(cwd, rel));
  // 未跟踪文件 git diff HEAD 看不到：和 /dev/null 比；--no-index 有差异时退出码 1
  const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', path], [0, 1])) !== '';
  const diff = tracked
    ? await git(cwd, ['diff', 'HEAD', '--', path])
    : await git(cwd, ['diff', '--no-index', '--', '/dev/null', path], [0, 1]);
  return { path: rel, diff, binary: /^Binary files /m.test(diff) };
}

export async function readWorkspaceFile(cwd: string, rel: string): Promise<FileResponse> {
  const abs = await insideCwd(cwd, rel);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    throw new HubError(404, '文件不存在');
  }
  const head = buf.subarray(0, Math.min(buf.length, 8000));
  if (head.includes(0)) return { path: rel, content: null, truncated: false, binary: true };
  const truncated = buf.length > maxFileBytes;
  return { path: rel, content: buf.subarray(0, maxFileBytes).toString('utf8'), truncated, binary: false };
}
