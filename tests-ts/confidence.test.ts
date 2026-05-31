import { describe, it, expect } from 'vitest';
import { applyUpdates, INITIAL, REINFORCE_DELTA, CONTRADICT_DELTA, PRUNE_THRESHOLD, CONFIDENCE_CAP } from '../src/confidence';
import type { HabitsMap } from '../src/storage';

function makeHabit(rule: string, confidence: number, reinforcing = 1, contradicting = 0): HabitsMap {
  return {
    Python: [{
      rule,
      confidence,
      reinforcing,
      contradicting,
      first_learned: '2026-05-18',
      last_updated: '2026-05-18',
    }],
  };
}

describe('confidence', () => {
  it('creates a new habit at INITIAL confidence', () => {
    const cats: HabitsMap = {};
    applyUpdates(cats, [{
      category: 'Python',
      rule: 'Use type hints',
      decision: 'create',
      matched_habit_id: '',
      reasoning: 'test',
    }]);
    expect(cats['Python']).toHaveLength(1);
    expect(cats['Python'][0].confidence).toBe(INITIAL);
    expect(cats['Python'][0].reinforcing).toBe(1);
  });

  it('reinforce increases confidence by REINFORCE_DELTA', () => {
    const cats = makeHabit('Use type hints', INITIAL, 1, 0);
    applyUpdates(cats, [{
      category: 'Python',
      rule: 'Use type hints',
      decision: 'reinforce',
      matched_habit_id: 'Use type hints',
      reasoning: 'seen again',
    }]);
    expect(cats['Python'][0].confidence).toBeCloseTo(INITIAL + REINFORCE_DELTA);
    expect(cats['Python'][0].reinforcing).toBe(2);
  });

  it('contradict decreases confidence by CONTRADICT_DELTA', () => {
    const cats = makeHabit('Use type hints', INITIAL, 1, 0);
    applyUpdates(cats, [{
      category: 'Python',
      rule: 'Use type hints',
      decision: 'contradict',
      matched_habit_id: 'Use type hints',
      reasoning: 'violated',
    }]);
    expect(cats['Python'][0].confidence).toBeCloseTo(INITIAL - CONTRADICT_DELTA);
    expect(cats['Python'][0].contradicting).toBe(1);
  });

  it('confidence is capped at CONFIDENCE_CAP', () => {
    const cats = makeHabit('Use type hints', 0.94, 15, 0);
    applyUpdates(cats, [{
      category: 'Python',
      rule: 'Use type hints',
      decision: 'reinforce',
      matched_habit_id: 'Use type hints',
      reasoning: '',
    }]);
    expect(cats['Python'][0].confidence).toBeLessThanOrEqual(CONFIDENCE_CAP);
  });

  it('habit is pruned when confidence drops below PRUNE_THRESHOLD', () => {
    // 0.50 → 0.40 → 0.30 → 0.20 (pruned)
    const cats = makeHabit('Use type hints', INITIAL, 1, 0);
    const contradict = {
      category: 'Python',
      rule: 'Use type hints',
      decision: 'contradict',
      matched_habit_id: 'Use type hints',
      reasoning: '',
    };
    applyUpdates(cats, [contradict]); // 0.40
    applyUpdates(cats, [contradict]); // 0.30, survives (>= threshold)
    applyUpdates(cats, [contradict]); // 0.20, pruned
    expect(cats['Python']).toBeUndefined();
  });

  it('confidence floor is 0.0 before pruning', () => {
    // A habit starting at 0.0 should be pruned (0.0 < 0.30)
    const cats: HabitsMap = {
      Python: [{
        rule: 'Some rule',
        confidence: 0.0,
        reinforcing: 0,
        contradicting: 5,
        first_learned: '2026-05-18',
        last_updated: '2026-05-18',
      }],
    };
    applyUpdates(cats, [{
      category: 'Python',
      rule: 'Some rule',
      decision: 'contradict',
      matched_habit_id: 'Some rule',
      reasoning: '',
    }]);
    expect(cats['Python']).toBeUndefined();
  });

  it('skip decision is ignored', () => {
    const cats: HabitsMap = {};
    applyUpdates(cats, [{
      category: 'Python',
      rule: 'Whatever',
      decision: 'skip',
      matched_habit_id: '',
      reasoning: '',
    }]);
    expect(Object.keys(cats)).toHaveLength(0);
  });
});
