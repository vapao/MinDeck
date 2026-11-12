import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const source = resolve(import.meta.dirname, '..');
const root = resolve(process.env.MINDECK_INSTALL_ROOT ?? resolve(homedir(), '.mindeck'));
const app = resolve(root, 'app');
const data = resolve(root, 'data');
const configPath = resolve(root, 'install.json');
const saved = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined;
const label = process.env.MINDECK_LABEL ?? saved?.label ?? 'com.mindeck.hub';
const port = Number(process.env.MINDECK_PORT ?? saved?.port ?? 8004);
if (!/^[a-zA-Z0-9.-]+$/.test(label) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MINDECK_LABEL or MINDECK_PORT');
if (saved && label !== saved.label) throw new Error(`Use the existing label ${saved.label}, or uninstall first`);
const target = `gui/${process.getuid()}/${label}`;
const plist = resolve(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const helper = resolve(root, 'MinDeck Finder.app');
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const loaded = () => spawnSync('/bin/launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
const url = `http://127.0.0.1:${port}`;

// Never replace an unrelated launch agent, including a source checkout's production Hub.
if (!saved && (existsSync(plist) || loaded())) throw new Error(`${label} already exists. Choose another MINDECK_LABEL and MINDECK_PORT.`);
async function stop() {
  if (!loaded()) return;
  run('/bin/launchctl', ['bootout', target]);
  for (let i = 0; i < 60 && loaded(); i++) await delay(500);
  if (loaded()) throw new Error(`Could not stop ${label}`);
}
async function requireIdle() {
  if (!loaded()) return;
  const response = await fetch(`http://127.0.0.1:${saved.port}/api/sessions`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Cannot check running sessions: HTTP ${response.status}`);
  const sessions = await response.json();
  if (sessions.some((s) => !['idle', 'error'].includes(s.status) || s.backgroundTasks)) throw new Error('Sessions are busy. Let them finish, then run this command again.');
}
if (process.argv[2] === 'uninstall') {
  if (!saved) throw new Error('No installed MinDeck found');
  await requireIdle();
  await stop();
  rmSync(plist, { force: true });
  if (existsSync(helper)) run(register, ['-u', helper]);
  for (const path of [app, helper, resolve(root, 'previous'), configPath]) rmSync(path, { recursive: true, force: true });
  console.log(`MinDeck uninstalled. Your data is kept at ${data}.`);
} else if (process.argv[2] === 'install') {
  const release = JSON.parse(readFileSync(resolve(source, 'release.json'), 'utf8'));
  if (release.arch !== process.arch) throw new Error('Release architecture does not match this Mac');
  await requireIdle();
  // Detect a port conflict before stopping or replacing any installation.
  if (!loaded() || port !== saved.port) {
    const probe = createServer();
    await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', ok); });
    await new Promise((ok, fail) => probe.close((error) => error ? fail(error) : ok()));
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staged = resolve(root, 'app-new');
  rmSync(staged, { recursive: true, force: true });
  cpSync(source, staged, { recursive: true });
  await stop();
  rmSync(resolve(root, 'previous'), { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, resolve(root, 'previous'));
  renameSync(staged, app);
  mkdirSync(resolve(data, 'logs'), { recursive: true });
  mkdirSync(dirname(plist), { recursive: true });
  const environment = {
    HOME: homedir(),
    PATH: `${app}/bin:${process.env.PATH ?? '/usr/bin:/bin'}:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin`,
    MINDECK_PORT: String(port), MINDECK_DB: resolve(data, 'mindeck.db'),
    MINDECK_UPLOADS: resolve(data, 'uploads'), MINDECK_WEB_DIST: resolve(app, 'apps/web/dist'),
    MINDECK_SEED_WORKSPACE: '0',
  };
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const string = (s) => `<string>${xml(s)}</string>`;
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${string(resolve(app, 'bin/node'))}${string(resolve(app, 'apps/server/src/main.mjs'))}</array>
<key>WorkingDirectory</key>${string(root)}
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key>${string(value)}`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key>${string(resolve(data, 'logs/hub.log'))}
<key>StandardErrorPath</key>${string(resolve(data, 'logs/hub.log'))}
</dict></plist>\n`, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ label, port, version: release.version }) + '\n', { mode: 0o600 });
  run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${url}/api/workspaces`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { healthy = true; break; }
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED' && error.name !== 'TimeoutError') throw error;
    }
    await delay(500);
  }
  if (!healthy) throw new Error(`MinDeck did not start. See ${data}/logs/hub.log; previous program kept at ${root}/previous.`);
  // Stable helper path keeps LaunchServices registration valid across app upgrades.
  rmSync(helper, { recursive: true, force: true });
  cpSync(resolve(app, 'MinDeck Finder.app'), helper, { recursive: true });
  run(register, ['-f', helper]);
  rmSync(resolve(root, 'previous'), { recursive: true, force: true });
  const claude = resolve(app, `node_modules/@anthropic-ai/claude-agent-sdk-darwin-${process.arch}/claude`);
  const auth = spawnSync(claude, ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
  if (auth.status === 0 && JSON.parse(auth.stdout).loggedIn) console.log('Claude Code is signed in.');
  else console.log('Claude Code is not signed in. Run `claude auth login`, then start a session in MinDeck.');
  console.log(`MinDeck ${release.version} is ready at ${url}\nAdd your first project on the Projects page.\nData: ${data}\nUninstall (keeps data): sh "${app}/scripts/uninstall.sh"`);
  if (process.env.MINDECK_OPEN_BROWSER !== '0') run('/usr/bin/open', [url]);
} else throw new Error('Usage: install.mjs install|uninstall');
