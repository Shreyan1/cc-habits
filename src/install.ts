import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from './storage';

// Mutable so tests can redirect to temp directories.
// habitsMdPath / importLine are kept in sync with storagePaths.preferencesFile so
// that CC_HABITS_DIR overrides flow through to the @import line in CLAUDE.md.
export const installPaths = {
  claudeDir: path.join(os.homedir(), '.claude'),
  settingsFile: path.join(os.homedir(), '.claude', 'settings.json'),
  claudeMd: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  habitsMdPath: storagePaths.preferencesFile,
  importLine: `@import ${storagePaths.preferencesFile}`,
};

export interface InstallContext {
  claudeDir: string;
  settingsFile: string;
  claudeMd: string;
  habitsMdPath: string;
  importLine: string;
}

export function getInstallPaths(ctx?: InstallContext): InstallContext {
  return ctx || installPaths;
}

// Scenario 1 fix: resolve the absolute path to cc-habits-hook at init time.
// If installed via nvm, bare "cc-habits-hook" may not be on PATH in non-interactive
// subshells. Using the absolute path stored at init time avoids this entirely.
export function resolveHookBinaryPath(): string {
  const selfPath = path.resolve(process.argv[1]);
  const binDir = path.dirname(selfPath);
  const hookPath = path.join(binDir, 'cc-habits-hook');
  if (fs.existsSync(hookPath)) return hookPath;
  return 'cc-habits-hook'; // fallback for test/dev environments
}

function makeHooks(hookBin: string): { postToolUse: object; stop: object; userPromptSubmit: object; sessionStart: object } {
  // Quote the binary path to handle spaces (e.g. /Users/my name/.../.bin/cc-habits-hook).
  // Escape any embedded double-quotes in the path itself before wrapping.
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;
  return {
    postToolUse: {
      matcher: 'Write|Edit|MultiEdit',
      hooks: [{ type: 'command', command: `${safeBin} post-tool-use --adapter claude-code || true` }],
    },
    stop: {
      hooks: [{ type: 'command', command: `${safeBin} stop --adapter claude-code || true` }],
    },
    // UserPromptSubmit re-injects active habits into context each prompt (Patch 2).
    // No matcher, this event always fires.
    userPromptSubmit: {
      hooks: [{ type: 'command', command: `${safeBin} user-prompt-submit --adapter claude-code || true` }],
    },
    // SessionStart prints a one-line "N habits active this session" banner so the
    // developer can see how many learned habits are guiding the session.
    sessionStart: {
      hooks: [{ type: 'command', command: `${safeBin} session-start --adapter claude-code || true` }],
    },
  };
}

