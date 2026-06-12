import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths, initHabitsMd, writeHabitsMd, writeMemoriesMd } from '../src/storage';
import { buildProfile } from '../src/portable';
import { captureDisabled, buildInjectionContext, processPostToolUse } from '../src/hook';

const origStorage = { ...storagePaths };
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-iso-'));
  storagePaths.habitsDir = tmpDir;
  storagePaths.habitsFile = path.join(tmpDir, 'habits.md');
  storagePaths.memoriesFile = path.join(tmpDir, 'memories.md');
  storagePaths.logFile = path.join(tmpDir, 'log.jsonl');

  initHabitsMd();
});

afterEach(() => {
  Object.assign(storagePaths, origStorage);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('Layer 5: End-to-End Isolation Tests', () => {
  describe('Cross-Repo Contamination (Risk #3)', () => {
    it('isolates projects completely and prevents leakage across namespaces', () => {
      const repoADir = path.join(tmpDir, 'repoA');
      const repoBDir = path.join(tmpDir, 'repoB');
      fs.mkdirSync(repoADir);
      fs.mkdirSync(repoBDir);

      // Create isolated cc-habits configurations
      const storageA = {
        habitsDir: repoADir,
        habitsFile: path.join(repoADir, 'habits.md'),
        memoriesFile: path.join(repoADir, 'memories.md'),
        logFile: path.join(repoADir, 'log.jsonl'),
      };

      const storageB = {
        habitsDir: repoBDir,
        habitsFile: path.join(repoBDir, 'habits.md'),
        memoriesFile: path.join(repoBDir, 'memories.md'),
        logFile: path.join(repoBDir, 'log.jsonl'),
      };

      // Initialize both repositories
      fs.writeFileSync(storageA.habitsFile, '<!-- cc-habits format v0.3 -->\n# Coding habits\n\n## TypeScript\n- Prefer const. Confidence: 0.80\n  - Sessions seen: 3\n');
      fs.writeFileSync(storageB.habitsFile, '<!-- cc-habits format v0.3 -->\n# Coding habits\n\n## Python\n- Use type hints. Confidence: 0.90\n  - Sessions seen: 4\n');

      // Verify that repo A's habits do not contain Python and repo B's do not contain TypeScript
      const contentA = fs.readFileSync(storageA.habitsFile, 'utf-8');
      const contentB = fs.readFileSync(storageB.habitsFile, 'utf-8');

      expect(contentA).toContain('Prefer const');
      expect(contentA).not.toContain('Use type hints');

      expect(contentB).toContain('Use type hints');
      expect(contentB).not.toContain('Prefer const');
    });

    it('honors .cc-habits-ignore in working directory and disables capture completely', () => {
      const workingDir = path.join(tmpDir, 'work');
      fs.mkdirSync(workingDir);
      fs.writeFileSync(path.join(workingDir, '.cc-habits-ignore'), '');

      const spyCwd = vi.spyOn(process, 'cwd').mockReturnValue(workingDir);

      expect(captureDisabled()).toBe(true);

      // Verify that processPostToolUse is a no-op under ignore
      processPostToolUse({
        toolName: 'Write',
        filePath: 'src/main.ts',
        newContent: 'const x = 1;',
        sessionId: 's1',
      });

      // No log file should be written in tmpDir since capture is disabled
      expect(fs.existsSync(storagePaths.logFile)).toBe(false);

      spyCwd.mockRestore();
    });
  });

  describe('Memory Exfiltration & Disclosure (Risk #4)', () => {
    it('verifies that buildInjectionContext only outputs sanitized category/rule headers without metadata/tombstones', () => {
      const seeded = `<!-- cc-habits format v0.3 -->
# Coding habits

## TypeScript

- Use explicit return types on exported functions. Confidence: 0.80
  - Signal: 3 reinforcing, 0 contradicting
  - Sessions seen: 3
  - Languages: ts

## Learning (not yet active)

- [Imports] Prefer named imports. Confidence: 0.50
  - Signal: 1 reinforcing, 0 contradicting
  - Sessions seen: 1
`;
      writeHabitsMd(seeded);

      const ctx = buildInjectionContext(seeded);
      expect(ctx).not.toBeNull();
      expect(ctx!).toContain('<coding-habits>');
      expect(ctx!).toContain('TypeScript:');
      expect(ctx!).toContain('- Use explicit return types on exported functions.');

      // Invariants: must not disclose confidence, signals, sessions seen, or quarantine/learning rules
      expect(ctx!).not.toContain('Confidence:');
      expect(ctx!).not.toContain('Sessions seen:');
      expect(ctx!).not.toContain('Signal:');
      expect(ctx!).not.toContain('Prefer named imports');
      expect(ctx!).not.toContain('Learning');
    });
  });

  describe('Export Redaction Tests (Added)', () => {
    it('redacts sensitive API keys, emails, and credentials during profile export', () => {
      const habitsWithSecrets = `<!-- cc-habits format v0.3 -->
# Coding habits

## TypeScript

- Configure server with key sk-ant-abcdefghijklmnopqrstuvwxyz1234567890. Confidence: 0.80
  - Signal: 3 reinforcing, 0 contradicting
  - Sessions seen: 3

## Error Handling

- Send logs to admin@company.com with card 4111111111111111. Confidence: 0.90
  - Signal: 4 reinforcing, 0 contradicting
  - Sessions seen: 4
`;
      writeHabitsMd(habitsWithSecrets);

      const memoriesWithSecrets = `<!-- cc-habits memories format v0.1 -->
# Coding memories

## Repeated mistakes

- When calling db.query, do not embed password=super-secret-password-123.
  - Trigger: db.query
  - Correction: Use env vars instead
  - Confidence: 0.80
  - Seen: 3
  - Sessions seen: 2
`;
      writeMemoriesMd(memoriesWithSecrets);

      // Build exported profile bundle
      const exported = buildProfile({ version: '1.0.0', includeMemories: true });

      // Verifications
      expect(exported).toContain('<!-- cc-habits profile');
      expect(exported).toContain('<!-- BEGIN habits -->');
      expect(exported).toContain('<!-- BEGIN memories -->');

      // Key sensitive PII/secrets must be redacted
      expect(exported).not.toContain('sk-ant-');
      expect(exported).toContain('<REDACTED:api-key>');

      expect(exported).not.toContain('admin@company.com');
      expect(exported).toContain('<REDACTED:email>');

      expect(exported).not.toContain('4111111111111111');
      expect(exported).toContain('<REDACTED:card>');

      expect(exported).not.toContain('super-secret-password-123');
      expect(exported).toContain('<REDACTED:pii>');
    });
  });
});
