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
  },
});