function loadSettings(ctx?: InstallContext): Record<string, unknown> {
  const paths = getInstallPaths(ctx);
  if (fs.existsSync(paths.settingsFile)) {
    try {
      return JSON.parse(fs.readFileSync(paths.settingsFile, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      process.stderr.write(
        'cc-habits: warning: settings.json could not be parsed; starting with empty config.\n',
      );
    }
  }
  return {};
}

function saveSettings(settings: Record<string, unknown>, ctx?: InstallContext): void {
  const paths = getInstallPaths(ctx);
  const filePath = paths.settingsFile;
  fs.mkdirSync(paths.claudeDir, { recursive: true });
  // Symlink guard: refuse to overwrite settings.json if it's a symlink. An attacker
  // who pre-places a symlink could redirect our hook registration into another file.
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${filePath}`);
  }
  // Atomic write: temp file in same directory, then rename.
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

function hookAlreadyRegistered(hooksList: unknown[], command: string): boolean {
  for (const entry of hooksList) {
    const e = entry as Record<string, unknown>;
    const hooks = (e['hooks'] ?? []) as Array<Record<string, unknown>>;
    if (hooks.some(h => h['command'] === command)) return true;
  }
  return false;
}

function cleanOldHabitsHooks(hooksList: unknown[]): unknown[] {
  return hooksList.filter(entry => {
    const e = entry as Record<string, unknown>;
    const subHooks = (e['hooks'] ?? []) as Array<Record<string, unknown>>;
    return !subHooks.some(h => typeof h['command'] === 'string' && h['command'].includes('cc-habits-hook'));
  });
}

export function makeHooksForTest(hookBin: string): { postToolUse: object; stop: object; userPromptSubmit: object; sessionStart: object } {
  return makeHooks(hookBin);
}

export interface HookRegistration {
  postAdded: boolean;
  stopAdded: boolean;
  promptAdded: boolean;
  // Optional so registrations that have no SessionStart event (Codex/Cline) can omit it.
  sessionStartAdded?: boolean;
}

export function registerHooks(hookBin?: string, ctx?: InstallContext): HookRegistration {
  const bin = hookBin ?? resolveHookBinaryPath();
  const { postToolUse, stop, userPromptSubmit, sessionStart } = makeHooks(bin);
  const postCmd = (postToolUse as { hooks: Array<{ command: string }> }).hooks[0].command;
  const stopCmd = (stop as { hooks: Array<{ command: string }> }).hooks[0].command;
  const promptCmd = (userPromptSubmit as { hooks: Array<{ command: string }> }).hooks[0].command;
  const sessionStartCmd = (sessionStart as { hooks: Array<{ command: string }> }).hooks[0].command;

  const settings = loadSettings(ctx);
  if (!settings['hooks']) settings['hooks'] = {};
  const hooks = settings['hooks'] as Record<string, unknown[]>;
  if (!hooks['PostToolUse']) hooks['PostToolUse'] = [];
  if (!hooks['Stop']) hooks['Stop'] = [];
  if (!hooks['UserPromptSubmit']) hooks['UserPromptSubmit'] = [];
  if (!hooks['SessionStart']) hooks['SessionStart'] = [];

  let postAdded = false;
  let stopAdded = false;
  let promptAdded = false;
  let sessionStartAdded = false;

  if (!hookAlreadyRegistered(hooks['PostToolUse'], postCmd)) {
    hooks['PostToolUse'] = cleanOldHabitsHooks(hooks['PostToolUse']);
    hooks['PostToolUse'].push(postToolUse);
    postAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['Stop'], stopCmd)) {
    hooks['Stop'] = cleanOldHabitsHooks(hooks['Stop']);
    hooks['Stop'].push(stop);
    stopAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['UserPromptSubmit'], promptCmd)) {
    hooks['UserPromptSubmit'] = cleanOldHabitsHooks(hooks['UserPromptSubmit']);
    hooks['UserPromptSubmit'].push(userPromptSubmit);
    promptAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['SessionStart'], sessionStartCmd)) {
    hooks['SessionStart'] = cleanOldHabitsHooks(hooks['SessionStart']);
    hooks['SessionStart'].push(sessionStart);
    sessionStartAdded = true;
  }

  saveSettings(settings, ctx);
  return { postAdded, stopAdded, promptAdded, sessionStartAdded };
}

// Read-only hook detection. Returns true if ANY cc-habits hook entry is present
// in settings.json without mutating anything. Uses the same cc-habits-hook marker
// string as cleanOldHabitsHooks (install.ts:115), no parallel logic invented.
export function areHooksRegistered(ctx?: InstallContext): boolean {
  try {
    const settings = loadSettings(ctx); // loadSettings is private; valid as same-module access
    const hooks = settings['hooks'] as Record<string, unknown[]> | undefined;
    if (!hooks) return false;
    const marker = 'cc-habits-hook';
    const check = (list: unknown[] = []): boolean =>
      list.some(entry => {
        const hs = ((entry as Record<string, unknown>)['hooks'] as Array<Record<string, unknown>>) ?? [];
        return hs.some(h => typeof h['command'] === 'string' && (h['command'] as string).includes(marker));
      });
    return check(hooks['PostToolUse']) || check(hooks['Stop']) || check(hooks['UserPromptSubmit']);
  } catch { return false; }
}

export interface RegisteredHook {
  event: string;
  command: string;
}

// Where a tool's cc-habits hooks actually live on disk. Most tools store them in
// the settings file we detected, but Codex writes a sidecar hooks.json and Cline
// uses one shell file per event. Returning the real path(s) lets the CLI prove to
// the user exactly which file changed, instead of merely asserting it did.
export function hookProofPaths(toolId: string, settingsPath: string): string[] {
  if (toolId === 'claude-code') return [installPaths.settingsFile];
  if (toolId === 'codex') return [path.join(path.dirname(settingsPath), 'hooks.json')];
  if (toolId === 'cline') return [path.join(settingsPath, 'PostToolUse'), path.join(settingsPath, 'Stop')];
  return [settingsPath];
}

// Read back the cc-habits hook entries currently present in a settings file, so
// the CLI can show real proof (the bytes on disk) rather than echoing intent.
// Format-agnostic: JSON settings (Claude/Gemini/Codex) are parsed structurally;
// TOML (Kimi) and shell hook files (Cline) are scanned line by line. Never throws.
export function readRegisteredHooks(filePath: string): RegisteredHook[] {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: RegisteredHook[] = [];

  if (raw.trimStart().startsWith('{')) {
    try {
      const json = JSON.parse(raw) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>;
      };
      const hooks = json.hooks ?? {};
      for (const event of Object.keys(hooks)) {
        for (const entry of hooks[event] ?? []) {
          for (const h of entry.hooks ?? []) {
            if (typeof h.command === 'string' && h.command.includes('cc-habits-hook')) {
              out.push({ event, command: h.command });
            }
          }
        }
      }
      return out;
    } catch {
      // Not valid JSON, fall through to the line scan below.
    }
  }

  // TOML [[hooks]] blocks (event/command keys) or shell hook files (Cline). The
  // event for a shell file is its name, so fall back to the file basename.
  let currentEvent = '';
  for (const line of raw.split('\n')) {
    const evMatch = line.match(/^\s*event\s*=\s*['"]([^'"]+)['"]/);
    if (evMatch) {
      currentEvent = evMatch[1] ?? '';
      continue;
    }
    if (line.includes('cc-habits-hook')) {
      const cmdMatch = line.match(/command\s*=\s*['"](.+)['"]\s*$/);
      const command = cmdMatch ? cmdMatch[1]! : line.trim();
      out.push({ event: currentEvent || path.basename(filePath), command });
    }
  }
  return out;
}

function atomicWriteText(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

export function addImportToClaudeMd(ctx?: InstallContext): boolean {
  const paths = getInstallPaths(ctx);
  const importLine = paths.importLine;
  const filePath = paths.claudeMd;
  // Symlink guard: CLAUDE.md could be symlinked to another file by an attacker.
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${filePath}`);
  }
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(importLine)) return false;
    atomicWriteText(filePath, content.trimEnd() + `\n\n${importLine}\n`);
  } else {
    fs.mkdirSync(paths.claudeDir, { recursive: true });
    atomicWriteText(filePath, `${importLine}\n`);
  }
  return true;
}

