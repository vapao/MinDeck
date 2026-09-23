import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFiles } from '../files';

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
