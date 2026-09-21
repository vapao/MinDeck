import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, DiffResponse, EntriesResponse, FileResponse, ListChangesResponse } from '@agentdeck/shared';
import { HubError } from './hub';

// 改动侧栏（切片 10）：只读地看工作区里改了什么。全是 git 只读命令 + 读文件，Hub 不写任何东西。
// 大仓库 git status 慢就慢，超时返回错误，不影响会话主流程。
// cwd 本身不是仓库时（一个项目拆成前后端 / App 多个仓库，共用一个根目录），往下找两级子目录里的仓库合并展示，
// 路径统一相对 cwd；不无限递归。

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
    if (e.killed) throw new HubError(504, 'git timed out');
    throw new HubError(500, `git failed: ${(e.stderr ?? '').trim() || String(e.code)}`);
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
  if (real !== root && !real.startsWith(root + sep) && abs !== root && !abs.startsWith(root + sep)) throw new HubError(400, 'Path is outside the workspace');
  return abs;
}

export async function listChanges(cwd: string): Promise<ListChangesResponse> {
  const repos = (await isGitRepo(cwd)) ? [''] : await findNestedRepos(cwd);
  if (repos.length === 0) return { git: false, files: [] };
  const files = (await Promise.all(repos.map((rel) => repoChanges(join(cwd, rel), rel ? `${rel}/` : '')))).flat();
  return { git: true, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** cwd 的子目录和孙目录里含 `.git` 的（目录或 worktree 的 .git 文件都算），返回相对 cwd 的路径 */
async function findNestedRepos(cwd: string): Promise<string[]> {
  const found: string[] = [];
  async function scan(rel: string, depth: number): Promise<void> {
    let items: Dirent[];
    try {
      items = await readdir(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      if (!d.isDirectory() || d.name.startsWith('.') || skipDirs.has(d.name)) continue;
      const sub = rel ? `${rel}/${d.name}` : d.name;
      if (await exists(join(cwd, sub, '.git'))) found.push(sub);
      else if (depth < 2) await scan(sub, depth + 1);
    }
  }
  await scan('', 1);
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** diff 的基准：HEAD；仓库还没有任何提交时用 git 的空树对象，否则 `git diff HEAD` 报 unknown revision */
async function baseRef(root: string): Promise<string> {
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], [0, 1]);
  return head.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

async function repoChanges(root: string, prefix: string): Promise<ChangedFile[]> {
  const base = await baseRef(root);
  // -z：路径不转义、NUL 分隔；重命名会跟一个额外的原路径条目
  const [out, numstat] = await Promise.all([git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), git(root, ['diff', base, '--numstat', '-z'])]);
  const stats = parseNumstat(numstat);
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
    files.push({ path: prefix + path, status, ...(stats.get(path) ?? { additions: null, deletions: null }) });
  }
  return files;
}

// `git diff --numstat -z`：每条 `加\t减\t路径\0`；重命名时路径列为空，后面跟 `旧\0新\0`；二进制两列是 `-`
function parseNumstat(out: string): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const [add, del, path] = parts[i].split('\t');
    if (add === undefined || del === undefined) continue;
    const target = path || parts[(i += 2)];
    if (!target) continue;
    stats.set(target, add === '-' ? { additions: null, deletions: null } : { additions: Number(add), deletions: Number(del) });
  }
  return stats;
}

export async function fileDiff(cwd: string, rel: string): Promise<DiffResponse> {
  const abs = await insideCwd(cwd, rel);
  // 从文件所在目录往上找最近的仓库根（不出 cwd）；cwd 自身是仓库时就是 cwd。
  // 用相对仓库根的规范路径调 git，diff 头里才是 a/<相对路径>
  let root = dirname(abs);
  while (root !== cwd && !(await exists(join(root, '.git')))) root = dirname(root);
  const path = relative(root, abs);
  // 未跟踪文件 git diff HEAD 看不到：和 /dev/null 比；--no-index 有差异时退出码 1
  const tracked = (await git(root, ['ls-files', '--error-unmatch', '--', path], [0, 1])) !== '';
  const diff = tracked
    ? await git(root, ['diff', await baseRef(root), '--', path])
    : await git(root, ['diff', '--no-index', '--', '/dev/null', path], [0, 1]);
  return { path: rel, diff, binary: /^Binary files /m.test(diff) };
}

export async function readWorkspaceFile(cwd: string, rel: string): Promise<FileResponse> {
  const abs = await insideCwd(cwd, rel);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    throw new HubError(404, 'File not found');
  }
  const head = buf.subarray(0, Math.min(buf.length, 8000));
  if (head.includes(0)) return { path: rel, content: null, truncated: false, binary: true };
  const truncated = buf.length > maxFileBytes;
  return { path: rel, content: buf.subarray(0, maxFileBytes).toString('utf8'), truncated, binary: false };
}

// ---- @ 文件引用补全（切片 11）----
// q 是用户在 @ 后面敲的内容：`src/comp` → 列 src/ 下名字含 comp 的条目；`~/Doc` → 家目录下。
// 直接子项排最前；name 非空时再往下搜几层，深层匹配排后面。目录 path 以 / 结尾，前端选中后可以继续往里敲。
// 只在 cwd 内递归：家目录下有 Library / iCloud 这类无底洞，`~` 路径只列直接子项。

const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__']);
const maxEntries = 50;
const maxDepth = 4;
const maxScanned = 3000;
const scanBudgetMs = 1500;

export async function listEntries(cwd: string, q: string): Promise<EntriesResponse> {
  const home = homedir();
  const tilde = q.startsWith('~');
  const root = tilde ? home : cwd;
  const rest = tilde ? q.replace(/^~\/?/, '') : q;
  const slash = rest.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : rest.slice(0, slash + 1);
  const name = rest.slice(slash + 1).toLowerCase();
  const base = resolve(root, dirPart);
  const prefix = tilde ? `~/${dirPart}` : dirPart;
  // 相对路径不能靠 .. 逃出 root
  if (base !== root && !base.startsWith(root + sep)) return { entries: [] };

  const showHidden = name.startsWith('.');
  const match = (n: string) => n.toLowerCase().includes(name) && (showHidden || !n.startsWith('.'));
  const entries: EntriesResponse['entries'] = [];
  let scanned = 0;
  const deadline = Date.now() + scanBudgetMs;

  async function readDir(dir: string, rel: string, depth: number): Promise<void> {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    scanned += items.length;
    // 直接子项：名字前缀匹配的排在包含匹配前面，目录排文件前面
    const here = items
      .filter((d) => match(d.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || Number(b.name.toLowerCase().startsWith(name)) - Number(a.name.toLowerCase().startsWith(name)) || a.name.localeCompare(b.name));
    for (const d of here) {
      if (entries.length >= maxEntries) return;
      entries.push({ path: `${prefix}${rel}${d.name}${d.isDirectory() ? '/' : ''}`, name: d.name, dir: d.isDirectory() });
    }
    if (!name || tilde || depth >= maxDepth) return;
    for (const d of items) {
      if (entries.length >= maxEntries || scanned >= maxScanned || Date.now() > deadline) return;
      if (d.isDirectory() && !d.name.startsWith('.') && !skipDirs.has(d.name)) await readDir(join(dir, d.name), `${rel}${d.name}/`, depth + 1);
    }
  }
  await readDir(base, '', 0);
  return { entries };
}
