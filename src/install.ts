import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from './storage';

// Mutable so tests can redirect to temp directories.
// habitsMdPath / importLine are kept in sync with storagePaths.habitsFile so
// that CC_HABITS_DIR overrides flow through to the @import line in CLAUDE.md.
export const installPaths = {
  claudeDir: path.join(os.homedir(), '.claude'),
  settingsFile: path.join(os.homedir(), '.claude', 'settings.json'),
  claudeMd: path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  habitsMdPath: storagePaths.habitsFile,
  importLine: `@import ${storagePaths.habitsFile}`,
};

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
    // SessionStart surfaces pending habit suggestions automatically at the top of
    // each session, so the developer does not have to remember to run cch pending.
    sessionStart: {
      hooks: [{ type: 'command', command: `${safeBin} session-start --adapter claude-code || true` }],
    },
  };
}

// Scenario 2 fix: malformed settings.json (e.g. user added JSON5 comments).
// Warn and start with an empty config rather than crashing init.
function loadSettings(): Record<string, unknown> {
  if (fs.existsSync(installPaths.settingsFile)) {
    try {
      return JSON.parse(fs.readFileSync(installPaths.settingsFile, 'utf-8')) as Record<
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

function saveSettings(settings: Record<string, unknown>): void {
  const filePath = installPaths.settingsFile;
  fs.mkdirSync(installPaths.claudeDir, { recursive: true });
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

export function registerHooks(hookBin?: string): HookRegistration {
  const bin = hookBin ?? resolveHookBinaryPath();
  const { postToolUse, stop, userPromptSubmit, sessionStart } = makeHooks(bin);
  const postCmd = (postToolUse as { hooks: Array<{ command: string }> }).hooks[0].command;
  const stopCmd = (stop as { hooks: Array<{ command: string }> }).hooks[0].command;
  const promptCmd = (userPromptSubmit as { hooks: Array<{ command: string }> }).hooks[0].command;
  const sessionStartCmd = (sessionStart as { hooks: Array<{ command: string }> }).hooks[0].command;

  const settings = loadSettings();
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
    hooks['PostToolUse'].push(postToolUse);
    postAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['Stop'], stopCmd)) {
    hooks['Stop'].push(stop);
    stopAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['UserPromptSubmit'], promptCmd)) {
    hooks['UserPromptSubmit'].push(userPromptSubmit);
    promptAdded = true;
  }
  if (!hookAlreadyRegistered(hooks['SessionStart'], sessionStartCmd)) {
    hooks['SessionStart'].push(sessionStart);
    sessionStartAdded = true;
  }

  saveSettings(settings);
  return { postAdded, stopAdded, promptAdded, sessionStartAdded };
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

export function addImportToClaudeMd(): boolean {
  const importLine = installPaths.importLine;
  const filePath = installPaths.claudeMd;
  // Symlink guard: CLAUDE.md could be symlinked to another file by an attacker.
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing to write through symlink: ${filePath}`);
  }
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(importLine)) return false;
    atomicWriteText(filePath, content.trimEnd() + `\n\n${importLine}\n`);
  } else {
    fs.mkdirSync(installPaths.claudeDir, { recursive: true });
    atomicWriteText(filePath, `${importLine}\n`);
  }
  return true;
}

import { execFileSync } from 'child_process';

export function installLocalGitHook(): boolean {
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

    fs.mkdirSync(hooksDir, { recursive: true });
    const hookFile = path.join(hooksDir, 'post-commit');
    const command = 'cc-habits git-capture || true';

    if (fs.existsSync(hookFile)) {
      const content = fs.readFileSync(hookFile, 'utf-8');
      if (content.includes('cc-habits git-capture') || content.includes('cch git-capture')) {
        return false;
      }
      fs.appendFileSync(hookFile, `\n${command}\n`);
    } else {
      fs.writeFileSync(hookFile, `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    }
    return true;
  } catch {
    return false;
  }
}

export function installGlobalGitTemplateHook(): boolean {
  try {
    const templateDir = path.join(os.homedir(), '.git-templates');
    const hooksDir = path.join(templateDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const hookFile = path.join(hooksDir, 'post-commit');
    const command = 'cc-habits git-capture || true';

    if (fs.existsSync(hookFile)) {
      const content = fs.readFileSync(hookFile, 'utf-8');
      if (!content.includes('cc-habits git-capture') && !content.includes('cch git-capture')) {
        fs.appendFileSync(hookFile, `\n${command}\n`);
      }
    } else {
      fs.writeFileSync(hookFile, `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    }

    // execFileSync with an argument array, never a shell string, so a home dir
    // containing shell metacharacters ($(...), backticks, ...) cannot trigger
    // command substitution. Replaces the previous double-quoted execSync.
    execFileSync('git', ['config', '--global', 'init.templateDir', templateDir]);
    return true;
  } catch {
    return false;
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
    hooks[GEMINI_POST_EVENT].push(postHook);
    postAdded = true;
  }
  if (!hookAlreadyRegistered(hooks[GEMINI_STOP_EVENT], stopCmd)) {
    hooks[GEMINI_STOP_EVENT].push(stopHook);
    stopAdded = true;
  }
  if (!hookAlreadyRegistered(hooks[GEMINI_PROMPT_EVENT], promptCmd)) {
    hooks[GEMINI_PROMPT_EVENT].push(promptHook);
    promptAdded = true;
  }
  if (!hookAlreadyRegistered(hooks[GEMINI_SESSION_START_EVENT], sessionStartCmd)) {
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

export function registerCodexHooks(targetFile: string, hookBin: string): HookRegistration {
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;
  const postCmd = `${safeBin} post-tool-use --adapter codex || true`;
  const stopCmd = `${safeBin} stop --adapter codex || true`;

  let content = '';
  if (fs.existsSync(targetFile)) {
    content = fs.readFileSync(targetFile, 'utf-8');
  }

  let postAdded = false;
  let stopAdded = false;

  if (!content.includes(postCmd)) {
    if (!content.includes('[hooks]')) {
      content += `\n[hooks]\n`;
    }
    content += `PostToolUse = ${tomlString(postCmd)}\n`;
    postAdded = true;
  }
  if (!content.includes(stopCmd)) {
    if (!content.includes('[hooks]')) {
      content += `\n[hooks]\n`;
    }
    content += `Stop = ${tomlString(stopCmd)}\n`;
    stopAdded = true;
  }

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

  return { postAdded, stopAdded, promptAdded: false };
}

// Kimi Code CLI uses ~/.kimi/config.toml with [[hooks]] array-of-tables. Each
// entry has event/command/matcher keys. Kimi follows Claude Code's event names
// (PostToolUse/Stop/UserPromptSubmit/SessionStart) but its own file-tool names
// (WriteFile/StrReplaceFile), so the PostToolUse matcher targets those.
const KIMI_EDIT_MATCHER = 'WriteFile|StrReplaceFile';

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

  // Append a [[hooks]] block only if this exact command is not already present.
  const appendHook = (event: string, command: string, matcher?: string): boolean => {
    if (content.includes(command)) return false;
    const matcherLine = matcher ? `matcher = ${tomlString(matcher)}\n` : '';
    content += `\n[[hooks]]\nevent = ${tomlString(event)}\n${matcherLine}command = ${tomlString(command)}\n`;
    return true;
  };

  const postAdded = appendHook('PostToolUse', postCmd, KIMI_EDIT_MATCHER);
  const stopAdded = appendHook('Stop', stopCmd);
  const promptAdded = appendHook('UserPromptSubmit', promptCmd);
  const sessionStartAdded = appendHook('SessionStart', sessionStartCmd);

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

