import { logError } from './storage';

// Hook payload contract monitoring (T1).
//
// Claude Code does not version its hook payload schema and changes fields
// silently (verified against the official hooks reference, 2026-06). cc-habits
// reads these payloads, so a silent schema change can break capture without any
// visible error. This module provides a lightweight, fail-open contract check:
// it validates that each event's critical fields are present and logs drift,
// but it NEVER throws and NEVER blocks a session.
//
// We intentionally do NOT validate nested fields or types. Claude Code adds
// optional top-level fields frequently (permission_mode, effort, agent_id, ...),
// so deep validation would produce constant false positives. We check only the
// few fields whose absence actually breaks extraction.

// Internal event names cc-habits is invoked with (argv[2] of the hook binary).
// These are the names WE register in the tool config, not Claude Code's event
// names, so they are stable regardless of upstream renames.
export const HANDLED_EVENTS = new Set([
  'post-tool-use',
  'stop',
  'user-prompt-submit',
  'session-start',
]);

// Events cc-habits knows about but deliberately does not act on. `subagent-stop`
// is here because Claude Code does NOT fire PostToolUse for subagent tool calls
// (anthropics/claude-code#34692, closed as not-planned), so there are no subagent
// signals to extract, and SubagentStop shares the parent session_id whose signals
// the main Stop already handles. Subagent edits are instead captured via the
// git-capture path when committed. Routing it to extraction would only re-extract
// the parent session and inflate confidence, so it is a deliberate no-op.
export const KNOWN_UNSUPPORTED_EVENTS = new Set([
  'subagent-stop',
]);

// Critical top-level fields per event. Absence means extraction cannot proceed
// meaningfully for the claude-code adapter. `session_id` accepts documented
// aliases. Other adapters (gemini/codex/kimi/cline) use a different vocabulary
// and normalize separately, so contract checks are scoped to claude-code.
const REQUIRED_FIELDS: Record<string, string[]> = {
  'post-tool-use': ['tool_name', 'tool_input'],
  'stop': ['session_id'],
  'user-prompt-submit': ['prompt'],
  'session-start': ['session_id'],
};

const FIELD_ALIASES: Record<string, string[]> = {
  session_id: ['session_id', 'sessionId', 'session'],
};

export interface PayloadValidation {
  ok: boolean;
  missing: string[];
}

function hasField(data: Record<string, unknown>, field: string): boolean {
  const candidates = FIELD_ALIASES[field] ?? [field];
  return candidates.some(key => {
    const v = data[key];
    return v !== undefined && v !== null && v !== '';
  });
}

// Validate a parsed hook payload against the critical-field contract for its
// event. Scoped to the claude-code adapter; other adapters always pass because
// they normalize through their own code path. Never throws.
export function validatePayload(
  event: string,
  data: Record<string, unknown>,
  adapter: string = 'claude-code',
): PayloadValidation {
  if (adapter !== 'claude-code') return { ok: true, missing: [] };
  const required = REQUIRED_FIELDS[event] ?? [];
  const missing = required.filter(field => !hasField(data, field));
  return { ok: missing.length === 0, missing };
}

// Log a contract violation to error.log. Best-effort, never throws.
export function logSchemaWarning(event: string, missing: string[]): void {
  logError(
    `schema: ${event} payload missing required field(s): ${missing.join(', ')}. ` +
    'The Claude Code hook schema may have changed, see anthropics/claude-code hooks reference.',
  );
}

// Log invocation with an event name cc-habits does not recognize at all. This is
// the early-warning signal that Claude Code introduced or renamed an event we
// should support. Best-effort, never throws.
export function logUnknownEvent(event: string): void {
  logError(
    `schema: unrecognized hook event '${event}' invoked. ` +
    'cc-habits may need an update to handle a new Claude Code hook event.',
  );
}
