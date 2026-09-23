import { readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ProjectFilesResponse } from '@agentdeck/shared';
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
