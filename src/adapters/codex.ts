import { NormalizedHookInput } from './index';

export function fromCodex(raw: any): NormalizedHookInput {
  const toolName = String(raw.tool_name ?? raw.tool ?? 'Edit');
  const filePath = String(raw.file_path ?? raw.path ?? raw.file ?? '');
  const oldContent = raw.old_string !== undefined ? String(raw.old_string) : undefined;
  const newContent = raw.new_string !== undefined ? String(raw.new_string) : (raw.content !== undefined ? String(raw.content) : undefined);
  const diff = raw.diff !== undefined ? String(raw.diff) : undefined;
  const sessionId = String(raw.session_id ?? raw.session ?? '');

  return {
    toolName,
    filePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'codex'
  };
}
