import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

export interface ToolInfo {
  id: string;
  name: string;
  settingsPath: string;
}

export function isCliOnPath(cli: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${cli}` : `which ${cli}`;
    execSync(cmd, { stdio: 'ignore' });
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
