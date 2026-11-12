import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardChange, listChanges } from '../changes';
import { createHub } from '../hub';
import { createPush } from '../push';
import { openStore } from '../store/db';
import { createAttachmentStore } from '../store/attachments';
import { mindeckMcpFor } from '../mcp';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const unlocked = async (_root: string, write: () => Promise<void>) => write();
async function repository(t: TestContext, commit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mindeck-discard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  if (commit) {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/file.txt'), 'original\n');
    await writeFile(join(root, 'other.txt'), 'other\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
  }
  return root;
}
async function change(root: string, path: string) {
  const file = (await listChanges(root)).files.find((f) => f.path === path);
  assert.ok(file, `${path} is listed`);
  return file;
}

// 已确认规则：单文件回退恢复 HEAD 的 index 和 worktree，其他文件一字不动。
test('discard restores staged and unstaged changes, including deleted parent directories', async (t) => {
  const root = await repository(t);
  await writeFile(join(root, 'other.txt'), 'keep this change\n');
  git(root, 'add', 'other.txt');
  const otherIndex = git(root, 'show', ':other.txt');
  await writeFile(join(root, 'src/file.txt'), 'staged\n');
  git(root, 'add', 'src/file.txt');
  await writeFile(join(root, 'src/file.txt'), 'unstaged\n');
  await discardChange(root, await change(root, 'src/file.txt'), unlocked);
  assert.equal(await readFile(join(root, 'src/file.txt'), 'utf8'), 'original\n');
  assert.equal(git(root, 'show', ':src/file.txt'), 'original\n');
  for (const staged of [false, true]) {
    await rm(join(root, 'src'), { recursive: true });
    if (staged) git(root, 'add', '-u');
    await discardChange(root, await change(root, 'src/file.txt'), unlocked);
    assert.equal(await readFile(join(root, 'src/file.txt'), 'utf8'), 'original\n');
    assert.equal(git(root, 'show', ':src/file.txt'), 'original\n');
  }
  assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'keep this change\n');
  assert.equal(git(root, 'show', ':other.txt'), otherIndex);
});

test('discard removes only the added file, staged or untracked, even without a first commit', async (t) => {
  for (const committed of [false, true]) {
    const root = await repository(t, committed);
    for (const staged of [false, true]) {
      const path = 'new [file]*.txt';
      await writeFile(join(root, path), 'new\n');
      await writeFile(join(root, 'new f.txt'), 'keep\n');
      if (staged) git(root, '--literal-pathspecs', 'add', '--', path);
      await discardChange(root, await change(root, path), unlocked);
      await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
      assert.equal(git(root, '--literal-pathspecs', 'ls-files', '--', path), '');
      assert.equal(await readFile(join(root, 'new f.txt'), 'utf8'), 'keep\n');
    }
  }
});

test('discard respects nested repository and workspace subdirectory boundaries', async (t) => {
  const parent = await repository(t, false);
  const root = join(parent, 'nested');
  await mkdir(root);
  git(root, 'init', '-q');
  await writeFile(join(root, 'file.txt'), 'nested\n');
  await writeFile(join(parent, 'keep.txt'), 'parent\n');
  await discardChange(parent, await change(parent, 'nested/file.txt'), unlocked);
  assert.equal(await readFile(join(parent, 'keep.txt'), 'utf8'), 'parent\n');

  const committed = await repository(t);
  await writeFile(join(committed, 'src/file.txt'), 'edited\n');
  await writeFile(join(committed, 'other.txt'), 'keep\n');
  const subdir = join(committed, 'src');
  const files = (await listChanges(subdir)).files;
  assert.deepEqual(files.map((f) => f.path), ['file.txt']);
  assert.equal(files[0].discard, 'restore');
  await discardChange(subdir, files[0], unlocked);
  assert.equal(await readFile(join(subdir, 'file.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(committed, 'other.txt'), 'utf8'), 'keep\n');
});

test('discard rejects traversal, directories, symlink parents, ignored files and stale HEAD', async (t) => {
  const root = await repository(t);
  const outside = await repository(t);
  await symlink(outside, join(root, 'link'));
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'ignored.txt'), 'keep\n');
  const body = { base: git(root, 'rev-parse', 'HEAD').trim(), discard: 'delete' as const };
  for (const path of ['../outside', root, '.git/config', 'src', 'link/other.txt', 'ignored.txt']) {
    await assert.rejects(discardChange(root, { ...body, path }, unlocked));
  }
  assert.equal(await readFile(join(outside, 'other.txt'), 'utf8'), 'other\n');
  assert.equal(await readFile(join(root, 'ignored.txt'), 'utf8'), 'keep\n');
  await writeFile(join(root, 'src/file.txt'), 'edited\n');
  const stale = await change(root, 'src/file.txt');
  git(root, 'commit', '--allow-empty', '-qm', 'new HEAD');
  await assert.rejects(discardChange(root, stale, unlocked), /Git state changed/);
  assert.equal(await readFile(join(root, 'src/file.txt'), 'utf8'), 'edited\n');
});

test('discard rejects renames, conflicts and submodules without changing the index', async (t) => {
  const root = await repository(t);
  git(root, 'mv', 'other.txt', 'renamed.txt');
  const renamed = await change(root, 'renamed.txt');
  assert.match(renamed.discardDisabled!, /Renames/);
  await assert.rejects(discardChange(root, renamed, unlocked), /Renames/);
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD').trim()},module`);
  const module = await change(root, 'module');
  assert.match(module.discardDisabled!, /Submodules/);
  await assert.rejects(discardChange(root, module, unlocked), /Submodules/);
  const blob = git(root, 'rev-parse', 'HEAD:src/file.txt').trim();
  execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: `0 ${'0'.repeat(40)}\tsrc/file.txt\n100644 ${blob} 1\tsrc/file.txt\n100644 ${blob} 2\tsrc/file.txt\n100644 ${blob} 3\tsrc/file.txt\n` });
  const conflict = await change(root, 'src/file.txt');
  assert.match(conflict.discardDisabled!, /conflicts/);
  const index = git(root, 'ls-files', '--stage');
  await assert.rejects(discardChange(root, conflict, unlocked), /conflicts/);
  assert.equal(git(root, 'ls-files', '--stage'), index);
});

