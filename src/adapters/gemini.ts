import { NormalizedHookInput } from './index';

export function fromGemini(raw: any): NormalizedHookInput {
  const toolName = String(raw.tool ?? raw.toolName ?? 'Edit');
  const filePath = String(raw.file ?? raw.path ?? raw.filePath ?? '');
  const oldContent = raw.oldContent !== undefined ? String(raw.oldContent) : undefined;
  const newContent = raw.newContent !== undefined ? String(raw.newContent) : undefined;
  const diff = raw.diff !== undefined ? String(raw.diff) : (raw.patch !== undefined ? String(raw.patch) : undefined);
  const sessionId = String(raw.sessionId ?? raw.session_id ?? raw.session ?? '');

  return {
    toolName,
    filePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'gemini'
  };
}
