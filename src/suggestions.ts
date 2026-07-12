import { parseHabits, readHabitsMd, readSignals, readMemoriesMd, parseMemories } from './storage';
import { isGloballyDisabled, memoriesEnabled, getConfigValue } from './config';
import { discoverSessions } from './bootstrap';

// Pure helpers for command suggestions and follow-up hints. Kept separate from
// index.ts so they can be unit-tested without triggering the CLI entrypoint.

export const KNOWN_COMMANDS = [
  'init', 'bootstrap', 'view', 'log', 'reset', 'tombstone', 'tombstones',
  'diff', 'explain', 'lint', 'export', 'import', 'sync', 'memories',
  'migrate', 'capture', 'git-capture', 'learn', 'shell-init', 'tools',
  'faq', 'on', 'off', 'uninstall', 'status', 'doctor',
];

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

// Best-effort correction for a mistyped command.
export function suggest(cmd: string): string | undefined {
  const lower = cmd.toLowerCase();
  // Unambiguous prefix match wins immediately ('mem' -> 'memories').
  const prefixMatches = KNOWN_COMMANDS.filter(c => c.startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];
  // A shared 3+ char prefix is a strong typo signal ('memrise' -> 'memories').
  if (lower.length >= 3) {
    const sharedPrefix = KNOWN_COMMANDS.filter(c => c.slice(0, 3) === lower.slice(0, 3));
    if (sharedPrefix.length === 1) return sharedPrefix[0];
  }
  // Fall back to nearest Levenshtein neighbour (threshold: 3 edits).
  let best: string | undefined;
  let bestDist = Infinity;
  for (const known of KNOWN_COMMANDS) {
    const d = levenshtein(lower, known);
    if (d < bestDist) { bestDist = d; best = known; }
  }
  return bestDist <= 3 ? best : undefined;
}

// A bare CC_HABITS_* token or NAME=value pair typed as a command is almost
// always a misplaced environment variable, not a cc-habits subcommand.
export function looksLikeEnvVar(token: string): boolean {
  if (token.startsWith('CC_HABITS_')) return true;
  if (token.includes('=')) return true;
  return /^[A-Z][A-Z0-9_]{2,}$/.test(token);
}

// Contextual follow-up commands, keyed by what the user just ran. Returns the
interface SystemState {
  disabled: boolean;
  hasProvider: boolean;
  hasHabits: boolean;
  hasSignals: boolean;
  memoriesOn: boolean;
  hasMemories: boolean;
  hasPastSessions: boolean;
}

function getSystemState(): SystemState {
  let disabled = false;
  let hasProvider = false;
  let hasHabits = false;
  let hasSignals = false;
  let memoriesOn = false;
  let hasMemories = false;
  let hasPastSessions = false;

  try {
    disabled = isGloballyDisabled();
  } catch {}

  try {
    const provider = getConfigValue('provider');
    hasProvider = !!provider || !!process.env['ANTHROPIC_API_KEY'];
  } catch {}

  try {
    const habits = parseHabits(readHabitsMd());
    hasHabits = Object.values(habits).some(h => h.length > 0);
  } catch {}

  try {
    hasSignals = readSignals().length > 0;
  } catch {}

  try {
    memoriesOn = memoriesEnabled();
  } catch {}

  try {
    const memories = parseMemories(readMemoriesMd());
    hasMemories = Object.values(memories).some(m => m.length > 0);
  } catch {}

  try {
    hasPastSessions = discoverSessions().length > 0;
  } catch {}

  return {
    disabled,
    hasProvider,
    hasHabits,
    hasSignals,
    memoriesOn,
    hasMemories,
    hasPastSessions,
  };
}

