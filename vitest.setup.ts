import os from 'os';
import path from 'path';
import fs from 'fs';
import { beforeAll, afterAll } from 'vitest';

// CI-faithful isolation. Runs in each worker before any source module is
// imported, so `storagePaths` (computed at import time from CC_HABITS_DIR) is
// pinned to a throwaway temp directory. Without this, a test that forgets to
// override storagePaths.* falls back to the real ~/.claude/habits, which
// exists on a dev machine but not on CI, producing the "green locally, red in
// CI" failures we hit repeatedly. Setting the documented CC_HABITS_DIR override
// guarantees neither environment ever touches real user data.
//
// The guard keeps it to a single temp dir per worker run (the env var persists
// across test files in the same process). Cleanup happens in vitest.global.ts.
if (!process.env['CC_HABITS_DIR']) {
  process.env['CC_HABITS_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-vitest-'));
}

// Files in the developer's own checkout that no test may write.
//
// The CC_HABITS_DIR pin above closes the storage half of this problem. It
// cannot close the cwd half: several tests legitimately read source files by
// relative path, so cwd has to stay the repo root by default. Anything the
// source resolves from cwd rather than from an injectable path therefore lands
// in the developer's actual repo. installLocalGitHook resolves .git/hooks from
// cwd, so a test calling cmdInit without chdir appended the capture line to the
// developer's own post-commit hook on every `npm test`.
//
// Resolved once at load time, while cwd is still the repo root, since tests
// chdir freely afterwards.
const GUARDED_FILES = [path.resolve('.git', 'hooks', 'post-commit')];

/** Absent is a legitimate state that must stay absent, hence null over throwing. */
function readOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// Registered per test file, so a leak fails the file that caused it rather than
// the run as a whole. An afterAll in globalSetup would report it too late:
// vitest logs a throw there but still exits 0, which CI would sail straight past.
const guardSnapshots = new Map<string, string | null>();

beforeAll(() => {
  for (const filePath of GUARDED_FILES) guardSnapshots.set(filePath, readOrNull(filePath));
});

afterAll(() => {
  const leaked: string[] = [];
  for (const [filePath, before] of guardSnapshots) {
    const after = readOrNull(filePath);
    if (after === before) continue;
    leaked.push(filePath);
    // Put the developer's file back exactly as it was before failing.
    before === null
      ? fs.rmSync(filePath, { force: true })
      : fs.writeFileSync(filePath, before, { mode: 0o755 });
  }

  if (leaked.length > 0) {
    throw new Error(
      `this test file wrote to the developer's own checkout: ${leaked.join(', ')}. ` +
        'The files have been restored. The cause is source code that resolves a ' +
        'path from process.cwd() rather than an injectable path, reached from a ' +
        'test that does not chdir into a temp directory first.',
    );
  }
});
