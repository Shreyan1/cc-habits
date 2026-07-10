import { NormalizedHookInput } from './index';

export function fromAntigravity(raw: any): NormalizedHookInput {
  const toolCall = raw.toolCall || {};
  const toolName = String(toolCall.name ?? raw.toolName ?? 'Edit');
  const toolInput = toolCall.arguments ?? toolCall.args ?? raw.toolInput ?? raw.tool_input ?? raw;

  const filePath = String(
    toolInput.TargetFile ?? toolInput.file_path ?? toolInput.path ?? toolInput.file ??
    raw.file_path ?? raw.path ?? raw.file ?? ''
  );

  const oldContent = toolInput.TargetContent ?? toolInput.old_string ?? raw.old_string;
  const newContent = toolInput.ReplacementContent ?? toolInput.CodeContent ?? toolInput.new_string ?? toolInput.content ?? raw.new_string ?? raw.content;

  const diff = raw.diff !== undefined ? String(raw.diff) : undefined;
  const sessionId = String(raw.session_id ?? raw.sessionId ?? raw.session ?? '');

  const rawEdits = Array.isArray(toolInput.ReplacementChunks) ? toolInput.ReplacementChunks : Array.isArray(toolInput.edits) ? toolInput.edits : undefined;
  const edits = rawEdits?.map((rawEdit: any) => {
    const e = (rawEdit && typeof rawEdit === 'object') ? rawEdit : {};
    return {
      old_string: e.TargetContent !== undefined ? String(e.TargetContent) : e.old_string !== undefined ? String(e.old_string) : undefined,
      new_string: e.ReplacementContent !== undefined ? String(e.ReplacementContent) : e.new_string !== undefined ? String(e.new_string) : undefined,
    };
  });

  return {
    toolName,
    filePath,
    oldContent: oldContent !== undefined ? String(oldContent) : undefined,
    newContent: newContent !== undefined ? String(newContent) : undefined,
    diff,
    sessionId,
    source: 'antigravity',
    edits,
  };
}
