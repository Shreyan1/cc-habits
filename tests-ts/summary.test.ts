/**
 * Tests for the v0.2.2 session-summary transparency surface.
 *
 *   - applyUpdates populates the optional `changes` collector for
 *     create / reinforce / contradict decisions
 *   - formatStopSummary renders a clear, plain-text (no-ANSI) summary
 *     covering every section and the empty case
 */

import { describe, it, expect } from 'vitest';
import type { HabitsMap } from '../src/storage';
import { applyUpdates, type AppliedChange } from '../src/confidence';
import { formatStopSummary, type StopResult } from '../src/hook';

function emptyResult(over: Partial<StopResult> = {}): StopResult {
  return { newCount: 0, updatedCount: 0, decayed: 0, tombstoned: 0, changes: [], ...over };
}

describe('applyUpdates changes collector', () => {
  it('records a create with the initial confidence', () => {
    const cats: HabitsMap = {};
    const changes: AppliedChange[] = [];
    applyUpdates(
      cats,
      [{ category: 'TS', rule: 'Use strict mode', decision: 'create', matched_habit_id: '', reasoning: '' }],
      { sessionId: 's1', changes },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ category: 'TS', rule: 'Use strict mode', decision: 'create', confidence: 0.5 });
  });

  it('records a reinforce with the increased confidence', () => {
    const cats: HabitsMap = {
      TS: [{ rule: 'Use strict mode', confidence: 0.6, reinforcing: 2, contradicting: 0, sessions_seen: 2, last_session_id: 'old' }],
    };
    const changes: AppliedChange[] = [];
    applyUpdates(
      cats,
      [{ category: 'TS', rule: 'Use strict mode', decision: 'reinforce', matched_habit_id: '', reasoning: '' }],
      { sessionId: 's2', changes },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].decision).toBe('reinforce');
    expect(changes[0].confidence).toBeCloseTo(0.65, 2);
  });

  it('records a contradict with the decreased confidence', () => {
    const cats: HabitsMap = {
      TS: [{ rule: 'Use strict mode', confidence: 0.6, reinforcing: 2, contradicting: 0, sessions_seen: 2 }],
    };
    const changes: AppliedChange[] = [];
    applyUpdates(
      cats,
      [{ category: 'TS', rule: 'Use strict mode', decision: 'contradict', matched_habit_id: '', reasoning: '' }],
      { sessionId: 's2', changes },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].decision).toBe('contradict');
    expect(changes[0].confidence).toBeCloseTo(0.5, 2);
  });

  it('does not record skipped decisions', () => {
    const cats: HabitsMap = {};
    const changes: AppliedChange[] = [];
    applyUpdates(
      cats,
      [{ category: 'TS', rule: 'noise', decision: 'skip', matched_habit_id: '', reasoning: '' }],
      { sessionId: 's1', changes },
    );
    expect(changes).toHaveLength(0);
  });

  it('is a no-op for callers that omit the collector (backward compatible)', () => {
    const cats: HabitsMap = {};
    const [newCount] = applyUpdates(
      cats,
      [{ category: 'TS', rule: 'Use strict mode', decision: 'create', matched_habit_id: '', reasoning: '' }],
      { sessionId: 's1' },
    );
    expect(newCount).toBe(1);
  });
});

describe('formatStopSummary', () => {
  it('lists newly proposed habits with their category and rule', () => {
    const out = formatStopSummary(emptyResult({
      newCount: 1,
      changes: [{ category: 'Conditionals', rule: 'Prefer ternary operators', decision: 'create', confidence: 0.5 }],
    }));
    expect(out).toContain('1 new habit');
    expect(out).toContain('[Conditionals] Prefer ternary operators');
  });


  it('shows reinforced habits with their resulting confidence percentage', () => {
    const out = formatStopSummary(emptyResult({
      updatedCount: 1,
      changes: [{ category: 'Testing', rule: 'Setup/teardown in tests', decision: 'reinforce', confidence: 0.6 }],
    }));
    expect(out).toContain('reinforced 1');
    expect(out).toContain('[Testing] Setup/teardown in tests -> 60%');
  });

  it('shows contradicted habits distinctly from reinforced ones', () => {
    const out = formatStopSummary(emptyResult({
      updatedCount: 1,
      changes: [{ category: 'Imports', rule: 'Review unnecessary imports', decision: 'contradict', confidence: 0.45 }],
    }));
    expect(out).toContain('contradicted 1');
    expect(out).toContain('[Imports] Review unnecessary imports -> 45%');
  });

  it('reports decay and tombstone tail counts', () => {
    const out = formatStopSummary(emptyResult({ decayed: 2, tombstoned: 1 }));
    expect(out).toContain('2 decayed from inactivity');
    expect(out).toContain('1 tombstoned');
  });

  it('shows reinforced memory candidates in formatStopSummary', () => {
    const out = formatStopSummary(emptyResult({
      memoryCandidatesUpdated: 1,
      updatedMemories: ['Avoid global variables in helper.ts'],
    }));
    expect(out).toContain('reinforced 1 memory candidate');
    expect(out).toContain('Avoid global variables in helper.ts');
  });

  it('renders an explicit no-change line when nothing happened', () => {
    const out = formatStopSummary(emptyResult());
    expect(out).toContain('cc-habits: 0 signals captured · 0 habits learning · cch view for details');
  });

  it('always points the user to `cch view`', () => {
    const out = formatStopSummary(emptyResult({
      changes: [{ category: 'TS', rule: 'Use strict mode', decision: 'create', confidence: 0.5 }],
    }));
    expect(out).toContain('cch view for details');
  });

  it('contains no ANSI escape codes (hook stderr is piped, not a TTY)', () => {
    const out = formatStopSummary(emptyResult({
      changes: [
        { category: 'TS', rule: 'Use strict mode', decision: 'create', confidence: 0.5 },
        { category: 'Testing', rule: 'Setup/teardown', decision: 'reinforce', confidence: 0.6 },
        { category: 'Imports', rule: 'Review imports', decision: 'contradict', confidence: 0.45 },
      ],
      decayed: 1,
      tombstoned: 1,
    }));
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });
});
