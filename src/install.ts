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

function makeHooks(hookBin: string): { postToolUse: object; stop: object; userPromptSubmit: object } {
  // Quote the binary path to handle spaces (e.g. /Users/my name/.../.bin/cc-habits-hook).
  // Escape any embedded double-quotes in the path itself before wrapping.
  const safeBin = `"${hookBin.replace(/"/g, '\\"')}"`;
  return {
    postToolUse: {
      matcher: 'Write|Edit|MultiEdit',
      hooks: [{ type: 'command', command: `${safeBin} post-tool-use || true` }],
    },
    stop: {
      hooks: [{ type: 'command', command: `${safeBin} stop || true` }],
    },
    // UserPromptSubmit re-injects active habits into context each prompt (Patch 2).
    // No matcher — this event always fires.
    userPromptSubmit: {
      hooks: [{ type: 'command', command: `${safeBin} user-prompt-submit || true` }],
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

export function makeHooksForTest(hookBin: string): { postToolUse: object; stop: object; userPromptSubmit: object } {
  return makeHooks(hookBin);
}

export interface HookRegistration {
  postAdded: boolean;
  stopAdded: boolean;
  promptAdded: boolean;
}

export function registerHooks(hookBin?: string): HookRegistration {
  const bin = hookBin ?? resolveHookBinaryPath();
  const { postToolUse, stop, userPromptSubmit } = makeHooks(bin);
  const postCmd = (postToolUse as { hooks: Array<{ command: string }> }).hooks[0].command;
  const stopCmd = (stop as { hooks: Array<{ command: string }> }).hooks[0].command;
  const promptCmd = (userPromptSubmit as { hooks: Array<{ command: string }> }).hooks[0].command;

  const settings = loadSettings();
  if (!settings['hooks']) settings['hooks'] = {};
  const hooks = settings['hooks'] as Record<string, unknown[]>;
  if (!hooks['PostToolUse']) hooks['PostToolUse'] = [];
  if (!hooks['Stop']) hooks['Stop'] = [];
  if (!hooks['UserPromptSubmit']) hooks['UserPromptSubmit'] = [];

  let postAdded = false;
  let stopAdded = false;
  let promptAdded = false;

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

  saveSettings(settings);
  return { postAdded, stopAdded, promptAdded };
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
