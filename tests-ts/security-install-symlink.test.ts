/**
 * Security: installLocalGitHook must not write through a symlinked post-commit
 * hook. A cloned/malicious repo could plant .git/hooks/post-commit as a symlink
 * to a sensitive file; appending or creating through it would corrupt that file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { installLocalGitHook } from '../src/install';

const isWindows = process.platform === 'win32';
let repoDir: string;
let origCwd: string;

beforeEach(() => {
  origCwd = process.cwd();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-install-sym-'));
  fs.mkdirSync(path.join(repoDir, '.git', 'hooks'), { recursive: true });
  process.chdir(repoDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function writeSecretFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
}

function readFileContent(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('installLocalGitHook symlink safety', () => {
  it('refuses to write through a symlinked post-commit hook and leaves the target intact', () => {
    if (isWindows) return; // symlink creation needs privileges on Windows
    const secret = path.join(repoDir, 'secret.txt');
    writeSecretFile(secret, 'SENSITIVE\n');
    const hookFile = path.join(repoDir, '.git', 'hooks', 'post-commit');
    fs.symlinkSync(secret, hookFile);

    const result = installLocalGitHook();

    expect(result).toBe('failed');
    // The target file must be untouched (no append through the symlink).
    expect(readFileContent(secret)).toBe('SENSITIVE\n');
    // The hook path is still the planted symlink, not overwritten.
    expect(fs.lstatSync(hookFile).isSymbolicLink()).toBe(true);
  });

  it('creates a fresh regular (non-symlink) hook file in a clean repo', () => {
    const result = installLocalGitHook();

    expect(result).toBe('installed');
    const hookFile = path.join(repoDir, '.git', 'hooks', 'post-commit');
    const st = fs.lstatSync(hookFile);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(readFileContent(hookFile)).toContain('git-capture');
  });

  it('is idempotent: a second install reports already', () => {
    expect(installLocalGitHook()).toBe('installed');
    expect(installLocalGitHook()).toBe('already');
  });
});
