import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { runGitCapture } from '../src/git-collector';

// Detect git once. The whole suite is meaningless without it.
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const GIT = hasGit();

const origStorage = { ...storagePaths };
let repoDir: string;
let storeDir: string;

function gitIn(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-gitsec-repo-'));
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-gitsec-store-'));
  // Redirect cc-habits storage so captured signals do not touch real files.
  storagePaths.habitsDir = storeDir;
  storagePaths.logFile = path.join(storeDir, 'log.jsonl');
  storagePaths.errorLog = path.join(storeDir, 'error.log');

  if (GIT) {
    gitIn(repoDir, ['init']);
    // Disable inherited git hooks (e.g. a global template post-commit hook) so
    // the test exercises only runGitCapture, not whatever cc-habits binary the
    // developer happens to have installed globally.
    const emptyHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-gitsec-nohooks-'));
    gitIn(repoDir, ['config', 'core.hooksPath', emptyHooks]);
    gitIn(repoDir, ['config', 'user.email', 'test@example.com']);
    gitIn(repoDir, ['config', 'user.name', 'Test']);
    gitIn(repoDir, ['config', 'commit.gpgsign', 'false']);
    // Baseline commit so HEAD~1 exists. The default capture range is HEAD~1..HEAD,
    // and only that path reaches the per-file `git diff ... -- <file>` line where
    // the injection used to live. A single commit would hit the empty-tree
    // fallback (which can fail on a fresh repo) and never process the file.
    fs.writeFileSync(path.join(repoDir, 'baseline.ts'), 'export const seed = 0\n');
    gitIn(repoDir, ['add', '-A']);
    gitIn(repoDir, ['commit', '-m', 'baseline']);
  }
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('git-collector command-injection hardening', () => {
  it.skipIf(!GIT)('does not execute a command-substitution file name on capture', async () => {
    // A repository file whose name embeds a shell command substitution. Under the
    // old string-interpolated execSync this executed when the file was processed.
    const sentinel = path.join(repoDir, 'PWNED_FILE');
    const evilName = '$(touch PWNED_FILE).txt';
    fs.writeFileSync(path.join(repoDir, evilName), 'const a = 1\nconst b = 2\n');
    gitIn(repoDir, ['add', '-A']);
    gitIn(repoDir, ['commit', '-m', 'add file with hostile name']);

    await runGitCapture(undefined, repoDir);

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it.skipIf(!GIT)('does not execute a backtick file name on capture', async () => {
    const sentinel = path.join(repoDir, 'PWNED_BACKTICK');
    const evilName = '`touch PWNED_BACKTICK`.txt';
    fs.writeFileSync(path.join(repoDir, evilName), 'const a = 1\nconst b = 2\n');
    gitIn(repoDir, ['add', '-A']);
    gitIn(repoDir, ['commit', '-m', 'add file with backtick name']);

    await runGitCapture(undefined, repoDir);

    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it.skipIf(!GIT)('rejects a malicious --range and runs nothing', async () => {
    const sentinel = path.join(repoDir, 'PWNED_RANGE');
    fs.writeFileSync(path.join(repoDir, 'ok.ts'), 'const a = 1\n');
    gitIn(repoDir, ['add', '-A']);
    gitIn(repoDir, ['commit', '-m', 'init']);

    // Range with shell metacharacters and a leading-dash option-injection attempt.
    const res1 = await runGitCapture(`HEAD; touch ${sentinel}`, repoDir);
    const res2 = await runGitCapture('$(touch PWNED_RANGE)', repoDir);
    const res3 = await runGitCapture('--output=/tmp/whatever', repoDir);

    expect(res1.signalsCaptured).toBe(0);
    expect(res2.signalsCaptured).toBe(0);
    expect(res3.signalsCaptured).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'PWNED_RANGE'))).toBe(false);
  });

  it.skipIf(!GIT)('still captures a normally named file', async () => {
    fs.writeFileSync(path.join(repoDir, 'real.ts'), 'export const value = 42\nexport const other = 7\n');
    gitIn(repoDir, ['add', '-A']);
    gitIn(repoDir, ['commit', '-m', 'add real file']);

    const res = await runGitCapture(undefined, repoDir);
    // The capture path should run without error and record the legitimate edit.
    expect(res.signalsCaptured).toBeGreaterThanOrEqual(1);
  });
});
