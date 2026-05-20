import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests-ts/**/*.test.ts'],
    // Run tests serially — storage paths are module-level mutable state
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