import { execFileSync } from 'child_process';

/**
 * Absolute path to the cc-habits binary, resolved at install time.
 *
 * Same reasoning as resolveHookBinaryPath above: a git hook runs in a
 * non-interactive shell, and a GUI git client runs it with a minimal PATH, so
 * a bare `cc-habits` is not reliably resolvable even when it is installed.
 */
export function resolveGitBinaryPath(): string {
  // argv[1] is absent when the module is loaded outside a CLI entry point
  // (`node -e`, some test runners). Resolving undefined throws, and the callers
  // below treat any throw as a failed install, so fall back to the bare name.
  const self = process.argv[1];
  if (!self) return 'cc-habits';
  const binPath = path.join(path.dirname(path.resolve(self)), 'cc-habits');
  return fs.existsSync(binPath) ? binPath : 'cc-habits'; // fallback for test/dev environments
}

/**
 * The single post-commit line cc-habits owns.
 *
 * Two things beyond calling the binary:
 *  - `command -v` guards the call. Calling it bare printed
 *    `cc-habits: command not found` on every commit once the binary was
 *    uninstalled or moved, which reads as a broken repo and is pure noise: if
 *    there is no binary there is nothing to capture.
 *  - stdout and stderr are discarded and the line ends in `|| true`, so capture
 *    can never fail, slow, or clutter a commit.
 *
 * Kept to one line on purpose: install detection and uninstall both work by
 * matching and filtering single lines, see isOwnedHookLine.
 */
function gitHookCommand(): string {
  // Quote the path to survive spaces, escaping embedded quotes first, exactly
  // as makeHooks does for the Claude hook commands.
  const bin = `"${resolveGitBinaryPath().replace(/"/g, '\\"')}"`;
  return `command -v ${bin} >/dev/null 2>&1 && ${bin} git-capture >/dev/null 2>&1 || true`;
}

/**
 * True for any post-commit line cc-habits owns.
 *
 * Matches on the subcommand rather than the binary name, so it still recognizes
 * hooks written by older versions (`cc-habits git-capture || true`,
 * `cch git-capture || true`) as well as the absolute-path form above.
 */
