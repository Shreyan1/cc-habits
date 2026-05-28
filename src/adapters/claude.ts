import { NormalizedHookInput } from './index';

export function fromClaudeCode(raw: any): NormalizedHookInput {
  const toolName = String(raw.tool_name ?? '');
  const toolInput = (raw.tool_input ?? {}) as Record<string, any>;
  const sessionId = String(raw.session_id ?? '');
  const rawFilePath = String(toolInput.file_path ?? toolInput.path ?? '');
  const oldContent = toolInput.old_string !== undefined ? String(toolInput.old_string) : undefined;
  const newContent = toolInput.new_string !== undefined ? String(toolInput.new_string) : (toolInput.content !== undefined ? String(toolInput.content) : undefined);
  const diff = raw.diff !== undefined ? String(raw.diff) : undefined;

  const edits = Array.isArray(toolInput.edits)
    ? toolInput.edits.map((e: any) => ({
        old_string: e.old_string !== undefined ? String(e.old_string) : undefined,
        new_string: e.new_string !== undefined ? String(e.new_string) : undefined,
      }))
    : undefined;

  return {
    toolName,
    filePath: rawFilePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'claude-code',
    edits
  };
}
