import os from 'os';
import path from 'path';
import fs from 'fs';

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
