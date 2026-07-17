import { NormalizedHookInput } from './index';

export function fromAntigravity(raw: any): NormalizedHookInput {
  const toolCall = (raw.toolCall ?? {}) as Record<string, any>;
  const toolInput = (toolCall.arguments ?? {}) as Record<string, any>;
  
  const toolName = String(toolCall.name ?? '');
  const sessionId = String(raw.session_id ?? raw.sessionId ?? '');
  const rawFilePath = String(toolInput.file_path ?? toolInput.path ?? toolInput.filePath ?? '');
  
  const oldContent = toolInput.old_string !== undefined ? String(toolInput.old_string) : (toolInput.oldContent !== undefined ? String(toolInput.oldContent) : undefined);
  const newContent = toolInput.new_string !== undefined ? String(toolInput.new_string) : (toolInput.newContent !== undefined ? String(toolInput.newContent) : (toolInput.content !== undefined ? String(toolInput.content) : undefined));
  const diff = raw.diff !== undefined ? String(raw.diff) : undefined;

  const edits = Array.isArray(toolInput.edits)
    ? toolInput.edits.map((raw: any) => {
        const e = (raw && typeof raw === 'object') ? raw : {};
        return {
          old_string: e.old_string !== undefined ? String(e.old_string) : undefined,
          new_string: e.new_string !== undefined ? String(e.new_string) : undefined,
        };
      })
    : undefined;

  return {
    toolName,
    filePath: rawFilePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'antigravity',
    edits
  };
}