function isOwnedHookLine(line: string): boolean {
  return /(^|[\s"'/])(cc-habits|cch)["']?\s+git-capture(\s|$)/.test(line);
}

/**
 * Rewrite a hook body so any cc-habits line written by an older version becomes
 * the current guarded one. Returns null when nothing needs to change, so the
 * caller can skip the write entirely.
 */
function upgradeHookBody(content: string): string | null {
  const current = gitHookCommand();
  const lines = content.split('\n');
  const owned = lines.filter(isOwnedHookLine);
  if (owned.length === 0) return null;
  if (owned.length === 1 && owned[0] === current) return null;

  // Collapse to a single current line, keeping the position of the first one so
  // any surrounding lines the user added stay in their original order.
  let seen = false;
  const out: string[] = [];
  for (const line of lines) {
    if (!isOwnedHookLine(line)) { out.push(line); continue; }
    if (!seen) { out.push(current); seen = true; }
  }
  return out.join('\n');
}

export function installLocalGitHook(): 'installed' | 'already' | 'failed' {
  try {
    if (!fs.existsSync('.git')) return 'failed';

    const stat = fs.statSync('.git');
    let hooksDir = '';
    if (stat.isDirectory()) {
      hooksDir = path.join('.git', 'hooks');
    } else {
      try {
        const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf-8' }).trim();
        hooksDir = path.join(gitDir, 'hooks');
      } catch {
        return 'failed';
      }
    }

    fs.mkdirSync(hooksDir, { recursive: true });
    const hookFile = path.join(hooksDir, 'post-commit');
    const command = gitHookCommand();

    // A cloned repo could plant .git/hooks/post-commit as a symlink to a
    // sensitive file; refuse to read or write through it, and use O_NOFOLLOW on
    // the writes so a link swapped in after the check is rejected atomically.
    const oNoFollow: number = (fs.constants as Record<string, number>)['O_NOFOLLOW'] ?? 0;
    let fd: number | null = null;
    try {
      // Try to open the existing hook file for reading and writing.
      // If it doesn't exist, this throws ENOENT.
      fd = fs.openSync(hookFile, fs.constants.O_RDWR | oNoFollow);

      // Best-effort symlink check on Windows where O_NOFOLLOW is a no-op
      if (!oNoFollow && fs.lstatSync(hookFile).isSymbolicLink()) {
        fs.closeSync(fd);
        return 'failed';
      }

      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        fs.closeSync(fd);
        return 'failed';
      }

      const buf = Buffer.alloc(st.size);
      let readBytes = 0;
      if (st.size > 0) {
        readBytes = fs.readSync(fd, buf, 0, st.size, 0);
      }
      const content = buf.subarray(0, readBytes).toString('utf-8');
      const upgraded = upgradeHookBody(content);
      if (upgraded !== null) {
        // A hook from an older version: rewrite it in place through the same
        // fd, so the symlink guarantees above still hold. Truncate first, since
        // the new body can be shorter than the old one.
        const body = Buffer.from(upgraded, 'utf-8');
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, body, 0, body.length, 0);
        fs.closeSync(fd);
        return 'installed';
      }
      if (content.split('\n').some(isOwnedHookLine)) {
        fs.closeSync(fd);
        return 'already';
      }

      fs.writeSync(fd, `\n${command}\n`, st.size);
      fs.closeSync(fd);
      return 'installed';
    } catch (e: any) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (e && e.code === 'ENOENT') {
        // Create fresh hook file atomically
        let writeFd: number | null = null;
        try {
          writeFd = fs.openSync(hookFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | oNoFollow, 0o755);
          fs.writeSync(writeFd, `#!/bin/sh\n${command}\n`);
          return 'installed';
        } catch {
          return 'failed';
        } finally {
          if (writeFd !== null) {
            try { fs.closeSync(writeFd); } catch {}
          }
        }
      }
      return 'failed';
    }
  } catch {
    return 'failed';
  }
}

