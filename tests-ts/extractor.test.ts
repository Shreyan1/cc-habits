import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function() {
    return { messages: { create: mockCreate } };
  }),
}));

import { extractRules, extractMemoryCandidates } from '../src/extractor';

describe('extractRules', () => {
  beforeEach(() => {
    // Force anthropic provider so the @anthropic-ai/sdk mock intercepts calls
    // regardless of any real config.yml on disk.
    process.env['CC_HABITS_PROVIDER'] = 'anthropic';
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    delete process.env['CC_HABITS_PROVIDER'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('returns a list of RuleUpdate objects', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([{
        category: 'Python',
        rule: 'Use type hints',
        decision: 'create',
        matched_habit_id: '',
        reasoning: 'seen 3x',
      }]) }],
    });
    const result = await extractRules(
      [{ ts: 't', session_id: 's', type: 'edit', file: 'a.py', diff: '-x\n+y' }],
      '# Coding habits\n',
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].rule).toBe('Use type hints');
  });

  it('returns empty list on bad JSON response', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json at all' }] });
    const result = await extractRules([], '# Coding habits\n');
    expect(result).toEqual([]);
  });

  it('strips markdown code fences before parsing', async () => {
    const payload = [{ category: 'Python', rule: 'Use f-strings', decision: 'create', matched_habit_id: '', reasoning: '' }];
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }],
    });
    const result = await extractRules([], '');
    expect(result).toHaveLength(1);
    expect(result[0].rule).toBe('Use f-strings');
  });
});

describe('extractMemoryCandidates', () => {
  beforeEach(() => {
    process.env['CC_HABITS_PROVIDER'] = 'anthropic';
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    delete process.env['CC_HABITS_PROVIDER'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('returns valid memory candidates from provider response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([{
        section: 'Repeated mistakes',
        text: 'When editing settings.json, do not overwrite existing hook arrays',
        trigger: ['settings.json', 'hooks'],
        correction: 'Merge new hooks with existing hooks',
        reasoning: 'Array was overwritten twice in this session',
      }]) }],
    });
    const result = await extractMemoryCandidates(
      [{ ts: 't', session_id: 's', type: 'edit', file: 'settings.json', diff: '-hooks:[]\n+hooks:[newHook]' }],
      '<!-- cc-habits memories format v0.1 -->\n# Coding memories\n',
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('overwrite existing hook arrays');
    expect(result[0].trigger).toEqual(['settings.json', 'hooks']);
    expect(result[0].section).toBe('Repeated mistakes');
  });

  it('returns empty list on bad JSON response', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] });
    const result = await extractMemoryCandidates([], '');
    expect(result).toEqual([]);
  });

  it('falls back to Repeated mistakes for unknown section', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([{
        section: 'Unknown section name',
        text: 'Some mistake',
        trigger: [],
        correction: 'Do it right',
      }]) }],
    });
    const result = await extractMemoryCandidates([], '');
    expect(result[0].section).toBe('Repeated mistakes');
  });

  // Small local models sometimes copy the prompt's own few-shot examples back out
  // verbatim. Those must never reach the user's memories.md.
  it('drops candidates that echo the prompt few-shot examples verbatim', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([
        {
          section: 'Repeated mistakes',
          text: 'When fetching user data in api.ts, do not read properties without checking if user is null.',
          trigger: ['api.ts'],
          correction: 'Check if user is null first',
        },
        {
          section: 'Repeated mistakes',
          text: 'When calling db.query, do not forget to call client.release() in a finally block.',
          trigger: ['db.query'],
          correction: 'Release the client in finally',
        },
      ]) }],
    });
    const result = await extractMemoryCandidates([], '');
    expect(result).toEqual([]);
  });

  it('drops near-exact echoes with minor punctuation and spacing drift', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([{
        section: 'Repeated mistakes',
        // No trailing period, extra whitespace, lowercased.
        text: 'when fetching user data in api.ts,  do not read properties without checking if user is null',
        trigger: ['api.ts'],
        correction: 'null check',
      }]) }],
    });
    const result = await extractMemoryCandidates([], '');
    expect(result).toEqual([]);
  });

  it('keeps genuine memory candidates that only share surface words with an example', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([{
        section: 'Repeated mistakes',
        text: 'When editing settings.json, do not overwrite existing hook arrays',
        trigger: ['settings.json'],
        correction: 'Merge new hooks with existing hooks',
      }]) }],
    });
    const result = await extractMemoryCandidates([], '');
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain('overwrite existing hook arrays');
  });
});

describe('extractRules prompt-instruction echo guard', () => {
  beforeEach(() => {
    process.env['CC_HABITS_PROVIDER'] = 'anthropic';
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    delete process.env['CC_HABITS_PROVIDER'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('drops rules that quote the prompt instruction text, keeps real ones', async () => {
    const payload = [
      { category: 'Exercises|Guidelines', rule: "Always follow the 'Single Declarative Sentence' rule in coding. This means stating a preference clearly", decision: 'create', matched_habit_id: '', reasoning: '' },
      { category: 'Style', rule: 'CONSOLIDATE RELATED PREFERENCES into broad rules', decision: 'create', matched_habit_id: '', reasoning: '' },
      { category: 'TypeScript', rule: 'Use explicit type annotations for function signatures', decision: 'create', matched_habit_id: '', reasoning: '' },
    ];
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
    const result = await extractRules([], '# Coding habits\n');
    expect(result).toHaveLength(1);
    expect(result[0].rule).toBe('Use explicit type annotations for function signatures');
  });

  it('does not drop ordinary documentation habits', async () => {
    const payload = [
      { category: 'Documentation', rule: 'Use sentence case for headings and second-person voice', decision: 'create', matched_habit_id: '', reasoning: '' },
    ];
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
    const result = await extractRules([], '');
    expect(result).toHaveLength(1);
  });
});
