import { build } from 'esbuild';
import { parse } from 'yaml';
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
const lock = parse(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'));
const sdk = JSON.parse(readFileSync(resolve(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json')));
const codexRoot = dirname(require.resolve('@openai/codex/package.json'));
const codex = JSON.parse(readFileSync(resolve(codexRoot, 'package.json')));
// Ship only the JS launcher. The installer gets native packages directly from npm.
cpSync(codexRoot, resolve(stage, 'node_modules/@openai/codex'), { recursive: true });
const agentPackages = [sdk, codex].map((pkg) => {
  const locked = lock.importers['apps/server'].dependencies[pkg.name].version.split('(')[0];
  if (locked !== pkg.version) throw new Error(`${pkg.name} is not the lockfile version`);
  const name = `${pkg.name}-darwin-${process.arch}`;
  const dependency = pkg.optionalDependencies[name];
  const spec = dependency.startsWith('npm:') ? dependency.slice(4) : `${name}@${dependency}`;
  const at = spec.lastIndexOf('@');
  const registryName = spec.slice(0, at);
  const version = spec.slice(at + 1);
  const integrity = lock.packages[spec]?.resolution.integrity;
  if (!integrity?.startsWith('sha512-')) throw new Error(`Missing lockfile SHA-512 for ${spec}`);
  return { name, version, integrity, url: `https://registry.npmjs.org/${registryName}/-/${registryName.split('/').pop()}-${version}.tgz` };
});
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
const helperArchive = resolve(out, `mindeck-helper-darwin-${process.arch}.tar.gz`);
run('tar', ['-czf', helperArchive, '-C', stage, 'MinDeck Finder.app'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
writeFileSync(`${helperArchive}.sha256`, `${createHash('sha256').update(readFileSync(helperArchive)).digest('hex')}  ${helperArchive.split('/').pop()}\n`);
writeFileSync(resolve(stage, 'release.json'), JSON.stringify({ version, repository, nodeVersion: config.nodeVersion, arch: process.arch, agentPackages }) + '\n');
const archive = `${stage}.tar.gz`;
run('tar', ['-czf', archive, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archive.split('/').pop()}\n`);
for (const name of ['install.sh', 'install-helper.sh']) {
  const installer = readFileSync(resolve(root, 'scripts', name), 'utf8').replaceAll('@REPOSITORY@', repository).replaceAll('@VERSION@', version);
  writeFileSync(resolve(out, name), installer, { mode: 0o755 });
}
console.log(`Release ready: ${archive}`);
