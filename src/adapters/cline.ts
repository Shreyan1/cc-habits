import { NormalizedHookInput } from './index';

// Cline / RooCode PostToolUse payload shape:
//   { tool, parameters: {...}, result, success, durationMs,
//     clineVersion, hookName, timestamp, taskId, workspaceRoots, userId }
// File tools: write_to_file { path, content }, replace_in_file { path, diff }.
export function fromCline(raw: any): NormalizedHookInput {
  const rawTool = String(raw.tool ?? raw.tool_name ?? '');
  const params = (raw.parameters ?? raw.tool_input ?? raw.params ?? {}) as Record<string, any>;

  const filePath = String(params.path ?? params.file_path ?? params.file ?? raw.path ?? '');
  const sessionId = String(raw.taskId ?? raw.task_id ?? raw.sessionId ?? raw.session_id ?? '');

  // replace_in_file carries SEARCH/REPLACE blocks in `diff`; write_to_file carries full `content`.
  const diff = params.diff !== undefined ? String(params.diff) : (raw.diff !== undefined ? String(raw.diff) : undefined);
  const newContent = params.content !== undefined ? String(params.content)
    : (params.new_string !== undefined ? String(params.new_string) : undefined);
  const oldContent = params.old_string !== undefined ? String(params.old_string) : undefined;

  const toolName = rawTool === 'write_to_file' || rawTool === 'new_file' ? 'Write'
    : rawTool === 'replace_in_file' ? 'Edit'
    : (rawTool || 'Edit');

  return {
    toolName,
    filePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'cline'
  };
}
