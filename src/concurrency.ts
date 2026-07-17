// Bounded-concurrency async mapper.
//
// Promise.all fans every item out at once, which is fine for cheap I/O but
// dangerous when each item spawns a child process (git diff, file reads): on a
// large commit this hit 100+ concurrent processes and risked FD/PID exhaustion
// on constrained CI. This caps the in-flight work at `limit` while preserving
// the input order of the results, so callers that depended on ordering (e.g.
// "newest-file-last" capture logs) keep behaving deterministically.
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => run()));
  return results;
}
