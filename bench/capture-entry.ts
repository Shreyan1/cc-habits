/**
 * Bench entry: exposes a single capture call over the real hook path so the
 * benchmark can time the in-process capture work (normalize + redact + append)
 * in isolation, without Node startup or module-load noise in the timed region.
 *
 * Bundled on demand by bench/run.mjs via esbuild; not shipped in dist.
 */
import { normalizeInput } from '../src/adapters';
import { processPostToolUse } from '../src/hook';

/** Run one full capture (normalize the raw payload, then process it). */
export function captureOnce(raw: Record<string, unknown>): void {
  const normalized = normalizeInput(raw, 'claude-code');
  processPostToolUse(normalized);
}
