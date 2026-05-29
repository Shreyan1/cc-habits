import { NormalizedHookInput } from './index';

// Gemini CLI delivers AfterTool/BeforeTool payloads with snake_case keys:
//   { tool_name, tool_input: { file_path, content, old_string, new_string }, session_id }
// We still accept the older camelCase/flat shapes as fallbacks so the adapter
// stays tolerant if Gemini's payload changes.
export function fromGemini(raw: any): NormalizedHookInput {
  const input = (raw.tool_input ?? raw.toolInput ?? raw) as Record<string, any>;

  const toolName = String(raw.tool_name ?? raw.tool ?? raw.toolName ?? 'Edit');
  const filePath = String(input.file_path ?? input.path ?? raw.file ?? raw.filePath ?? '');

  const oldRaw = input.old_string ?? input.oldContent ?? raw.oldContent;
  const oldContent = oldRaw !== undefined ? String(oldRaw) : undefined;

  // write_file sends `content`; replace/edit send `new_string`.
  const newRaw = input.content ?? input.new_string ?? input.newContent ?? raw.newContent;
  const newContent = newRaw !== undefined ? String(newRaw) : undefined;

  const diffRaw = raw.diff ?? raw.patch ?? input.diff ?? input.patch;
  const diff = diffRaw !== undefined ? String(diffRaw) : undefined;

  const sessionId = String(raw.session_id ?? raw.sessionId ?? raw.session ?? '');

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
