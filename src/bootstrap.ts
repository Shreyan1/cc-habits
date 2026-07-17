import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import {
  storagePaths, readHabitsMd, parseHabits, writeHabitsMd, serialiseHabits,
  writeSnapshot, appendHistory, ensureDirs, getPaths, type StorageContext
} from './storage';
import { buildDiff, redact, isNoise, detectLanguage, buildDiffFromNormalized } from './hook';
import { sanitizeFilePath } from './storage';
import { applyUpdates } from './confidence';
import { extractRules } from './extractor';
import type { Signal } from './storage';
import { fromCodex } from './adapters/codex';
import { fromGemini } from './adapters/gemini';
import { writePreferencesFile } from './sync';
import { mapWithConcurrencyLimit } from './concurrency';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_BOOTSTRAP_SIGNALS = 40;
const BOOTSTRAPPED_FILE = '.bootstrapped.json';

export interface BootstrapResult {
  sessionsFound: number;
  sessionsWithEdits: number;
  signalsExtracted: number;
  habitsLearned: number;
  habitsReinforced: number;
  categories: string[];
}

export interface SessionFile {
  sessionId: string;
  filePath: string;
  tool: 'claude-code' | 'codex' | 'gemini' | 'kimi';
}

async function existsAsync(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryAsync(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// Claude Code stores project sessions at ~/.claude/projects/<encoded-path>/
// where <encoded-path> is the absolute project directory with / replaced by -.
function encodeProjectPath(absPath: string): string {
  let normalized = absPath.replace(/\\/g, '/');
  normalized = normalized.replace(/^([a-zA-Z]):/, '$1');
  return normalized.replace(/\//g, '-');
}

function bootstrappedPath(ctx?: StorageContext): string {
  return path.join(getPaths(ctx).habitsDir, BOOTSTRAPPED_FILE);
}

function readBootstrapped(ctx?: StorageContext): Set<string> {
  const p = bootstrappedPath(ctx);
  if (!fs.existsSync(p)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    if (Array.isArray(data)) return new Set(data.filter((x): x is string => typeof x === 'string'));
  } catch { /* ignore */ }
  return new Set();
}

function writeBootstrapped(ids: string[], ctx?: StorageContext): void {
  const existing = readBootstrapped(ctx);
  ids.forEach(id => existing.add(id));
  ensureDirs(ctx);
  fs.writeFileSync(bootstrappedPath(ctx), JSON.stringify([...existing], null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

async function readFirstLine(filePath: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let resolved = false;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!resolved) {
        resolved = true;
        resolve(line);
        rl.close();
        stream.destroy();
      }
    });
    rl.on('error', () => {
      if (!resolved) {
        resolved = true;
        resolve('');
        rl.close();
        stream.destroy();
      }
    });
    rl.on('close', () => {
      if (!resolved) {
        resolved = true;
        resolve('');
      }
    });
  });
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!(await existsAsync(dir))) return results;
  try {
    const list = await fs.promises.readdir(dir);
    // Bounded pool: a deep session tree can contain thousands of entries, and
    // firing every stat/readdir at once can exhaust FDs on constrained hosts.
    const subResults = await mapWithConcurrencyLimit(
      list,
      16,
      async (file) => {
        const filePath = path.join(dir, file);
        try {
          if (await isDirectoryAsync(filePath)) {
            return await findJsonlFiles(filePath);
          } else if (file.endsWith('.jsonl')) {
            return [filePath];
          }
        } catch { /* ignore */ }
        return [];
      }
    );
    for (const r of subResults) results.push(...r);
  } catch {
    // ignore
  }
  return results;
}

async function findWireJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!(await existsAsync(dir))) return results;
  try {
    const list = await fs.promises.readdir(dir);
    const subResults = await mapWithConcurrencyLimit(
      list,
      16,
      async (file) => {
        const filePath = path.join(dir, file);
        try {
          if (await isDirectoryAsync(filePath)) {
            return await findWireJsonlFiles(filePath);
          } else if (file === 'wire.jsonl') {
            return [filePath];
          }
        } catch { /* ignore */ }
        return [];
      }
    );
    for (const r of subResults) results.push(...r);
  } catch {
    // ignore
  }
  return results;
}

