import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputFile } from '../output-files';

test('output files allow paths outside cwd, bound text reads and do not serve HTML as a document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdeck-output-'));
  try {
    const path = join(dir, '中文 # file.html');
    await writeFile(path, '<script>alert(1)</script>');
    const html = await outputFile('/unrelated-workspace', path);
    assert.equal(html.path, path);
    assert.equal(html.kind, 'text');
    assert.equal(html.mime, 'application/octet-stream');
    await writeFile(join(dir, 'large.txt'), 'x'.repeat(600_000));
    const text = await outputFile(dir, 'large.txt');
    assert.equal(text.content?.length, 512 * 1024);
    assert.equal(text.truncated, true);
    await writeFile(join(dir, 'binary'), Buffer.from([0, 255, 1]));
    assert.equal((await outputFile(dir, 'binary')).content, null);
    await assert.rejects(outputFile(dir, 'missing'), /File not found/);
  } finally { await rm(dir, { recursive: true }); }
});
