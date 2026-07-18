/**
 * The post-commit hook must never make noise on a commit.
 *
 * Older versions wrote a bare `cc-habits git-capture || true`. Once the binary
 * was uninstalled or fell off the hook's PATH (a GUI git client runs hooks with
 * a minimal PATH), every commit printed `cc-habits: command not found`. The
 * exit code was swallowed but the stderr was not, so the repo looked broken
 * while capture silently did nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installLocalGitHook, uninstallLocalGitHook } from '../src/install';

const isWindows = process.platform === 'win32';
let repoDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-git-hook-'));
  fs.mkdirSync(path.join(repoDir, '.git', 'hooks'), { recursive: true });
  process.chdir(repoDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const hookPath = (): string => path.join(repoDir, '.git', 'hooks', 'post-commit');
const readHook = (): string => fs.readFileSync(hookPath(), 'utf-8');

/**
 * Run the hook with an empty PATH, the worst case a GUI git client produces.
 * stderr is piped, not inherited, so the assertion below actually sees it.
 */
function runHookWithoutBinary(): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync('/bin/sh', [hookPath()], {
    encoding: 'utf-8',
    env: { PATH: '' },
    cwd: repoDir,
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('post-commit hook is quiet and fail-open', () => {
  it('guards the binary lookup instead of calling it bare', () => {
    installLocalGitHook();
    const body = readHook();
    expect(body).toContain('command -v');
    expect(body).toContain('git-capture');
    expect(body).toContain('|| true');
    // stderr must be discarded so a missing binary cannot print on a commit.
    expect(body).toContain('2>&1');
  });

  it('produces no output and exits 0 when the binary is not resolvable', () => {
    if (isWindows) return; // /bin/sh is not the hook interpreter on Windows
    installLocalGitHook();
    const { status, stdout, stderr } = runHookWithoutBinary();
    expect(stderr).toBe('');
    expect(stdout).toBe('');
    expect(status).toBe(0);
  });

  it('upgrades a hook written by an older version in place', () => {
    fs.writeFileSync(hookPath(), '#!/bin/sh\ncc-habits git-capture || true\n', { mode: 0o755 });

    const result = installLocalGitHook();

    expect(result).toBe('installed');
    const body = readHook();
    expect(body).toContain('command -v');
    // The old unguarded call must be gone, not merely accompanied.
    expect(body).not.toMatch(/^cc-habits git-capture \|\| true$/m);
    expect(body.split('\n').filter(l => l.includes('git-capture'))).toHaveLength(1);
  });

  it('upgrades the older `cch` spelling too, and keeps the user\'s own lines', () => {
    fs.writeFileSync(
      hookPath(),
      '#!/bin/sh\necho mine\ncch git-capture || true\necho after\n',
      { mode: 0o755 },
    );

    installLocalGitHook();

    const lines = readHook().split('\n');
    expect(lines).toContain('echo mine');
    expect(lines).toContain('echo after');
    expect(lines.filter(l => l.includes('git-capture'))).toHaveLength(1);
    // The user's surrounding lines keep their original order around ours.
    expect(lines.indexOf('echo mine')).toBeLessThan(lines.findIndex(l => l.includes('git-capture')));
    expect(lines.indexOf('echo after')).toBeGreaterThan(lines.findIndex(l => l.includes('git-capture')));
  });

  it('still installs when process.argv[1] is absent', () => {
    // A missing argv[1] (node -e, some runners) used to throw out of the path
    // resolution and surface as a bogus 'failed' install.
    const orig = process.argv[1];
    try {
      // @ts-expect-error deliberately reproducing the argv shape that broke it
      process.argv[1] = undefined;
      expect(installLocalGitHook()).toBe('installed');
      expect(readHook()).toContain('git-capture');
    } finally {
      process.argv[1] = orig;
    }
  });

  it('is idempotent once upgraded', () => {
    installLocalGitHook();
    const first = readHook();

    expect(installLocalGitHook()).toBe('already');
    expect(readHook()).toBe(first);
  });

  it('uninstall still removes the new hook line', () => {
    installLocalGitHook();
    expect(uninstallLocalGitHook()).toBe(true);
    // Nothing but a shebang was left, so the file is removed entirely.
    expect(fs.existsSync(hookPath())).toBe(false);
  });

  it('uninstall leaves a user line behind and removes only ours', () => {
    fs.writeFileSync(hookPath(), '#!/bin/sh\necho mine\ncc-habits git-capture || true\n', { mode: 0o755 });
    installLocalGitHook();

    expect(uninstallLocalGitHook()).toBe(true);
    const body = readHook();
    expect(body).toContain('echo mine');
    expect(body).not.toContain('git-capture');
  });
});
