import { NormalizedHookInput } from './index';

// Kimi Code CLI (~/.kimi/config.toml hooks) sends Claude-Code-shaped JSON on
// stdin: { tool_name, tool_input: { file_path, content, old_string, new_string },
// session_id }. Its file tools are named WriteFile and StrReplaceFile, so we map
// them onto the canonical Write/Edit names the diff builder understands.
function canonicalToolName(name: string): string {
  if (name === 'WriteFile' || name === 'write_file') return 'Write';
  if (name === 'StrReplaceFile' || name === 'str_replace' || name === 'replace') return 'Edit';
  return name || 'Edit';
}

export function fromKimi(raw: any): NormalizedHookInput {
  const toolInput = (raw.tool_input ?? raw.toolInput ?? {}) as Record<string, any>;
  const toolName = canonicalToolName(String(raw.tool_name ?? raw.tool ?? raw.toolName ?? ''));

  const filePath = String(toolInput.file_path ?? toolInput.path ?? raw.file ?? '');
  const oldContent = toolInput.old_string !== undefined ? String(toolInput.old_string) : undefined;
  const newContent = toolInput.new_string !== undefined
    ? String(toolInput.new_string)
    : (toolInput.content !== undefined ? String(toolInput.content) : undefined);
  const diff = raw.diff !== undefined ? String(raw.diff) : undefined;
  const sessionId = String(raw.session_id ?? raw.sessionId ?? '');

  return {
    toolName,
    filePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'kimi'
  };
}
