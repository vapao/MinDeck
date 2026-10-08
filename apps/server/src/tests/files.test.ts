import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectEntry, deleteProjectEntry, listProjectFiles } from '../files';

test('project directory browsing cannot escape cwd through paths or symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdeck-files-'));
  const root = join(dir, 'project');
  try {
    await mkdir(root);
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(root, 'linked'));
    await symlink(root, join(root, 'loop'));
    await assert.rejects(listProjectFiles(root, '../outside', '', false), /outside the workspace/);
    await assert.rejects(listProjectFiles(root, join(dir, 'outside'), '', false), /outside the workspace/);
    await assert.rejects(listProjectFiles(root, 'linked', '', false), /outside the workspace/);
    assert.deepEqual((await listProjectFiles(root, '', '', false)).entries.map((entry) => entry.dir), [false, false]);
    assert.equal((await listProjectFiles(root, '', 'loop', false)).entries.length, 1);
  } finally { await rm(dir, { recursive: true }); }
});

async function workspace(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'agentdeck-file-writes-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

test('new entries never overwrite files, folders or symbolic links', async (t) => {
  const { root, outside } = await workspace(t);
  await createProjectEntry(root, { path: 'folder', dir: true });
  await createProjectEntry(root, { path: 'folder/file.txt', dir: false });
  assert.equal(await readFile(join(root, 'folder/file.txt'), 'utf8'), '');
  await writeFile(join(root, 'folder/file.txt'), 'keep\n');
  await writeFile(join(outside, 'target.txt'), 'outside\n');
  await symlink(join(outside, 'target.txt'), join(root, 'linked'));
  for (const path of ['folder', 'folder/file.txt', 'linked']) {
    for (const dir of [false, true]) await assert.rejects(createProjectEntry(root, { path, dir }), { statusCode: 409 });
  }
  assert.equal(await readFile(join(root, 'folder/file.txt'), 'utf8'), 'keep\n');
  assert.equal(await readFile(join(outside, 'target.txt'), 'utf8'), 'outside\n');
  await assert.rejects(createProjectEntry(root, { path: 'missing/file.txt', dir: false }), { statusCode: 404 });
});

test('file writes reject workspace root, traversal, Git metadata and symlink parents', async (t) => {
  const { root, outside } = await workspace(t);
  await writeFile(join(outside, 'keep.txt'), 'keep\n');
  await symlink(outside, join(root, 'linked'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git/config'), 'protected\n');
  for (const path of ['', '.', '..', '../outside/keep.txt', join(outside, 'keep.txt'), 'linked/keep.txt', '.git/config', '.git', '.GIT', 'nested/../keep.txt']) {
    await assert.rejects(createProjectEntry(root, { path, dir: false }), { statusCode: 400 });
    await assert.rejects(deleteProjectEntry(root, { path, dir: false }), { statusCode: 400 });
  }
  assert.equal(await readFile(join(root, '.git/config'), 'utf8'), 'protected\n');
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep\n');
});

test('folder deletion includes hidden contents but never follows symbolic links', async (t) => {
  const { root, outside } = await workspace(t);
  await mkdir(join(root, 'folder/sub'), { recursive: true });
  await writeFile(join(root, 'folder/sub/file.txt'), 'delete\n');
  await writeFile(join(root, 'folder/.hidden'), 'delete\n');
  await writeFile(join(root, 'keep.txt'), 'keep\n');
  await writeFile(join(outside, 'keep.txt'), 'outside\n');
  await symlink(outside, join(root, 'folder/linked'));
  await symlink(outside, join(root, 'linked'));
  await deleteProjectEntry(root, { path: 'linked', dir: false });
  await deleteProjectEntry(root, { path: 'folder', dir: true });
  assert.deepEqual(await readdir(root), ['keep.txt']);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside\n');
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep\n');
});

test('folder deletion rejects nested repositories and changed entry types before deleting anything', async (t) => {
  const { root } = await workspace(t);
  await mkdir(join(root, 'folder/nested'), { recursive: true });
  await writeFile(join(root, 'folder/keep.txt'), 'keep\n');
  for (const directory of [false, true]) {
    const gitPath = join(root, 'folder/nested/.git');
    if (directory) await mkdir(gitPath);
    else await writeFile(gitPath, 'gitdir: elsewhere\n');
    await assert.rejects(deleteProjectEntry(root, { path: 'folder', dir: true }), { statusCode: 409 });
    assert.equal(await readFile(join(root, 'folder/keep.txt'), 'utf8'), 'keep\n');
    await rm(gitPath, { recursive: directory });
  }
  await assert.rejects(deleteProjectEntry(root, { path: 'folder', dir: false }), { statusCode: 409 });
  await assert.rejects(deleteProjectEntry(root, { path: 'folder/keep.txt', dir: true }), { statusCode: 409 });
  await assert.rejects(deleteProjectEntry(root, { path: 'missing', dir: false }), { statusCode: 404 });
  assert.equal(await readFile(join(root, 'folder/keep.txt'), 'utf8'), 'keep\n');
});

test('Files deletion leaves staged content intact for Git recovery', async (t) => {
  const { root } = await workspace(t);
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'file.txt'), 'staged\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: root });
  await writeFile(join(root, 'file.txt'), 'unstaged\n');
  await deleteProjectEntry(root, { path: 'file.txt', dir: false });
  assert.equal(execFileSync('git', ['show', ':file.txt'], { cwd: root, encoding: 'utf8' }), 'staged\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), 'AD file.txt\n');
});