test('discard treats wildcard names literally and never writes through a leaf symlink', async (t) => {
  const root = await repository(t);
  const outside = await repository(t);
  const path = '[ab]*.txt';
  await writeFile(join(root, path), 'literal\n');
  await symlink(join(outside, 'other.txt'), join(root, 'linked'));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'special paths');
  await writeFile(join(root, path), 'edited\n');
  await writeFile(join(root, 'abc.txt'), 'keep\n');
  await rm(join(root, 'linked'));
  await symlink(join(outside, 'src/file.txt'), join(root, 'linked'));
  await discardChange(root, await change(root, path), unlocked);
  await discardChange(root, await change(root, 'linked'), unlocked);
  assert.equal(await readFile(join(root, path), 'utf8'), 'literal\n');
  assert.equal(await readFile(join(root, 'abc.txt'), 'utf8'), 'keep\n');
  assert.equal(await readlink(join(root, 'linked')), join(outside, 'other.txt'));
  assert.equal(await readFile(join(outside, 'other.txt'), 'utf8'), 'other\n');
  assert.equal(await readFile(join(outside, 'src/file.txt'), 'utf8'), 'original\n');
});

test('repository writes reject active sessions and exclude new turns and concurrent discards', async (t) => {
  const root = await repository(t);
  const store = openStore(':memory:');
  const hub = createHub(store, createAttachmentStore(store, join(root, 'uploads')), (id) => mindeckMcpFor('http://127.0.0.1:0/mcp', id), createPush(store));
  t.after(() => { hub.close(); store.close(); });
  store.createWorkspace({ id: 'root', path: root, alias: 'root', createdAt: new Date().toISOString() });
  store.createWorkspace({ id: 'child', path: join(root, 'src'), alias: 'child', createdAt: new Date().toISOString() });
  const session = hub.createSession('codex', join(root, 'src'));
  await writeFile(join(root, 'src/file.txt'), 'edited\n');
  const file = await change(root, 'src/file.txt');
  for (const status of ['running', 'waiting_user'] as const) {
    store.setSessionStatus(session.id, status);
    assert.ok(hub.repositoryBusyReason(root));
    assert.ok((await listChanges(root, hub.repositoryBusyReason)).files[0].discardDisabled);
    await assert.rejects(discardChange(root, file, hub.withIdleRepository), /Wait for all tasks/);
    assert.equal(await readFile(join(root, 'src/file.txt'), 'utf8'), 'edited\n');
  }
  store.setSessionStatus(session.id, 'idle');
  await assert.rejects(hub.withIdleRepository(root, async () => {
    assert.throws(() => hub.sendMessage(session.id, 'test', []), /Discarding changes/);
    await assert.rejects(hub.withIdleRepository(root, async () => assert.fail()), /already in progress/);
    throw new Error('write failed');
  }), /write failed/);
  assert.equal(hub.repositoryBusyReason(root), undefined, 'lock released after errors');
  await discardChange(root, file, hub.withIdleRepository);
  assert.equal(await readFile(join(root, 'src/file.txt'), 'utf8'), 'original\n');
});
