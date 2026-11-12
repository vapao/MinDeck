import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(root, 'scripts/release-config.json')));
const version = process.argv[2];
if (!/^v[\w.-]+$/.test(version ?? '')) throw new Error('Usage: node scripts/build-release.mjs v0.1.0');
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Build on an arm64 or x64 Mac');
const repository = process.env.MINDECK_REPOSITORY ?? config.repository;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
const out = resolve(root, 'dist');
const stage = resolve(out, `mindeck-darwin-${process.arch}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
run('pnpm', ['build']);
// Keep the source layout for import.meta-relative resources (including secret.mjs).
await build({
  entryPoints: [resolve(root, 'apps/server/src/main.ts')],
  outfile: resolve(stage, 'apps/server/src/main.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  banner: { js: 'import { createRequire as bundleRequire } from "node:module"; import { fileURLToPath as bundleFilePath } from "node:url"; import { dirname as bundleDirname } from "node:path"; const require = bundleRequire(import.meta.url); const __filename = bundleFilePath(import.meta.url); const __dirname = bundleDirname(__filename);' },
});
cpSync(resolve(root, 'apps/web/dist'), resolve(stage, 'apps/web/dist'), { recursive: true });
const require = createRequire(resolve(root, 'apps/server/package.json'));
const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
const nativeName = `@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`;
const native = dirname(sdkRequire.resolve(`${nativeName}/package.json`));
cpSync(native, resolve(stage, 'node_modules', nativeName), { recursive: true });
mkdirSync(resolve(stage, 'scripts'), { recursive: true });
for (const name of ['secret.mjs', 'install.mjs', 'uninstall.sh']) cpSync(resolve(root, 'scripts', name), resolve(stage, 'scripts', name));

const nodeArchive = `node-v${config.nodeVersion}-darwin-${process.arch}.tar.gz`;
const cache = resolve(out, 'node-cache');
mkdirSync(cache, { recursive: true });
run('curl', ['-fL', '--retry', '3', `https://nodejs.org/dist/v${config.nodeVersion}/${nodeArchive}`, '-o', resolve(cache, nodeArchive)]);
run('curl', ['-fsSL', `https://nodejs.org/dist/v${config.nodeVersion}/SHASUMS256.txt`, '-o', resolve(cache, 'SHASUMS256.txt')]);
const expected = readFileSync(resolve(cache, 'SHASUMS256.txt'), 'utf8').split('\n').find((line) => line.endsWith(`  ${nodeArchive}`))?.split(' ')[0];
const actual = createHash('sha256').update(readFileSync(resolve(cache, nodeArchive))).digest('hex');
if (actual !== expected) throw new Error('Node archive checksum mismatch');
run('tar', ['-xzf', resolve(cache, nodeArchive), '-C', cache]);
mkdirSync(resolve(stage, 'bin'), { recursive: true });
cpSync(resolve(cache, `node-v${config.nodeVersion}-darwin-${process.arch}/bin/node`), resolve(stage, 'bin/node'));
mkdirSync(resolve(stage, 'licenses'), { recursive: true });
cpSync(resolve(cache, `node-v${config.nodeVersion}-darwin-${process.arch}/LICENSE`), resolve(stage, 'licenses/Node.txt'));
cpSync(resolve(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'README.md'), resolve(stage, 'licenses/Claude-Agent-SDK.md'));
run('bash', ['scripts/install-finder-helper.sh', '--build', resolve(stage, 'MinDeck Finder.app')]);
writeFileSync(resolve(stage, 'release.json'), JSON.stringify({ version, repository, nodeVersion: config.nodeVersion, arch: process.arch }) + '\n');
const archive = `${stage}.tar.gz`;
run('tar', ['-czf', archive, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archive.split('/').pop()}\n`);
const installer = readFileSync(resolve(root, 'scripts/install.sh'), 'utf8').replaceAll('@REPOSITORY@', repository).replaceAll('@VERSION@', version);
writeFileSync(resolve(out, 'install.sh'), installer, { mode: 0o755 });
console.log(`Release ready: ${archive}`);
