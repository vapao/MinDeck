import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// An unverified download must never replace the user's installed helper.
const root = mkdtempSync(resolve(tmpdir(), 'mindeck-helper-test-'));
try {
  const home = resolve(root, 'home with spaces');
  const helper = resolve(home, 'Applications/MinDeck Finder.app');
  mkdirSync(helper, { recursive: true });
  writeFileSync(resolve(helper, 'existing'), 'keep me');
  const script = resolve(root, 'install-helper.sh');
  writeFileSync(script, readFileSync(new URL('./install-helper.sh', import.meta.url), 'utf8')
    .replaceAll('@REPOSITORY@', 'test/MinDeck').replaceAll('@VERSION@', 'v0.0.0-test'));
  // Substitute only the download boundary; checksum and installer run unchanged.
  writeFileSync(resolve(root, 'curl'), `#!/bin/sh
if [ "$HELPER_TEST_FAILURE" = download ]; then exit 22; fi
for arg do
  case "$arg" in https:*) url="$arg" ;; esac
  destination="$arg"
done
case "$url" in
  *.sha256) printf '%064d  %s\\n' 0 "$(basename "$url")" | sed 's/\\.sha256$//' > "$destination" ;;
  *) printf 'corrupted download' > "$destination" ;;
esac
`, { mode: 0o755 });
  for (const failure of ['download', 'checksum']) {
    const result = spawnSync('/bin/sh', [script], {
      env: { ...process.env, HOME: home, PATH: `${root}:${process.env.PATH}`, HELPER_TEST_FAILURE: failure },
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, `${failure} must stop installation`);
    if (failure === 'checksum') assert.match(result.stdout + result.stderr, /FAILED/);
    assert.equal(readFileSync(resolve(helper, 'existing'), 'utf8'), 'keep me');
  }
  console.log('Helper download / checksum failures preserve the installed app.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