function isProjectSubpath(targetCwd: string, projectDir: string): boolean {
  try {
    let resolvedCwd = path.resolve(targetCwd);
    let resolvedProj = path.resolve(projectDir);
    if (process.platform === 'win32') {
      resolvedCwd = resolvedCwd.toLowerCase();
      resolvedProj = resolvedProj.toLowerCase();
    }
    return resolvedCwd === resolvedProj || resolvedCwd.startsWith(resolvedProj + path.sep);
  } catch {
    return false;
  }
}

export async function discoverSessions(projectDir?: string): Promise<SessionFile[]> {
  const cwd = projectDir ?? process.cwd();
  const resolvedProj = path.resolve(cwd);
  const sessions: SessionFile[] = [];

  // 1. Claude Code
  const encoded = encodeProjectPath(resolvedProj);
  const claudeDir = path.join(CLAUDE_PROJECTS_DIR, encoded);
  if (await existsAsync(claudeDir) && await isDirectoryAsync(claudeDir)) {
    try {
      const files = (await fs.promises.readdir(claudeDir)).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        sessions.push({
          sessionId: f.replace('.jsonl', ''),
          filePath: path.join(claudeDir, f),
          tool: 'claude-code',
        });
      }
    } catch { /* ignore */ }
  }

  // 2. Gemini CLI
  const geminiTmpDir = path.join(os.homedir(), '.gemini', 'tmp');
  if (await existsAsync(geminiTmpDir) && await isDirectoryAsync(geminiTmpDir)) {
    try {
      const subdirs = await fs.promises.readdir(geminiTmpDir);
      const found = await mapWithConcurrencyLimit(
        subdirs,
        16,
        async (dir) => {
          const subpath = path.join(geminiTmpDir, dir);
          if (!(await isDirectoryAsync(subpath))) return [] as SessionFile[];
          const projectRootFile = path.join(subpath, '.project_root');
          if (!(await existsAsync(projectRootFile))) return [] as SessionFile[];
          const content = (await fs.promises.readFile(projectRootFile, 'utf-8')).trim();
          if (content && isProjectSubpath(content, resolvedProj)) {
            const chatsDir = path.join(subpath, 'chats');
            if (await existsAsync(chatsDir) && await isDirectoryAsync(chatsDir)) {
              const files = (await fs.promises.readdir(chatsDir)).filter(f => f.endsWith('.jsonl'));
              return files.map(f => ({
                sessionId: f.replace('.jsonl', ''),
                filePath: path.join(chatsDir, f),
                tool: 'gemini' as const,
              }));
            }
          }
          return [] as SessionFile[];
        }
      );
      for (const group of found) sessions.push(...group);
    } catch { /* ignore */ }
  }

  // 3. Codex CLI
  const codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (await existsAsync(codexSessionsDir) && await isDirectoryAsync(codexSessionsDir)) {
    try {
      const jsonlFiles = await findJsonlFiles(codexSessionsDir);
      const found = await mapWithConcurrencyLimit(
        jsonlFiles,
        16,
        async (filePath) => {
          const firstLine = await readFirstLine(filePath);
          if (!firstLine) return null;
          try {
            const obj = JSON.parse(firstLine);
            if (obj.type === 'session_meta' && obj.payload) {
              const sessionCwd = obj.payload.cwd;
              if (sessionCwd && isProjectSubpath(sessionCwd, resolvedProj)) {
                const baseName = path.basename(filePath);
                return {
                  sessionId: baseName.replace('.jsonl', ''),
                  filePath,
                  tool: 'codex' as const,
                };
              }
            }
          } catch { /* ignore */ }
          return null;
        }
      );
      for (const s of found) if (s) sessions.push(s);
    } catch { /* ignore */ }
  }

  // 4. Kimi Code CLI
  const kimiDirs = [
    process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi'),
    process.env['KIMI_CODE_HOME'] || path.join(os.homedir(), '.kimi-code'),
  ];
  for (const kimiDir of [...new Set(kimiDirs)]) {
    const indexFile = path.join(kimiDir, 'session_index.jsonl');
    if (await existsAsync(indexFile)) {
      try {
        const content = await fs.promises.readFile(indexFile, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            const workDir = obj.workDir ?? obj.work_dir ?? obj.cwd;
            const sessionId = obj.sessionId ?? obj.session_id;
            if (workDir && sessionId && isProjectSubpath(workDir, resolvedProj)) {
              let sessionDir = obj.sessionDir ?? obj.session_dir;
              if (sessionDir) {
                const resolvedSessionDir = path.isAbsolute(sessionDir) ? sessionDir : path.resolve(kimiDir, sessionDir);
                const wirePath = path.join(resolvedSessionDir, 'agents', 'main', 'wire.jsonl');
                if (await existsAsync(wirePath)) {
                  sessions.push({
                    sessionId,
                    filePath: wirePath,
                    tool: 'kimi',
                  });
                }
              }
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    // Fallback: scan sessions/ directories directly if index is missing or doesn't have all entries
    const sessionsDir = path.join(kimiDir, 'sessions');
    if (await existsAsync(sessionsDir) && await isDirectoryAsync(sessionsDir)) {
      try {
        const wireFiles = await findWireJsonlFiles(sessionsDir);
        const found = await mapWithConcurrencyLimit(
          wireFiles,
          16,
          async (wirePath) => {
            const sessionDir = path.dirname(path.dirname(path.dirname(wirePath)));
            const statePath = path.join(sessionDir, 'state.json');
            if (!(await existsAsync(statePath))) return null;
            try {
              const stateObj = JSON.parse(await fs.promises.readFile(statePath, 'utf-8'));
              const workDir = stateObj.workDir ?? stateObj.work_dir ?? stateObj.cwd;
              if (workDir && isProjectSubpath(workDir, resolvedProj)) {
                const sessionId = path.basename(sessionDir);
                if (!sessions.some(s => s.sessionId === sessionId)) {
                  return { sessionId, filePath: wirePath, tool: 'kimi' as const };
                }
              }
            } catch { /* ignore */ }
            return null;
          }
        );
        for (const s of found) if (s) sessions.push(s);
      } catch { /* ignore */ }
    }
  }

  return sessions;
}

export async function extractSignalsFromTranscript(
  transcriptPath: string,
  sessionId: string,
  tool: 'claude-code' | 'codex' | 'gemini' | 'kimi' = 'claude-code'
): Promise<Signal[]> {
  const signals: Signal[] = [];
  if (!(await existsAsync(transcriptPath))) return [];

  try {
    const fileStream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (tool === 'claude-code' || tool === 'kimi') {
        if (obj['type'] !== 'assistant') continue;

        const msg = obj['message'] as Record<string, unknown> | undefined;
        if (!msg) continue;
        const blocks = msg['content'] as unknown[];
        if (!Array.isArray(blocks)) continue;

        for (const block of blocks) {
          const b = block as Record<string, unknown>;
          if (b['type'] !== 'tool_use') continue;

          let toolName = String(b['name'] ?? '');
          if (toolName === 'WriteFile' || toolName === 'write_file') {
            toolName = 'Write';
          } else if (toolName === 'StrReplaceFile' || toolName === 'str_replace' || toolName === 'replace') {
            toolName = 'Edit';
          }

          if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') continue;

          const toolInput = (b['input'] ?? {}) as Record<string, unknown>;
          const rawPath = String(toolInput['file_path'] ?? toolInput['path'] ?? '');
          const safePath = sanitizeFilePath(rawPath);

          let diff = buildDiff(toolName, safePath, toolInput);
          if (!diff || isNoise(diff)) continue;
          diff = redact(diff);

          const language = detectLanguage(safePath);
          const ts = String(obj['timestamp'] ?? new Date().toISOString());

          signals.push({
            ts,
            session_id: sessionId,
            type: 'edit',
            file: redact(safePath),
            diff,
            ...(language ? { language } : {}),
          });
        }
      } else if (tool === 'gemini') {
        if (obj['type'] === 'gemini' && Array.isArray(obj['toolCalls'])) {
          for (const call of obj['toolCalls']) {
            const toolName = String(call['name'] ?? '');
            if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'replace_file_content' && toolName !== 'modify_file') continue;

            const rawInput = {
              tool_name: toolName,
              tool_input: call['args'] ?? {},
              session_id: sessionId,
            };

            const norm = fromGemini(rawInput);
            const safePath = sanitizeFilePath(norm.filePath);
            if (!safePath) continue;

            let diff = buildDiffFromNormalized(norm);
            if (!diff || isNoise(diff)) continue;
            diff = redact(diff);

            const language = detectLanguage(safePath);
            const ts = String(obj['timestamp'] ?? new Date().toISOString());

            signals.push({
              ts,
              session_id: sessionId,
              type: 'edit',
              file: redact(safePath),
              diff,
              ...(language ? { language } : {}),
            });
          }
        }
      } else if (tool === 'codex') {
        const payload = obj['payload'] as Record<string, unknown> | undefined;
        const isFunctionCall = obj['type'] === 'function_call' || (obj['type'] === 'response_item' && payload?.['type'] === 'function_call');
        if (isFunctionCall) {
          const call = (obj['type'] === 'function_call' ? obj : payload) as Record<string, unknown>;
          const toolName = String(call['name'] ?? call['tool'] ?? '');
          if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_file_content' || toolName === 'modify_file' || toolName === 'create_file') {
            let args: Record<string, unknown> = {};
            try {
              const argsStr = String(call['arguments'] ?? '{}');
              args = JSON.parse(argsStr) as Record<string, unknown>;
            } catch {
              // ignore
            }

            const rawInput = {
              tool: toolName,
              tool_name: toolName,
              file_path: args['file_path'] ?? args['path'] ?? args['file'],
              content: args['content'],
              old_string: args['old_string'],
              new_string: args['new_string'],
              diff: args['diff'],
              session_id: sessionId
            };

            const norm = fromCodex(rawInput);
            const safePath = sanitizeFilePath(norm.filePath);
            if (!safePath) continue;

            let diff = buildDiffFromNormalized(norm);
            if (!diff || isNoise(diff)) continue;
            diff = redact(diff);

            const language = detectLanguage(safePath);
            const ts = String(obj['timestamp'] ?? new Date().toISOString());

            signals.push({
              ts,
              session_id: sessionId,
              type: 'edit',
              file: redact(safePath),
              diff,
              ...(language ? { language } : {}),
            });
          }
        }
      }
    }
  } catch {
    return [];
  }

  return signals;
}

