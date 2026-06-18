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

// Groq's free tier caps each request by tokens-per-minute (TPM), not by body
// size: llama-3.3-70b-versatile allows ~12,000 tokens/minute and returns HTTP
// 413 when a single request exceeds it. ~12k tokens is roughly 40 KB of text,
// and after the prompt template, habits.md, and the 1k-token completion
// reservation that leaves room for about 20 KB of diff content. The default
// 140 KB budget (tuned for Anthropic/OpenAI/Ollama body limits) is far over
// that, so Groq needs its own, much smaller budget. Groq paid tiers also fit
// comfortably under this cap; the only cost there is fewer signals per batch.
export const MAX_BATCH_BYTES_GROQ = 20_000;

// Resolve the diff byte budget for the configured provider. Only Groq's tight
// per-minute token limit needs the smaller budget; everything else keeps the
// generous default. Unknown/undefined providers fall back to the default.
export function byteBudgetFor(provider?: string): number {
  return provider === 'groq' ? MAX_BATCH_BYTES_GROQ : MAX_BATCH_BYTES;
}

// Cap a signal batch to at most MAX_BATCH_SIGNALS entries AND at most maxBytes
// of total diff content. Walks newest-first so the most recent signals always
// survive; always keeps at least one signal even if a single diff exceeds the
// byte budget.
export function capBatchCore(signals: Signal[], maxBytes: number = MAX_BATCH_BYTES): Signal[] {
  const countCapped = signals.slice(-MAX_BATCH_SIGNALS);
  let byteTotal = 0;
  let byteIdx = countCapped.length;
  for (let i = countCapped.length - 1; i >= 0; i--) {
    const len = (countCapped[i]!.diff ?? '').length;
    if (byteTotal + len > maxBytes && byteTotal > 0) break;
    byteTotal += len;
    byteIdx = i;
  }
  return countCapped.slice(byteIdx);
}

// CLI-facing wrapper: returns the capped batch plus a human-readable description
// of how it was trimmed, for the sync/bootstrap log line.
export function capBatch(signals: Signal[], maxBytes: number = MAX_BATCH_BYTES): { batch: Signal[]; desc: string } {
  const batch = capBatchCore(signals, maxBytes);
  const total = signals.length;
  const sent = batch.length;
  if (sent === total) return { batch, desc: `${total}` };
  return { batch, desc: `${sent} of ${total} (capped to fit provider limits)` };
}
