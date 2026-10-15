import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, DiffResponse, DiscardChangeBody, EntriesResponse, FileResponse, ListChangesResponse } from '@agentdeck/shared';
import { HubError } from './hub';
import { workspaceWritePath } from './files';

// 改动侧栏（切片 10）：查看工作区差异；单文件丢弃同时还原 index 和 worktree。
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

export async function listChanges(cwd: string, busyReason: (root: string) => string | undefined = () => undefined): Promise<ListChangesResponse> {
  cwd = await realpath(cwd);
  const repos = (await isGitRepo(cwd)) ? [''] : await findNestedRepos(cwd);
  if (repos.length === 0) return { git: false, files: [] };
  const files = (await Promise.all(repos.map((rel) => repoChanges(join(cwd, rel), rel ? `${rel}/` : '', busyReason)))).flat();
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

async function repoChanges(root: string, prefix: string, busyReason: (root: string) => string | undefined): Promise<ChangedFile[]> {
  const base = await baseRef(root);
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  // -z：路径不转义、NUL 分隔；重命名会跟一个额外的原路径条目
  const [out, numstat, tree, index] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    git(root, ['diff', base, '--numstat', '-z', '--relative', '--', '.']),
    git(root, ['ls-tree', '-r', '-z', base]),
    git(root, ['ls-files', '--stage', '-z']),
  ]);
  const headPaths = new Set(tree.split('\0').filter(Boolean).map((entry) => entry.slice(entry.indexOf('\t') + 1)));
  const submodules = new Set((tree + index).split('\0').filter((entry) => entry.startsWith('160000 ')).map((entry) => entry.slice(entry.indexOf('\t') + 1)));
  const stats = parseNumstat(numstat);
  const busy = busyReason(top);
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const x = p[0];
    const y = p[1];
    const path = relative(root, join(top, p.slice(3))) + (p.endsWith('/') ? '/' : '');
    if (x === 'R' || x === 'C') i++; // 跳过原路径
    // Git 把未跟踪的嵌套仓库报成 `目录/`，改为展示该仓库自己的文件改动。
    if (path.endsWith('/')) {
      if (await exists(join(root, path, '.git'))) files.push(...await repoChanges(join(root, path), prefix + path, busyReason));
      continue;
    }
    // 合并 index / worktree 两列成一个字母：未跟踪 ?、删除 D、新增 A、其余按修改 M
    const status: ChangedFile['status'] = x === '?' ? '?' : x === 'D' || y === 'D' ? 'D' : x === 'A' ? 'A' : x === 'R' ? 'R' : 'M';
    const unsupported = x === 'R' || x === 'C' ? 'Renames and copies cannot be discarded here'
      : ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(x + y) ? 'Resolve merge conflicts with Git'
      : submodules.has(path) ? 'Submodules cannot be discarded here' : undefined;
    files.push({ path: prefix + path, status, ...(stats.get(path) ?? { additions: null, deletions: null }),
      base, discard: headPaths.has(path) ? 'restore' : 'delete', discardDisabled: unsupported ?? busy });
  }
  return files;
}

/** 写入路径不沿父目录 symlink，不接受目录；文件名按字面匹配，叶子 symlink 只操作链接本身。 */
async function discardPath(cwd: string, rel: string): Promise<{ root: string; abs: string }> {
  const { root, abs, info } = await workspaceWritePath(cwd, rel);
  if (info && !info.isFile() && !info.isSymbolicLink()) throw new HubError(400, 'Only individual files can be discarded');
  return { root, abs };
}

export async function discardChange(cwd: string, body: DiscardChangeBody, withIdleRepository: (root: string, write: () => Promise<void>) => Promise<void>): Promise<void> {
  const { root, abs } = await discardPath(cwd, body.path);
  // 已删除的目录可能不存在，从最近的现存父目录定位实际仓库。
  let parent = dirname(abs);
  while (!(await exists(parent))) parent = dirname(parent);
  const repo = (await git(parent, ['rev-parse', '--show-toplevel'])).trim();
  const path = relative(repo, abs);
  await withIdleRepository(repo, async () => {
    const change = (await listChanges(root)).files.find((file) => file.path === body.path);
    if (!change) throw new HubError(409, 'File is no longer in Changes; refresh and try again');
    if (change.discardDisabled) throw new HubError(409, change.discardDisabled);
    if (change.base !== body.base || change.discard !== body.discard) throw new HubError(409, 'Git state changed; refresh and confirm again');
    await discardPath(cwd, body.path);
    if (body.discard === 'restore') {
      await git(repo, ['--literal-pathspecs', 'restore', `--source=${body.base}`, '--staged', '--worktree', '--', path]);
    } else {
      const tracked = await git(repo, ['--literal-pathspecs', 'ls-files', '-z', '--', path]);
      if (tracked) await git(repo, ['--literal-pathspecs', 'rm', '-f', '--', path]);
      else await unlink(abs);
    }
  });
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
  let root = dirname(abs);
  while (root !== cwd && !(await exists(join(root, '.git')))) root = dirname(root);
  const path = relative(root, abs);
  // 前端用两份全文做 unified 合并视图；base 中没有（未跟踪、新加入暂存区）时原文为空，已删除时现文为空
  const base = await baseRef(root);
  const inBase = (await git(root, ['ls-tree', '--name-only', base, '--', path])) !== '';
  const original = inBase ? (await run('git', ['cat-file', 'blob', `${base}:${path}`], { cwd: root, timeout: gitTimeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })).stdout : Buffer.alloc(0);
  const current = (await exists(abs)) ? await readFile(abs) : Buffer.alloc(0);
  const binary = original.subarray(0, 8000).includes(0) || current.subarray(0, 8000).includes(0);
  const tooLarge = original.length > maxFileBytes || current.length > maxFileBytes;
  if (binary || tooLarge) return { path: rel, original: '', current: '', binary, tooLarge };
  return { path: rel, original: original.toString('utf8'), current: current.toString('utf8'), binary, tooLarge };
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
