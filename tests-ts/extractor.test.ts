import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { extractRules } from '../src/extractor';

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
