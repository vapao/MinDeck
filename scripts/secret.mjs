#!/usr/bin/env node
// Agent 在 shell 里取密钥：node scripts/secret.mjs get NAME，值只写到 stdout，供 $(...) 替换进命令。
// 项目按当前目录判断（落在哪个 workspace 里，取最长的），本项目私有的优先，其次 Shared。不是隔离：同一系统用户直接读库也能拿到全部
import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const [command, name] = process.argv.slice(2);
if (command !== 'get' || !name) {
  console.error('Usage: secret.mjs get NAME');
  process.exit(2);
}

const db = new DatabaseSync(process.env.AGENTDECK_DB ?? resolve(import.meta.dirname, '../data/agentdeck.db'), { readOnly: true });
const cwd = process.cwd();
// process.cwd() 是解析过软链接的真实路径，项目路径也要解析后再比；目录已不存在的项目照原样比
const workspace = db.prepare('SELECT id, path FROM workspaces').all()
  .map((w) => ({ ...w, real: existsSync(w.path) ? realpathSync(w.path) : w.path }))
  .filter((w) => cwd === w.real || cwd.startsWith(`${w.real}/`))
  .sort((a, b) => b.real.length - a.real.length)[0];
const row = db.prepare(`SELECT value FROM secrets WHERE name = ? AND workspace_id IN (?, '') ORDER BY workspace_id = '' LIMIT 1`).get(name, workspace?.id ?? '');
if (!row) {
  console.error(`Secret ${name} not found for ${workspace ? workspace.path : `${cwd} (not inside an AgentDeck project, so only shared secrets apply)`}; see list_secrets`);
  process.exit(1);
}
process.stdout.write(row.value);
