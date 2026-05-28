import { fromClaudeCode } from './claude';
import { fromGemini } from './gemini';
import { fromCodex } from './codex';

export interface NormalizedHookInput {
  toolName: string;
  filePath: string;
  oldContent?: string;
  newContent?: string;
  diff?: string;
  sessionId: string;
  source?: 'claude-code' | 'gemini' | 'codex';
  edits?: Array<{ old_string?: string; new_string?: string }>;
}

const ALLOWED_ADAPTERS = new Set(['claude-code', 'gemini', 'codex']);

export function normalizeInput(raw: unknown, adapter: string): NormalizedHookInput {
  if (!ALLOWED_ADAPTERS.has(adapter)) {
    throw new Error(`Unsupported or invalid adapter: ${adapter}. Allowed adapters: claude-code, gemini, codex`);
  }
  const r = (raw ?? {}) as any;
  switch (adapter) {
    case 'gemini':  return fromGemini(r);
    case 'codex':   return fromCodex(r);
    default:        return fromClaudeCode(r);
  }
}