export function installGlobalGitTemplateHook(): 'installed' | 'already' | 'failed' {
  try {
    const templateDir = path.join(os.homedir(), '.git-templates');
    const hooksDir = path.join(templateDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const hookFile = path.join(hooksDir, 'post-commit');
    const command = gitHookCommand();

    let result: 'installed' | 'already' = 'installed';
    if (fs.existsSync(hookFile)) {
      const content = fs.readFileSync(hookFile, 'utf-8');
      const upgraded = upgradeHookBody(content);
      if (upgraded !== null) {
        fs.writeFileSync(hookFile, upgraded, { mode: 0o755 });
      } else if (content.split('\n').some(isOwnedHookLine)) {
        result = 'already';
      } else {
        fs.appendFileSync(hookFile, `\n${command}\n`);
      }
    } else {
      fs.writeFileSync(hookFile, `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    }

    // execFileSync with an argument array, never a shell string, so a home dir
    // containing shell metacharacters ($(...), backticks, ...) cannot trigger
    // command substitution. Replaces the previous double-quoted execSync.
    execFileSync('git', ['config', '--global', 'init.templateDir', templateDir]);
    return result;
  } catch {
    return 'failed';
  }
}

// Gemini CLI uses a different hook-event taxonomy than Claude Code. We still
// invoke the same internal cc-habits events (post-tool-use/stop/user-prompt-submit)
// but they must live under Gemini's event keys (AfterTool/AfterAgent/BeforeAgent)
// and match Gemini's own tool names (write_file/replace), otherwise Gemini
// silently ignores the unknown keys and no hook ever fires.
const GEMINI_POST_EVENT = 'AfterTool';
const GEMINI_STOP_EVENT = 'AfterAgent';
const GEMINI_PROMPT_EVENT = 'BeforeAgent';
const GEMINI_SESSION_START_EVENT = 'SessionStart';
const GEMINI_EDIT_MATCHER = 'write_file|replace|edit';

export function registerJsonHooks(targetFile: string, toolId: string, hookBin: string): HookRegistration {
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;

  const postCmd = `${safeBin} post-tool-use --adapter ${toolId} || true`;
  const stopCmd = `${safeBin} stop --adapter ${toolId} || true`;
  const promptCmd = `${safeBin} user-prompt-submit --adapter ${toolId} || true`;
  const sessionStartCmd = `${safeBin} session-start --adapter ${toolId} || true`;

  let settings: Record<string, any> = {};
  if (fs.existsSync(targetFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    } catch {
      // warn or default
    }
  }

  if (!settings['hooks']) settings['hooks'] = {};
  const hooks = settings['hooks'] as Record<string, unknown[]>;
  if (!hooks[GEMINI_POST_EVENT]) hooks[GEMINI_POST_EVENT] = [];
  if (!hooks[GEMINI_STOP_EVENT]) hooks[GEMINI_STOP_EVENT] = [];
  if (!hooks[GEMINI_PROMPT_EVENT]) hooks[GEMINI_PROMPT_EVENT] = [];
  if (!hooks[GEMINI_SESSION_START_EVENT]) hooks[GEMINI_SESSION_START_EVENT] = [];

  let postAdded = false;
  let stopAdded = false;
  let promptAdded = false;
  let sessionStartAdded = false;

  const postHook = {
    matcher: GEMINI_EDIT_MATCHER,
    hooks: [{ type: 'command', command: postCmd }],
  };
  const stopHook = {
    hooks: [{ type: 'command', command: stopCmd }],
  };
  const promptHook = {
    hooks: [{ type: 'command', command: promptCmd }],
  };
  const sessionStartHook = {
    hooks: [{ type: 'command', command: sessionStartCmd }],
  };

  if (!hookAlreadyRegistered(hooks[GEMINI_POST_EVENT], postCmd)) {
    hooks[GEMINI_POST_EVENT] = cleanOldHabitsHooks(hooks[GEMINI_POST_EVENT]);
    hooks[GEMINI_POST_EVENT].push(postHook);
    postAdded = true;
  }
  if (!hookAlreadyRegistered(hooks[GEMINI_STOP_EVENT], stopCmd)) {
    hooks[GEMINI_STOP_EVENT] = cleanOldHabitsHooks(hooks[GEMINI_STOP_EVENT]);
    hooks[GEMINI_STOP_EVENT].push(stopHook);
    stopAdded = true;
  }
  if (!hookAlreadyRegistered(hooks[GEMINI_PROMPT_EVENT], promptCmd)) {
    hooks[GEMINI_PROMPT_EVENT] = cleanOldHabitsHooks(hooks[GEMINI_PROMPT_EVENT]);
    hooks[GEMINI_PROMPT_EVENT].push(promptHook);
    promptAdded = true;
  }
  if (!hookAlreadyRegistered(hooks[GEMINI_SESSION_START_EVENT], sessionStartCmd)) {
    hooks[GEMINI_SESSION_START_EVENT] = cleanOldHabitsHooks(hooks[GEMINI_SESSION_START_EVENT]);
    hooks[GEMINI_SESSION_START_EVENT].push(sessionStartHook);
    sessionStartAdded = true;
  }

  if (fs.existsSync(targetFile) && fs.lstatSync(targetFile).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${targetFile}`);
  }
  const tmpPath = `${targetFile}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, targetFile);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw e;
  }

  return { postAdded, stopAdded, promptAdded, sessionStartAdded };
}

// Encode a string as a TOML value. Prefer a literal (single-quote) string so
// backslashes in a Windows hook-binary path are not misread as escape sequences
// (a basic string would turn C:\Users into an invalid \U escape). Fall back to an
// escaped basic string only when the value itself contains a single quote or a
// control character, which a literal string cannot represent. F4 fix.
function tomlString(s: string): string {
  if (!/['\x00-\x1f]/.test(s)) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Codex CLI's hook event set (codex_protocol::protocol::HookEventName) is
// pre_tool_use / post_tool_use / user_prompt_submit / session_start /
// pre_compact / post_compact / subagent_{start,stop} / permission_request.
// There is NO `Stop` event, so the historical Stop hook never fired. We capture
// edits on PostToolUse and run the compile/learn pass on UserPromptSubmit, which
// fires at the start of each turn (flushing the prior turn's signals). Codex
// receives habit injection via AGENTS.md (cch sync), not via hook stdout, so the
// UserPromptSubmit hook points at the `stop` action (compile only, no inject).
export function registerCodexHooks(targetFile: string, hookBin: string): HookRegistration {
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;
  const postCmd = `${safeBin} post-tool-use --adapter codex || true`;
  const promptCmd = `${safeBin} stop --adapter codex || true`;

  const jsonFile = path.join(path.dirname(targetFile), 'hooks.json');
  let settings: Record<string, any> = {};

  if (fs.existsSync(jsonFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    } catch {
      // safe fallback
    }
  }

  if (!settings['hooks']) settings['hooks'] = {};
  const hooks = settings['hooks'] as Record<string, unknown[]>;
  if (!hooks['PostToolUse']) hooks['PostToolUse'] = [];
  if (!hooks['UserPromptSubmit']) hooks['UserPromptSubmit'] = [];

  // Remove any stale cc-habits Stop hook left by older versions. Codex never
  // fires Stop, so it was dead weight (and left disabled-untrusted state behind).
  if (Array.isArray(hooks['Stop'])) {
    hooks['Stop'] = cleanOldHabitsHooks(hooks['Stop']);
    if (hooks['Stop'].length === 0) delete hooks['Stop'];
  }

  let postAdded = false;
  let promptAdded = false;

  const postHook = { hooks: [{ type: 'command', command: postCmd }] };
  const promptHook = { hooks: [{ type: 'command', command: promptCmd }] };

  if (!hookAlreadyRegistered(hooks['PostToolUse'], postCmd)) {
    hooks['PostToolUse'] = cleanOldHabitsHooks(hooks['PostToolUse']);
    hooks['PostToolUse'].push(postHook);
    postAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['UserPromptSubmit'], promptCmd)) {
    hooks['UserPromptSubmit'] = cleanOldHabitsHooks(hooks['UserPromptSubmit']);
    hooks['UserPromptSubmit'].push(promptHook);
    promptAdded = true;
  }

  if (fs.existsSync(jsonFile) && fs.lstatSync(jsonFile).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${jsonFile}`);
  }
  const tmpPath = `${jsonFile}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, jsonFile);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw e;
  }

  return { postAdded, stopAdded: false, promptAdded };
}

// Kimi Code CLI uses ~/.kimi/config.toml with [[hooks]] array-of-tables. Each
// entry has event/command/matcher keys. Kimi follows Claude Code's event names
// (PostToolUse/Stop/UserPromptSubmit/SessionStart) but its own file-tool names
// (WriteFile/StrReplaceFile), so the PostToolUse matcher targets those.
const KIMI_EDIT_MATCHER = 'WriteFile|StrReplaceFile';

// Remove every cc-habits [[hooks]] block from a Kimi TOML config, preserving the
// preamble (everything before the first [[hooks]]) and any blocks the user or
// other tools added. Shared by the register path (de-dup before re-adding) and
// the deregister path. Splitting on '\n[[hooks]]' mirrors how we write blocks.
function stripKimiHabitsBlocks(content: string): string {
  return content
    .split('\n[[hooks]]')
    .filter((block, idx) => idx === 0 || !block.includes('cc-habits'))
    .join('\n[[hooks]]');
}

export function registerKimiHooks(targetFile: string, hookBin: string): HookRegistration {
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;
  const postCmd = `${safeBin} post-tool-use --adapter kimi || true`;
  const stopCmd = `${safeBin} stop --adapter kimi || true`;
  const promptCmd = `${safeBin} user-prompt-submit --adapter kimi || true`;
  const sessionStartCmd = `${safeBin} session-start --adapter kimi || true`;

  let content = '';
  if (fs.existsSync(targetFile)) {
    content = fs.readFileSync(targetFile, 'utf-8');
  }

  // Capture whether each hook was already present with the *current* binary path
  // before stripping, so the "registered" vs "already registered" report stays
  // honest on an idempotent re-run.
  const postAdded = !content.includes(postCmd);
  const stopAdded = !content.includes(stopCmd);
  const promptAdded = !content.includes(promptCmd);
  const sessionStartAdded = !content.includes(sessionStartCmd);

  // Drop any prior cc-habits blocks (possibly carrying a stale binary path) so we
  // re-add exactly one block per event rather than appending duplicates. Without
  // this, a re-init after the resolved hook path changed leaves 8+ Kimi hooks and
  // each edit fires twice. The JSON adapters get this via cleanOldHabitsHooks.
  content = stripKimiHabitsBlocks(content);

  const appendHook = (event: string, command: string, matcher?: string): void => {
    const matcherLine = matcher ? `matcher = ${tomlString(matcher)}\n` : '';
    content += `\n[[hooks]]\nevent = ${tomlString(event)}\n${matcherLine}command = ${tomlString(command)}\n`;
  };

  appendHook('PostToolUse', postCmd, KIMI_EDIT_MATCHER);
  appendHook('Stop', stopCmd);
  appendHook('UserPromptSubmit', promptCmd);
  appendHook('SessionStart', sessionStartCmd);

  if (fs.existsSync(targetFile) && fs.lstatSync(targetFile).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${targetFile}`);
  }
  const tmpPath = `${targetFile}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, targetFile);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw e;
  }

  return { postAdded, stopAdded, promptAdded, sessionStartAdded };
}

export function registerClineHooks(hooksDir: string, hookBin: string): HookRegistration {
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;
  const postCmd = `#!/bin/sh\n${safeBin} post-tool-use --adapter cline || true\n`;
  const stopCmd = `#!/bin/sh\n${safeBin} stop --adapter cline || true\n`;

  fs.mkdirSync(hooksDir, { recursive: true });
  const postFile = path.join(hooksDir, 'PostToolUse');
  const stopFile = path.join(hooksDir, 'Stop');

  if (fs.existsSync(postFile) && fs.lstatSync(postFile).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${postFile}`);
  }
  if (fs.existsSync(stopFile) && fs.lstatSync(stopFile).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${stopFile}`);
  }

  let postAdded = false;
  let stopAdded = false;

  if (!fs.existsSync(postFile)) {
    fs.writeFileSync(postFile, postCmd, { mode: 0o755 });
    postAdded = true;
  } else {
    const c = fs.readFileSync(postFile, 'utf-8');
    if (!c.includes('post-tool-use')) {
      fs.appendFileSync(postFile, `\n${safeBin} post-tool-use --adapter cline || true\n`);
      postAdded = true;
    }
  }

  if (!fs.existsSync(stopFile)) {
    fs.writeFileSync(stopFile, stopCmd, { mode: 0o755 });
    stopAdded = true;
  } else {
    const c = fs.readFileSync(stopFile, 'utf-8');
    if (!c.includes('stop')) {
      fs.appendFileSync(stopFile, `\n${safeBin} stop --adapter cline || true\n`);
      stopAdded = true;
    }
  }

  return { postAdded, stopAdded, promptAdded: false };
}

