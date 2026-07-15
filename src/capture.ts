import { redact, isNoise, detectLanguage, MAX_DIFF_BYTES } from './hook';
import { sanitizeFilePath, appendSignal, Signal } from './storage';

export interface CaptureOptions {
  file: string;
  diff: string;
  session?: string;
  source?: string;
}

export function captureFromCli(opts: CaptureOptions): boolean {
  const rawFile = opts.file.trim();
  if (!rawFile) return false;

  const file = sanitizeFilePath(rawFile);
  let diff = redact(opts.diff);

  if (!diff || isNoise(diff)) {
    return false;
  }

  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + '\n... (truncated)';
  }

  const language = detectLanguage(file);
  const sessionId = opts.session?.trim() || `cli-${Date.now()}`;
  const source = (opts.source?.trim() || 'cli') as Signal['source'];

  const signal: Signal = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    type: 'edit',
    file,
    diff,
    ...(language ? { language } : {}),
    source,
  };

  appendSignal(signal);
  return true;
}