export async function bootstrap(opts?: {
  projectDir?: string;
  maxSignals?: number;
  ctx?: StorageContext;
}): Promise<BootstrapResult> {
  const ctx = opts?.ctx;
  const sessions = await discoverSessions(opts?.projectDir);
  const alreadyDone = readBootstrapped(ctx);
  const newSessions = sessions.filter(s => !alreadyDone.has(s.sessionId));

  const empty: BootstrapResult = {
    sessionsFound: sessions.length,
    sessionsWithEdits: 0,
    signalsExtracted: 0,
    habitsLearned: 0,
    habitsReinforced: 0,
    categories: [],
  };

  if (newSessions.length === 0) return empty;

  const allSignals: Signal[] = [];
  let sessionsWithEdits = 0;
  const processedIds: string[] = [];

  for (const session of newSessions) {
    const sigs = await extractSignalsFromTranscript(session.filePath, session.sessionId, session.tool);
    if (sigs.length > 0) sessionsWithEdits++;
    allSignals.push(...sigs);
    processedIds.push(session.sessionId);
  }

  const cap = opts?.maxSignals ?? MAX_BOOTSTRAP_SIGNALS;
  const capped = allSignals.length > cap ? allSignals.slice(-cap) : allSignals;

  if (capped.length < 3) {
    writeBootstrapped(processedIds, ctx);
    return { ...empty, sessionsFound: sessions.length, sessionsWithEdits, signalsExtracted: capped.length };
  }

  const habitsMd = readHabitsMd(ctx);
  const cats = parseHabits(habitsMd);

  const updates = await extractRules(capped, habitsMd);
  const [newCount, updatedCount] = applyUpdates(cats, updates, {
    sessionId: `bootstrap-${Date.now()}`,
  });

  // Graduate bootstrapped habits immediately if signals spanned 2+ sessions.
  // This is defensible: the patterns genuinely appeared across distinct sessions.
  const distinctSessions = new Set(capped.map(s => s.session_id)).size;
  if (distinctSessions >= 2) {
    for (const habits of Object.values(cats)) {
      for (const h of habits) {
        if (h.sessions_seen === 1 && h.last_session_id?.startsWith('bootstrap-')) {
          h.sessions_seen = Math.min(distinctSessions, 4);
        }
      }
    }
  }

  const serialised = serialiseHabits(cats);
  writeHabitsMd(serialised, ctx);
  writePreferencesFile(ctx);
  writeSnapshot(cats, ctx);
  appendHistory({ ts: new Date().toISOString(), session_id: 'bootstrap', habits_md: serialised }, ctx);
  writeBootstrapped(processedIds, ctx);

  return {
    sessionsFound: sessions.length,
    sessionsWithEdits,
    signalsExtracted: capped.length,
    habitsLearned: newCount,
    habitsReinforced: updatedCount,
    categories: [...new Set(Object.keys(cats))],
  };
}