export function deregisterHooks(ctx?: InstallContext): { postRemoved: boolean; stopRemoved: boolean; promptRemoved: boolean; sessionStartRemoved: boolean } {
  const settings = loadSettings(ctx);
  if (!settings['hooks']) return { postRemoved: false, stopRemoved: false, promptRemoved: false, sessionStartRemoved: false };
  const hooks = settings['hooks'] as Record<string, unknown[]>;

  const cleanHook = (list: unknown[] | undefined): [unknown[], boolean] => {
    if (!list) return [[], false];
    const cleaned = cleanOldHabitsHooks(list);
    return [cleaned, cleaned.length !== list.length];
  };

  const [postCleaned, postRemoved] = cleanHook(hooks['PostToolUse']);
  const [stopCleaned, stopRemoved] = cleanHook(hooks['Stop']);
  const [promptCleaned, promptRemoved] = cleanHook(hooks['UserPromptSubmit']);
  const [sessionStartCleaned, sessionStartRemoved] = cleanHook(hooks['SessionStart']);

  hooks['PostToolUse'] = postCleaned;
  hooks['Stop'] = stopCleaned;
  hooks['UserPromptSubmit'] = promptCleaned;
  hooks['SessionStart'] = sessionStartCleaned;

  saveSettings(settings, ctx);
  return { postRemoved, stopRemoved, promptRemoved, sessionStartRemoved };
}

