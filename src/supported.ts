// Single source of truth for which coding tools cc-habits supports and how.
// Used by the `cc-habits tools` command and covered by tests so the list cannot
// silently drift from the adapters and hook registrations.

export interface SupportedTool {
  id: string;
  name: string;
  // How edits are captured into signals.
  capture: string;
  // How learned habits are injected back into the tool's context.
  inject: string;
}

export const SUPPORTED_TOOLS: SupportedTool[] = [
  { id: 'claude-code', name: 'Claude Code', capture: 'hooks (PostToolUse, Stop, UserPromptSubmit, SessionStart)', inject: 'CLAUDE.md @import + UserPromptSubmit' },
  { id: 'gemini',      name: 'Gemini CLI',  capture: 'hooks (AfterTool, AfterAgent, BeforeAgent, SessionStart)', inject: 'GEMINI.md @import' },
  { id: 'codex',       name: 'Codex CLI',   capture: 'hooks (PostToolUse, UserPromptSubmit)', inject: 'AGENTS.md sync' },
  { id: 'kimi',        name: 'Kimi Code CLI', capture: 'hooks (PostToolUse, Stop, UserPromptSubmit, SessionStart)', inject: 'AGENTS.md sync' },
  { id: 'cursor',      name: 'Cursor',      capture: 'Git commits (or VS Code extension)', inject: '.cursor rules sync' },
  { id: 'cline',       name: 'Cline/RooCode', capture: 'hooks (PostToolUse, Stop)', inject: '.clinerules sync' },
  { id: 'windsurf',    name: 'Windsurf',    capture: 'Git commits', inject: 'rules sync' },
  // Kilo Code has no hook API (its GitHub issue #5827 requesting hooks was
  // closed as not-planned), so capture is not supported, not "coming soon".
  // Injection works well: Kilo reads AGENTS.md natively, and cc-habits also
  // writes .kilo/rules/cch.md and .kilocode/rules/cch.md directly.
  { id: 'kilo',        name: 'Kilo Code',   capture: 'not supported (no hook API)', inject: 'AGENTS.md @import + .kilo/.kilocode rules sync' },
  { id: 'git',         name: 'Any Git workflow', capture: 'git-capture (commits)', inject: 'AGENTS.md sync' },
];

// Adapter ids that have a dedicated hook adapter (used to assert parity in tests).
export const HOOK_ADAPTERS = ['claude-code', 'gemini', 'codex', 'cline', 'kimi', 'antigravity'];
