import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    onDidOpenTextDocument: vi.fn(),
    onDidSaveTextDocument: vi.fn(),
    getWorkspaceFolder: vi.fn(),
    textDocuments: [],
  },
}));

import { buildUnifiedDiff } from './collector';

describe('buildUnifiedDiff', () => {
  it('returns empty string when contents are identical', () => {
    const prev = 'line 1\nline 2\nline 3';
    const curr = 'line 1\nline 2\nline 3';
    const diff = buildUnifiedDiff(prev, curr, 'test.txt');
    expect(diff).toBe('');
  });

  it('performs prefix-suffix trimming and diffs the difference', () => {
    const prev = 'prefix 1\nprefix 2\nold middle\nsuffix 1\nsuffix 2';
    const curr = 'prefix 1\nprefix 2\nnew middle\nsuffix 1\nsuffix 2';
    const diff = buildUnifiedDiff(prev, curr, 'test.txt');

    expect(diff).toContain('--- test.txt');
    expect(diff).toContain('+++ test.txt');
    expect(diff).toContain('-old middle');
    expect(diff).toContain('+new middle');
    // Prefix and suffix should be trimmed and not present in the diff
    expect(diff).not.toContain('prefix 1');
    expect(diff).not.toContain('suffix 1');
  });

  it('handles simple additions', () => {
    const prev = 'line 1\nline 2';
    const curr = 'line 1\nline 2\nadded line';
    const diff = buildUnifiedDiff(prev, curr, 'test.txt');

    expect(diff).not.toContain('-line 2');
    expect(diff).toContain('+added line');
  });

  it('handles simple deletions', () => {
    const prev = 'line 1\ndeleted line\nline 2';
    const curr = 'line 1\nline 2';
    const diff = buildUnifiedDiff(prev, curr, 'test.txt');

    expect(diff).toContain('-deleted line');
  });

  it('falls back to changes block representation when change block exceeds threshold', () => {
    // Generate modified contents larger than 1000 lines
    const prevLines: string[] = [];
    const currLines: string[] = [];
    for (let i = 0; i < 1005; i++) {
      prevLines.push(`prev line ${i}`);
      currLines.push(`curr line ${i}`);
    }

    const prev = 'header\n' + prevLines.join('\n') + '\nfooter';
    const curr = 'header\n' + currLines.join('\n') + '\nfooter';

    const diff = buildUnifiedDiff(prev, curr, 'test.txt');
    expect(diff).toContain('--- test.txt');
    expect(diff).toContain('+++ test.txt');
    expect(diff).toContain(`-prev line 0`);
    expect(diff).toContain(`+curr line 0`);
    expect(diff).toContain(`-prev line 1004`);
    expect(diff).toContain(`+curr line 1004`);
  });
});
