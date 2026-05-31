import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultRoot } from '../src/storage';

describe('project-specific profiles', () => {
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-profile-test-'));
    originalEnv = process.env['CC_HABITS_DIR'];
    delete process.env['CC_HABITS_DIR'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['CC_HABITS_DIR'] = originalEnv;
    } else {
      delete process.env['CC_HABITS_DIR'];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('falls back to global ~/.cc-habits when no local .cc-habits folder is found', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    const root = defaultRoot();
    expect(root).toBe(path.join(os.homedir(), '.cc-habits'));
  });

  it('uses local .cc-habits when found in current working directory', () => {
    const localDir = path.join(tmpRoot, '.cc-habits');
    fs.mkdirSync(localDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);

    const root = defaultRoot();
    expect(root).toBe(localDir);
  });

  it('uses local .cc-habits when found in parent directory (upward search)', () => {
    const localDir = path.join(tmpRoot, '.cc-habits');
    fs.mkdirSync(localDir);
    
    const subDir = path.join(tmpRoot, 'src', 'components');
    fs.mkdirSync(subDir, { recursive: true });

    vi.spyOn(process, 'cwd').mockReturnValue(subDir);

    const root = defaultRoot();
    expect(root).toBe(localDir);
  });

  it('respects CC_HABITS_DIR environment variable override first', () => {
    const envDir = path.join(tmpRoot, 'env-habits');
    fs.mkdirSync(envDir);
    process.env['CC_HABITS_DIR'] = envDir;

    // Create a local one too to verify env takes priority
    const localDir = path.join(tmpRoot, '.cc-habits');
    fs.mkdirSync(localDir);

    vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);

    const root = defaultRoot();
    expect(root).toBe(envDir);
  });
});
