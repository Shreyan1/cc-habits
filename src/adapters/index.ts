import { fromClaudeCode } from './claude';
import { fromGemini } from './gemini';
import { fromCodex } from './codex';
import { fromCline } from './cline';
import { fromKimi } from './kimi';

export interface NormalizedHookInput {
  toolName: string;
  filePath: string;
  oldContent?: string;
  newContent?: string;
  diff?: string;
  sessionId: string;
  source?: 'claude-code' | 'gemini' | 'codex' | 'cline' | 'kimi';
  edits?: Array<{ old_string?: string; new_string?: string }>;
}

export const ALLOWED_ADAPTERS = new Set(['claude-code', 'gemini', 'codex', 'cline', 'kimi']);

export function normalizeInput(raw: unknown, adapter: string): NormalizedHookInput {
  if (!ALLOWED_ADAPTERS.has(adapter)) {
    throw new Error(`Unsupported or invalid adapter: ${adapter}. Allowed adapters: ${[...ALLOWED_ADAPTERS].join(', ')}`);
  }
  const r = (raw ?? {}) as any;
  switch (adapter) {
    case 'gemini':      return fromGemini(r);
    case 'codex':       return fromCodex(r);
    case 'cline':       return fromCline(r);
    case 'kimi':        return fromKimi(r);
    default:            return fromClaudeCode(r);
  }
}