export function removeImportFromClaudeMd(ctx?: InstallContext): boolean {
  const paths = getInstallPaths(ctx);
  const importLine = paths.importLine;
  const filePath = paths.claudeMd;
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes(importLine)) return false;
  const cleaned = content.replace(importLine, '').trim();
  if (cleaned === '') {
    fs.unlinkSync(filePath);
  } else {
    atomicWriteText(filePath, cleaned + '\n');
  }
  return true;
}

export function uninstallLocalGitHook(): boolean {
  try {
    if (!fs.existsSync('.git')) return false;

    const stat = fs.statSync('.git');
    let hooksDir = '';
    if (stat.isDirectory()) {
      hooksDir = path.join('.git', 'hooks');
    } else {
      try {
        const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf-8' }).trim();
        hooksDir = path.join(gitDir, 'hooks');
      } catch {
        return false;
      }
    }

    const hookFile = path.join(hooksDir, 'post-commit');
    if (!fs.existsSync(hookFile)) return false;
    const content = fs.readFileSync(hookFile, 'utf-8');
    if (!content.includes('cc-habits') && !content.includes('cch')) return false;

    const lines = content.split('\n').filter(line => !isOwnedHookLine(line));

    const nonShebang = lines.filter(line => line.trim() && !line.startsWith('#!'));
    if (nonShebang.length === 0) {
      fs.unlinkSync(hookFile);
    } else {
      fs.writeFileSync(hookFile, lines.join('\n'), { mode: 0o755 });
    }
    return true;
  } catch {
    return false;
  }
}

