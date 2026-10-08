import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { CreateProjectEntryBody, DeleteProjectEntryBody, ProjectFilesResponse } from '@agentdeck/shared';
import { HubError } from './hub';

export async function listProjectFiles(cwd: string, path: string, query: string, hidden: boolean): Promise<ProjectFilesResponse> {
  const root = await realpath(cwd);
  const base = await realpath(resolve(root, path));
  if (base !== root && !base.startsWith(root + sep)) throw new HubError(400, 'Path is outside the workspace');
  const entries: ProjectFilesResponse['entries'] = [];
  const needle = query.trim().toLowerCase();
  const dirs = [needle ? '' : path];
  const deadline = Date.now() + 1500;
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const items = (await readdir(resolve(root, dir), { withFileTypes: true }))
      .filter((item) => hidden || !item.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      const rel = dir ? `${dir}/${item.name}` : item.name;
      // 不跟随目录符号链接，避免递归环及扫描到项目之外；链接本身仍可预览。
      if (needle && item.isDirectory()) dirs.push(rel);
      else if (!needle || rel.toLowerCase().includes(needle)) {
        entries.push({ path: rel, name: item.name, dir: item.isDirectory() });
        if (needle && entries.length >= 200) return { entries, truncated: true };
      }
      if (needle && Date.now() > deadline) return { entries, truncated: true };
    }
  }
  return { entries, truncated: false };
}

/** 写操作只接受 cwd 内的相对路径；父目录不沿 symlink，叶子链接由调用方决定如何处理。 */
export async function workspaceWritePath(cwd: string, rel: string) {
  if (isAbsolute(rel) || rel.includes('\0') || rel.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new HubError(400, 'Invalid path; workspace root and Git metadata are protected');
  }
  const root = await realpath(cwd);
  let abs = root;
  let info = null;
  const parts = rel.split('/');
  for (const [i, part] of parts.entries()) {
    abs = join(abs, part);
    info = await lstat(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (info && i < parts.length - 1 && !info.isDirectory()) throw new HubError(400, 'Parent directories must be real directories, not symbolic links');
  }
  return { root, abs, info };
}

export async function createProjectEntry(cwd: string, body: CreateProjectEntryBody): Promise<void> {
  const { abs } = await workspaceWritePath(cwd, body.path);
  try {
    if (body.dir) await mkdir(abs);
    else await writeFile(abs, '', { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new HubError(409, 'A file or folder with this name already exists');
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HubError(404, 'Parent folder no longer exists; refresh and try again');
    throw err;
  }
}

export async function deleteProjectEntry(cwd: string, body: DeleteProjectEntryBody): Promise<void> {
  const { abs, info } = await workspaceWritePath(cwd, body.path);
  if (!info) throw new HubError(404, 'File or folder no longer exists; refresh and try again');
  if (info.isDirectory() !== body.dir) throw new HubError(409, 'File type changed; refresh and confirm again');
  if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) throw new HubError(400, 'Only files, folders and symbolic links can be deleted');
  if (info.isDirectory()) {
    // 删除目录前检查整个子树，避免把嵌套仓库的历史或 worktree 的 .git 文件一起删除。
    const dirs = [abs];
    for (const dir of dirs) {
      const entries = await readdir(dir, { withFileTypes: true });
      if (entries.some((entry) => entry.name.toLowerCase() === '.git')) throw new HubError(409, 'This folder contains a Git repository and cannot be deleted here');
      dirs.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)));
    }
  }
  // rm 不跟随叶子及目录内的符号链接；不改暂存区，Git 仍能显示已跟踪文件的删除。
  await rm(abs, { recursive: body.dir });
}
