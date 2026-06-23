import { NormalizedHookInput } from './index';

// Codex CLI emits Claude-Code-shaped hook payloads: the edit fields live nested
// under `tool_input` (file_path / old_string / new_string / content / edits),
// not at the top level. Earlier versions of this adapter read the top level and
// silently captured empty diffs. We unwrap `tool_input` first, then fall back to
// top-level keys so older or alternate payload shapes still parse.
export function fromCodex(raw: any): NormalizedHookInput {
  const toolInput = (raw.tool_input ?? {}) as Record<string, any>;

  const toolName = String(raw.tool_name ?? raw.tool ?? 'Edit');
  const filePath = String(
    toolInput.file_path ?? toolInput.path ?? toolInput.file ??
    raw.file_path ?? raw.path ?? raw.file ?? '',
  );

  const pickOld = toolInput.old_string ?? raw.old_string;
  const oldContent = pickOld !== undefined ? String(pickOld) : undefined;

  const pickNew = toolInput.new_string ?? toolInput.content ?? raw.new_string ?? raw.content;
  const newContent = pickNew !== undefined ? String(pickNew) : undefined;

  const diff = raw.diff !== undefined ? String(raw.diff) : undefined;
  const sessionId = String(raw.session_id ?? raw.session ?? '');

  // Multi-edit tools (Codex apply_patch / MultiEdit) carry an edits array.
  const rawEdits = Array.isArray(toolInput.edits) ? toolInput.edits : undefined;
  const edits = rawEdits?.map((raw: any) => {
    const e = (raw && typeof raw === 'object') ? raw : {};
    return {
      old_string: e.old_string !== undefined ? String(e.old_string) : undefined,
      new_string: e.new_string !== undefined ? String(e.new_string) : undefined,
    };
  });

  return {
    toolName,
    filePath,
    oldContent,
    newContent,
    diff,
    sessionId,
    source: 'codex',
    edits,
  };
}
