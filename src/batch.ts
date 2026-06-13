import type { Signal } from './storage';

// Signal batching limits, shared by the Stop hook (hook.ts) and the CLI
// sync/bootstrap path (cli.ts). Keep these in one place: Groq and some other
// providers return 413 when the request body exceeds their hard limit, so a
// count cap alone is not enough when diffs are large (e.g. committing big files).
export const MAX_BATCH_SIGNALS = 50;
// The byte budget below counts diff content only. The extraction prompt template,
// the current habits.md, and the rejected-rules block all add more on top of it, so
// keep a generous margin under Groq's ~200 KB request limit rather than packing the
// batch to the edge (which still 413'd once habits.md and the prompt were added in).
export const MAX_BATCH_BYTES = 140_000; // diff bytes; leaves ~60 KB for prompt + habits

// Cap a signal batch to at most MAX_BATCH_SIGNALS entries AND at most
// MAX_BATCH_BYTES of total diff content. Walks newest-first so the most recent
// signals always survive; always keeps at least one signal even if a single
// diff exceeds the byte budget.
export function capBatchCore(signals: Signal[]): Signal[] {
  const countCapped = signals.slice(-MAX_BATCH_SIGNALS);
  let byteTotal = 0;
  let byteIdx = countCapped.length;
  for (let i = countCapped.length - 1; i >= 0; i--) {
    const len = (countCapped[i]!.diff ?? '').length;
    if (byteTotal + len > MAX_BATCH_BYTES && byteTotal > 0) break;
    byteTotal += len;
    byteIdx = i;
  }
  return countCapped.slice(byteIdx);
}

// CLI-facing wrapper: returns the capped batch plus a human-readable description
// of how it was trimmed, for the sync/bootstrap log line.
export function capBatch(signals: Signal[]): { batch: Signal[]; desc: string } {
  const batch = capBatchCore(signals);
  const total = signals.length;
  const sent = batch.length;
  if (sent === total) return { batch, desc: `${total}` };
  return { batch, desc: `${sent} of ${total} (capped to fit provider limits)` };
}