export function uninstallGlobalGitTemplateHook(): boolean {
  try {
    const templateDir = path.join(os.homedir(), '.git-templates');
    const hookFile = path.join(templateDir, 'hooks', 'post-commit');
    if (!fs.existsSync(hookFile)) return false;
    const content = fs.readFileSync(hookFile, 'utf-8');
    if (!content.includes('cc-habits') && !content.includes('cch')) return false;

    const lines = content.split('\n').filter(line => !isOwnedHookLine(line));

    const nonShebang = lines.filter(line => line.trim() && !line.startsWith('#!'));
    if (nonShebang.length === 0) {
      fs.unlinkSync(hookFile);
      try {
        fs.rmdirSync(path.join(templateDir, 'hooks'));
        fs.rmdirSync(templateDir);
      } catch { /* best-effort */ }
    } else {
      fs.writeFileSync(hookFile, lines.join('\n'), { mode: 0o755 });
    }

    try {
      const current = execFileSync('git', ['config', '--global', 'init.templateDir'], { encoding: 'utf-8' }).trim();
      if (current === templateDir) {
        execFileSync('git', ['config', '--global', '--unset', 'init.templateDir']);
      }
    } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

export function deregisterJsonHooks(targetFile: string): HookRegistration {
  let settings: Record<string, any> = {};
  if (fs.existsSync(targetFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    } catch {
      return { postAdded: false, stopAdded: false, promptAdded: false };
    }
  }

  if (!settings['hooks']) return { postAdded: false, stopAdded: false, promptAdded: false };
  const hooks = settings['hooks'] as Record<string, unknown[]>;

  const clean = (event: string): boolean => {
    if (!hooks[event]) return false;
    const origLen = hooks[event].length;
    hooks[event] = cleanOldHabitsHooks(hooks[event]);
    return hooks[event].length !== origLen;
  };

  const postRemoved = clean(GEMINI_POST_EVENT) || clean('PostToolUse');
  const stopRemoved = clean(GEMINI_STOP_EVENT) || clean('Stop');
  const promptRemoved = clean(GEMINI_PROMPT_EVENT) || clean('UserPromptSubmit');
  const sessionStartRemoved = clean(GEMINI_SESSION_START_EVENT) || clean('SessionStart');

  if (postRemoved || stopRemoved || promptRemoved || sessionStartRemoved) {
    const tmpPath = `${targetFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, targetFile);
  }

  return {
    postAdded: postRemoved,
    stopAdded: stopRemoved,
    promptAdded: promptRemoved,
    sessionStartAdded: sessionStartRemoved,
  };
}

export function deregisterKimiHooks(targetFile: string): boolean {
  if (!fs.existsSync(targetFile)) return false;
  const content = fs.readFileSync(targetFile, 'utf-8');
  if (!content.includes('cc-habits')) return false;

  const cleaned = stripKimiHabitsBlocks(content).trim() + '\n';
  fs.writeFileSync(targetFile, cleaned, 'utf-8');
  return true;
}

export function deregisterClineHooks(hooksDir: string): boolean {
  const postFile = path.join(hooksDir, 'PostToolUse');
  const stopFile = path.join(hooksDir, 'Stop');
  let removed = false;

  const cleanFile = (file: string, term: string) => {
    if (!fs.existsSync(file)) return;
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes(term)) return;
    const lines = content.split('\n').filter(line => !line.includes(term));
    const nonShebang = lines.filter(line => line.trim() && !line.startsWith('#!'));
    if (nonShebang.length === 0) {
      fs.unlinkSync(file);
      removed = true;
    } else {
      fs.writeFileSync(file, lines.join('\n'), { mode: 0o755 });
      removed = true;
    }
  };

  cleanFile(postFile, 'post-tool-use');
  cleanFile(stopFile, 'stop');
  return removed;
}

