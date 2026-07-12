import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { scanRepo } from '../src/repo-scan';
import * as extractor from '../src/extractor';

vi.mock('../src/extractor');

const origStorage = { ...storagePaths };
const origEnv = process.env['CC_HABITS_DIR'];

let storeDir: string;
let repoDir: string;
let secretDir: string;

function pointStorageAt(dir: string): void {
  storagePaths.habitsDir = dir;
  storagePaths.habitsFile = path.join(dir, 'habits.md');
  storagePaths.memoriesFile = path.join(dir, 'memories.md');
  storagePaths.configFile = path.join(dir, 'config.yml');
  storagePaths.errorLog = path.join(dir, 'error.log');
  storagePaths.tombstonesFile = path.join(dir, '.tombstones.json');
  storagePaths.memoryTombstonesFile = path.join(dir, '.memory-tombstones.json');
}

// Collect every RepoFile the scanner would have sent to the LLM.
function capturedFilePaths(): string[] {
  const calls = vi.mocked(extractor.extractHabitsFromRepo).mock.calls;
  return calls.flatMap(c => c[0].map(f => f.path));
}
function capturedFileContents(): string {
  const calls = vi.mocked(extractor.extractHabitsFromRepo).mock.calls;
  return calls.flatMap(c => c[0].map(f => f.content)).join('\n');
}
function capturedDocContents(): string {
  const calls = vi.mocked(extractor.extractMemoriesFromDocs).mock.calls;
  return calls.flatMap(c => c[0].map(f => f.content)).join('\n');
}

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-sec-store-'));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-sec-repo-'));
  secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-sec-secret-'));
  process.env['CC_HABITS_DIR'] = storeDir;
  pointStorageAt(storeDir);
  // A usable provider must exist for the scan to reach the extractor (it now gates
  // on this before any analysis). The extractor is mocked, so no real call is made.
  fs.writeFileSync(path.join(storeDir, 'config.yml'), 'provider: anthropic\nanthropic_api_key: test-key\n');
  vi.mocked(extractor.extractHabitsFromRepo).mockResolvedValue([] as any);
  vi.mocked(extractor.extractMemoriesFromDocs).mockResolvedValue([] as any);
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  if (origEnv === undefined) delete process.env['CC_HABITS_DIR'];
  else process.env['CC_HABITS_DIR'] = origEnv;
  for (const d of [storeDir, repoDir, secretDir]) fs.rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('repo-scan: symlink-following (info disclosure)', () => {
  it.skipIf(process.platform === 'win32')('does not follow a source-file symlink pointing outside the repo', async () => {
    // A secret file living outside the scanned repo.
    const secretFile = path.join(secretDir, 'credentials');
    fs.writeFileSync(secretFile, 'AWS_SECRET=topsecretvalue1234567890\n');
    // One legitimate source file, plus a planted symlink with a source extension.
    fs.writeFileSync(path.join(repoDir, 'real.ts'), 'export const a = 1;\n');
    fs.symlinkSync(secretFile, path.join(repoDir, 'evil.ts'));

    await scanRepo({ cwd: repoDir });

    const paths = capturedFilePaths();
    expect(paths).toContain('real.ts');
    expect(paths).not.toContain('evil.ts');
    expect(capturedFileContents()).not.toContain('topsecretvalue');
  });

  it.skipIf(process.platform === 'win32')('does not follow a doc symlink (e.g. CLAUDE.md -> outside file)', async () => {
    const secretFile = path.join(secretDir, 'private.txt');
    fs.writeFileSync(secretFile, 'INTERNAL ONLY do-not-exfiltrate-marker\n');
    fs.writeFileSync(path.join(repoDir, 'real.ts'), 'export const a = 1;\n');
    fs.symlinkSync(secretFile, path.join(repoDir, 'CLAUDE.md'));

    await scanRepo({ cwd: repoDir });

    expect(capturedDocContents()).not.toContain('do-not-exfiltrate-marker');
  });

  it.skipIf(process.platform === 'win32')('does not descend into a symlinked directory during the manual walk', async () => {
    const outsideSrc = path.join(secretDir, 'leak.ts');
    fs.writeFileSync(outsideSrc, 'const SECRET = "walk-symlink-leak-marker";\n');
    fs.writeFileSync(path.join(repoDir, 'real.ts'), 'export const a = 1;\n');
    fs.symlinkSync(secretDir, path.join(repoDir, 'linkdir'));

    await scanRepo({ cwd: repoDir });
    expect(capturedFileContents()).not.toContain('walk-symlink-leak-marker');
  });
});

describe('repo-scan: resource bounds', () => {
  it('skips files larger than the size cap instead of loading them into memory', async () => {
    // 2 MB file (> MAX_FILE_BYTES). Must be skipped, not read.
    fs.writeFileSync(path.join(repoDir, 'huge.ts'), 'a'.repeat(2 * 1024 * 1024));
    fs.writeFileSync(path.join(repoDir, 'small.ts'), 'export const a = 1;\n');

    await scanRepo({ cwd: repoDir });

    const paths = capturedFilePaths();
    expect(paths).toContain('small.ts');
    expect(paths).not.toContain('huge.ts');
  });

  it('caps per-file content sent to the LLM at the sample size', async () => {
    fs.writeFileSync(path.join(repoDir, 'big.ts'), 'x'.repeat(50_000));
    await scanRepo({ cwd: repoDir });
    const contents = vi.mocked(extractor.extractHabitsFromRepo).mock.calls.flatMap(c => c[0]);
    const big = contents.find(f => f.path === 'big.ts');
    expect(big).toBeDefined();
    expect(big!.content.length).toBeLessThanOrEqual(2000);
  });
});

describe('repo-scan: redaction before egress', () => {
  it('redacts secrets in source files before they reach the extractor', async () => {
    fs.writeFileSync(
      path.join(repoDir, 'config.ts'),
      'const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\nconst email = "person@example.com";\n',
    );
    await scanRepo({ cwd: repoDir });
    const content = capturedFileContents();
    expect(content).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(content).not.toContain('person@example.com');
    expect(content).toContain('<REDACTED');
  });
});