// lines to print after a successful command, or undefined for none.
export function nextSteps(command: string, args: string[]): string[] | undefined {
  const state = getSystemState();

  if (state.disabled && command !== 'on') {
    return ['cch on                enable cc-habits (resume capture and prompt injection)'];
  }

  switch (command) {
    case 'on': {
      const steps = [];
      if (state.hasHabits) {
        steps.push('cch view              see learned habits');
      } else {
        steps.push('cch bootstrap         bootstrap from past sessions');
      }
      if (state.memoriesOn && state.hasMemories) {
        steps.push('cch memories          show coding memories');
      }
      if (state.hasHabits) {
        steps.push('cch sync              share habits with your other tools');
      }
      return steps.slice(0, 3);
    }

    case 'off':
      return ['cch on                re-enable cc-habits'];

    // The "Next:" hints lead with the next step in the canonical daily flow,
    //   init  ->  learn  ->  view  ->  sync   (status is a health check anytime)
    // so the suggestions read as one coherent pipeline. Side-features (memories)
    // come after the flow step, never ahead of it.
    case 'init': {
      const steps = [];
      if (state.hasPastSessions && !state.hasHabits) {
        steps.push('cch bootstrap         bootstrap habits from past Claude Code transcripts');
      }
      steps.push(state.hasHabits
        ? 'cch learn             learn from a coding session (or just keep coding)'
        : 'cch learn             learn this repo or a session once you have a provider');
      steps.push(state.hasHabits
        ? 'cch view              see learned habits'
        : 'cch view              see learned habits (currently empty)');
      if (state.memoriesOn && state.hasMemories) {
        steps.push('cch memories          show coding memories');
      }
      return steps.slice(0, 3);
    }

    case 'bootstrap':
    case 'learn': {
      if (!state.hasProvider) {
        return ['cch init              configure an AI provider to start extracting habits'];
      }
      const steps = [];
      steps.push('cch view              see what was learned');
      if (state.hasHabits) {
        steps.push('cch sync              share habits with your other tools');
      }
      if (state.memoriesOn && state.hasMemories) {
        steps.push('cch memories          show coding memories');
      }
      return steps.slice(0, 3);
    }

    case 'view': {
      const steps = [];
      steps.push('cch sync              share habits with your other tools');
      if (state.hasHabits) {
        steps.push('cch export            share your habits as a portable file');
      }
      if (state.memoriesOn && state.hasMemories) {
        steps.push('cch memories          show coding memories');
      }
      steps.push('cch status            check setup health and recent activity');
      return steps.slice(0, 3);
    }

    // Health check anytime, so the follow-up depends on what state is missing:
    // no provider -> init, provider but no habits yet -> bootstrap/learn, else
    // the same daily-flow steps (view, sync) that follow a fresh learn.
    case 'status': {
      if (!state.hasProvider) {
        return ['cch init              configure an AI provider to start extracting habits'];
      }
      if (!state.hasHabits) {
        return [state.hasPastSessions
          ? 'cch bootstrap         bootstrap habits from past Claude Code transcripts'
          : 'cch learn             learn this repo or a session to start building habits'];
      }
      return ['cch view              see current habits', 'cch sync              share habits with your other tools'];
    }

    case 'log':
      if (state.hasHabits) {
        return ['cch view              see your habits', 'cch reset --yes       erase all captures'];
      }
      return ['cch reset --yes       erase all captures'];



    case 'tombstone':
      return ['cch tombstone         list all tombstoned rules'];

    case 'diff':
    case 'explain':
    case 'import':
      if (state.hasHabits) {
        return ['cch view              see current habits', 'cch sync              share them with your other tools'];
      }
      return ['cch view              see current habits'];

    case 'sync':
      return [
        'open the written rules files in your other tools to confirm',
        'cch status            check setup health and recent activity',
      ];

    case 'migrate':
      return ['cch view              confirm your habits moved'];

    case 'capture':
    case 'git-capture':
      return [
        'cch log               see exactly what was captured',
        'cch learn             compile habits from captured signals',
      ];

    case 'shell-init':
      return ['add `eval "$(cc-habits shell-init)"` to ~/.zshrc, then restart your shell'];

    case 'tools':
      return ['cch init              register hooks for your detected tools'];

    case 'faq':
      if (state.hasHabits) {
        return ['cch view              see current habits'];
      }
      return ['cch bootstrap         bootstrap habits from past sessions'];

    case 'memories':
      if (!state.memoriesOn) {
        return ['cch memories --enable  enable memory learning to capture corrections'];
      }
      if (state.hasMemories) {
        return ['cch memories --delete <id> delete a memory by its id (no brackets)'];
      }
      return ['cch view              see current habits'];

    case 'export':
      return [
        'share the exported file with a teammate or your other machine',
        'cch import <file>     merges it there (habits from others re-earn trust locally)',
      ];

    case 'reset':
      return undefined;

    default:
      return undefined;
  }
}
