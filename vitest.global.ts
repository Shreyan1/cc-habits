import os from 'os';
import path from 'path';
import fs from 'fs';

// Runs once after the whole suite (separate process from the workers). Removes
// the throwaway storage directories created by vitest.setup.ts so test runs
// leave no temp-dir residue behind. Pattern-based so it cleans up regardless of
// which worker process created the directory.
export function teardown(): void {
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp)) {
    if (entry.startsWith('cc-habits-vitest-')) {
      fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
    }
  }
}
