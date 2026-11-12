// macOS integration check: install/upgrade/uninstall must preserve user data.
// Run after build: node scripts/test-installer.mjs dist/mindeck-darwin-arm64.tar.gz
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const archive = resolve(process.argv[2]);
const script = resolve(import.meta.dirname, 'install.sh');
const home = mkdtempSync(resolve(tmpdir(), 'mindeck test '));
const root = resolve(home, '.mindeck');
const label = `com.mindeck.test.${process.pid}`;
const probe = createServer();
await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
const port = probe.address().port;
await new Promise((ok) => probe.close(ok));
const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MINDECK_PORT: String(port), MINDECK_LABEL: label, MINDECK_ARCHIVE: archive, MINDECK_OPEN_BROWSER: '0' };
delete env.MINDECK_INSTALL_ROOT;
const run = (args) => {
  const result = spawnSync('/bin/sh', args, { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
async function crashHub() {
  writeFileSync(resolve(root, 'app/apps/server/src/main.mjs'), 'process.exit(1);');
  assert.equal(spawnSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]).status, 0);
  for (let i = 0; i < 20; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/sessions`); }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED') return; throw error; }
    await delay(250);
  }
  throw new Error('Test Hub did not stop listening');
}
try {
  const entries = spawnSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(entries.status, 0);
  assert.doesNotMatch(entries.stdout, /node_modules\/@anthropic-ai\/claude-agent-sdk-darwin|node_modules\/@openai\/codex-darwin/);
  run(['-c', '! command -v node && ! command -v pnpm']);
  const foreignPlist = resolve(home, 'Library/LaunchAgents', `${label}.plist`);
  mkdirSync(resolve(home, 'Library/LaunchAgents'), { recursive: true });
  writeFileSync(foreignPlist, 'unrelated launch agent');
  const conflict = spawnSync('/bin/sh', [script], { env, encoding: 'utf8' });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /already exists/);
  assert.equal(readFileSync(foreignPlist, 'utf8'), 'unrelated launch agent');
  rmSync(foreignPlist);
  run([script]);
  assert.deepEqual(await api('/api/workspaces'), []);
  const serviceLog = resolve(root, 'data/logs/services/preserved.log');
  mkdirSync(resolve(root, 'data/logs/services'), { recursive: true });
  writeFileSync(serviceLog, 'preserve service output');
  const project = resolve(home, 'project');
  mkdirSync(project);
  const workspace = await api('/api/workspaces', { path: project, alias: 'Persisted project' });
  const session = await api('/api/sessions', { provider: 'claude', cwd: project, permissionMode: 'approval' });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new Blob([image], { type: 'image/png' }), 'pixel.png');
  const uploaded = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/attachments`, { method: 'POST', body: form });
  assert.equal(uploaded.status, 201);
  const attachment = await uploaded.json();
  const instance = (await api('/api/update-status')).instanceId;
  // A mismatched lockfile digest must fail before stopping the installed Hub.
  const badSource = resolve(home, 'bad-release');
  mkdirSync(resolve(badSource, 'scripts'), { recursive: true });
  writeFileSync(resolve(badSource, 'scripts/install.mjs'), readFileSync(resolve(root, 'app/scripts/install.mjs')));
  const release = JSON.parse(readFileSync(resolve(root, 'app/release.json')));
  release.agentPackages[0].integrity = 'sha512-invalid';
  writeFileSync(resolve(badSource, 'release.json'), JSON.stringify(release));
  const rejected = spawnSync(resolve(root, 'app/bin/node'), [resolve(badSource, 'scripts/install.mjs'), 'install'], { env, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Lockfile integrity mismatch/);
  assert.equal((await api('/api/update-status')).instanceId, instance);
  await crashHub();
  const upgrade = run([script]);
  assert.equal((upgrade.match(/Reusing /g) ?? []).length, 2);
  assert.doesNotMatch(upgrade, /Downloading .* from npm/);
  assert.notEqual((await api('/api/update-status')).instanceId, instance);
  assert.deepEqual(await api('/api/workspaces'), [workspace]);
  assert.equal(readFileSync(serviceLog, 'utf8'), 'preserve service output');
  assert.equal((await api('/api/sessions'))[0].id, session.id);
  assert.deepEqual(Buffer.from(await (await fetch(`http://127.0.0.1:${port}/api/attachments/${attachment.id}`)).arrayBuffer()), image);
  await crashHub();
  run([resolve(root, 'app/scripts/uninstall.sh')]);
  assert.equal(existsSync(resolve(root, 'app')), false);
  assert.equal(readFileSync(serviceLog, 'utf8'), 'preserve service output');
  assert.equal(existsSync(resolve(home, 'Library/LaunchAgents', `${label}.plist`)), false);
  const db = new DatabaseSync(resolve(root, 'data/mindeck.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT id FROM sessions').get().id, session.id);
  db.close();
  assert.deepEqual(readFileSync(resolve(root, `data/uploads/${session.id}/${attachment.id}.png`)), image);
  assert.notEqual(spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }).status, 0);
  console.log('PASS: no bundled agent binaries, lockfile integrity rejection, native package reuse, no-Node install, crash-loop upgrade/uninstall, launchd ownership guard and data persistence.');
} finally {
  // Clean only this run's label and temporary directory, even if an assertion fails.
  spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
  const helper = resolve(root, 'MinDeck Finder.app');
  if (existsSync(helper)) spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', helper], { stdio: 'ignore' });
  rmSync(home, { recursive: true, force: true });
}
