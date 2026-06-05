import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchFaq, entriesInCategory } from '../src/faq';
import type { FAQEntry } from '../src/faq-db';

// Fixture DB used in place of FAQ_DATABASE for all tests
const FIXTURE_DB: FAQEntry[] = [
  {
    id: 'test-ollama',
    category: 'Ollama',
    question: 'Ollama connection timeout',
    keywords: ['ollama', 'timeout', 'connection'],
    answer: 'Run ollama serve.'
  },
  {
    id: 'test-git',
    category: 'Integration',
    question: 'Git repository not detected',
    keywords: ['git', 'repo', 'detect'],
    answer: 'Run git status.'
  }
];

describe('searchFaq', () => {
  it('returns high-confidence match for exact keyword hit', () => {
    const { high } = searchFaq('ollama timeout', FIXTURE_DB);
    expect(high).toHaveLength(1);
    expect(high[0]!.id).toBe('test-ollama');
  });

  it('returns low-confidence for partial match below threshold', () => {
    const { high, low } = searchFaq('ollama', FIXTURE_DB);
    expect(high).toHaveLength(0);
    expect(low).toHaveLength(1);
    expect(low[0]!.id).toBe('test-ollama');
  });

  it('ranks the stronger match first', () => {
    // 'git' (keyword) + 'detect' (keyword) hits test-git twice (score 2),
    // 'ollama' hits test-ollama once (score 1). test-git must outrank it.
    const { high, low } = searchFaq('git detect ollama', FIXTURE_DB);
    expect(high[0]!.id).toBe('test-git');
    expect(low.map(e => e.id)).toContain('test-ollama');
  });

  it('tolerates one-character typo', () => {
    // 'ollema' is distance-1 from keyword 'ollama' (0.5) + 'timeout' exact (1) = 1.5
    const { high, low } = searchFaq('ollema timeout', FIXTURE_DB);
    expect(high.length + low.length).toBeGreaterThan(0);
    expect([...high, ...low].map(e => e.id)).toContain('test-ollama');
  });

  it('returns empty for unrelated query', () => {
    const { high, low } = searchFaq('webpack bundler vite', FIXTURE_DB);
    expect(high).toHaveLength(0);
    expect(low).toHaveLength(0);
  });
});

describe('entriesInCategory', () => {
  it('returns every entry in the named category', () => {
    expect(entriesInCategory('Ollama', FIXTURE_DB).map(e => e.id)).toEqual(['test-ollama']);
    expect(entriesInCategory('Integration', FIXTURE_DB).map(e => e.id)).toEqual(['test-git']);
  });

  it('returns empty for an unknown category', () => {
    expect(entriesInCategory('Nonexistent', FIXTURE_DB)).toEqual([]);
  });
});

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock
}));

describe('openBrowser (security)', () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls execFileSync with an array, not a shell string', async () => {
    const { openBrowser } = await import('../src/faq');
    const url = 'https://github.com/Shreyan1/cc-habits/issues/new?title=test&body=test';
    openBrowser(url);
    const args = execFileSyncMock.mock.calls[0];
    expect(Array.isArray(args[1])).toBe(true);
  });

  it('throws if URL does not start with the repo prefix', async () => {
    const { openBrowser } = await import('../src/faq');
    expect(() => openBrowser('https://evil.com/redirect')).toThrow('URL assertion failed');
  });
});

describe('openBrowser (Windows & escaping)', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    execFileSyncMock.mockClear();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it('escapes & as ^& so cmd.exe does not split the URL', async () => {
    const { openBrowser } = await import('../src/faq');
    openBrowser('https://github.com/Shreyan1/cc-habits/issues/new?title=t&body=b');
    const [cmd, args] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe('cmd');
    const passedUrl = (args as string[])[(args as string[]).length - 1];
    expect(passedUrl).toContain('^&');
    expect(passedUrl).not.toMatch(/[^^]&/);
  });
});

describe('buildIssueUrl', () => {
  it('encodes the query safely in the URL', async () => {
    const { buildIssueUrl } = await import('../src/faq');
    const url = buildIssueUrl('ollama <script>alert(1)</script>');
    expect(url).not.toContain('<script>');
    expect(url).toContain('%3Cscript%3E');
    expect(url.startsWith('https://github.com/Shreyan1/cc-habits/issues/new')).toBe(true);
  });

  it('includes the running version and node version in the body', async () => {
    const { buildIssueUrl } = await import('../src/faq');
    const { VERSION } = await import('../src/cli');
    const url = buildIssueUrl('test');
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain(`**cc-habits version:** ${VERSION}`);
    expect(decoded).toContain(`**Node.js:** ${process.version}`);
  });
});
