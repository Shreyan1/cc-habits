import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests-ts/**/*.test.ts'],
    // Pin default storage to a temp dir before any source module loads, then
    // clean it up after the suite. Makes every local run CI-faithful: tests can
    // never fall back to the real ~/.claude/habits. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.global.ts'],
    // Run tests serially, storage paths are module-level mutable state
    pool: 'forks',
    maxWorkers: 1,
    // Shuffle test and file order every run so a test that only passes because
    // of leftover state from whatever ran before it (a module-level cache, an
    // unreset mock) fails loudly instead of hiding until CI happens to reorder.
    // Vitest logs the seed on failure; rerun with `--sequence.seed=<seed>` to
    // reproduce a specific failing order locally.
    sequence: {
      shuffle: true,
    },
    // Explicit, not just the default: a test that only passes on retry is
    // reporting a real bug (usually shared state), not noise to paper over.
    // Never raise this to make a flaky suite look green.
    retry: 0,
  },
});
