import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export interface ToolInfo {
  id: string;
  name: string;
  settingsPath: string;
}

export function isCliOnPath(cli: string): boolean {
  try {
    // execFileSync with an argument array, never a shell, so a CLI name can
    // never be interpreted as a shell command even if it ever becomes dynamic.
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(lookup, [cli], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectInstalledTools(): ToolInfo[] {
  const tools: ToolInfo[] = [];
  const home = os.homedir();

  if (fs.existsSync(path.join(home, '.claude'))) {
    tools.push({
      id: 'claude-code',
      name: 'Claude Code',
      settingsPath: path.join(home, '.claude', 'settings.json'),
    });
  }
  if (fs.existsSync(path.join(home, '.cursor'))) {
    tools.push({
      id: 'cursor',
      name: 'Cursor',
      settingsPath: path.join(home, '.cursor', 'hooks.json'),
    });
  }
  if (fs.existsSync(path.join(home, '.gemini'))) {
    tools.push({
      id: 'gemini',
      name: 'Gemini CLI',
      settingsPath: path.join(home, '.gemini', 'settings.json'),
    });
  }
  if (fs.existsSync(path.join(home, '.codex'))) {
    tools.push({
      id: 'codex',
      name: 'Codex CLI',
      settingsPath: path.join(home, '.codex', 'config.toml'),
    });
  }
  if (fs.existsSync(path.join(home, '.kimi'))) {
    tools.push({
      id: 'kimi',
      name: 'Kimi Code CLI',
      settingsPath: path.join(home, '.kimi', 'config.toml'),
    });
  }
  if (isCliOnPath('cline')) {
    tools.push({
      id: 'cline',
      name: 'Cline/RooCode',
      settingsPath: path.join(home, 'Documents', 'Cline', 'Rules', 'Hooks'),
    });
  }

  return tools;
}

/**
 * Detects whether the user has moved from Google's Gemini CLI to its successor,
 * the Antigravity CLI. Google retired the consumer Gemini CLI on 2026-06-18 and
 * is steering everyone onto Antigravity, which ships the `agy` binary and keeps a
 * global config tree at ~/.gemini/antigravity-cli/.
 *
 * This matters because Antigravity relocated its hook surface off the old
 * ~/.gemini/settings.json (AfterTool/AfterAgent) events into a new workspace
 * format Google has not finalized publicly. When that move has happened, our
 * Gemini capture hooks no longer fire, so we use this signal to wire injection
 * only and hold off on capture rather than register hooks that quietly never run.
 *
 * Best-effort and never throws: both checks swallow their own errors.
 */
export function isAntigravityMigrated(): boolean {
  try {
    const home = os.homedir();
    if (fs.existsSync(path.join(home, '.gemini', 'antigravity-cli'))) return true;
  } catch {
    // fall through to the binary check
  }
  return isCliOnPath('agy');
}
