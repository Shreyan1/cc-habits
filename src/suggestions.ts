// Pure helpers for command suggestions and follow-up hints. Kept separate from
// index.ts so they can be unit-tested without triggering the CLI entrypoint.

export const KNOWN_COMMANDS = [
  'init', 'bootstrap', 'view', 'log', 'reset', 'pending', 'tombstone', 'tombstones',
  'diff', 'explain', 'lint', 'export', 'import', 'sync', 'memories',
  'migrate', 'capture', 'git-capture', 'learn', 'shell-init', 'tools',
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
// lines to print after a successful command, or undefined for none.
export function nextSteps(command: string, args: string[]): string[] | undefined {
  switch (command) {
    case 'init': return ['cch view              see learned habits', 'cch bootstrap         learn from past sessions in this project'];
    case 'bootstrap': return ['cch view              see what was learned', 'cch pending           review proposed habits'];
    case 'view': return ['cch pending           review proposed habits', 'cch sync              share habits with your other tools'];
    case 'log': return ['cch view              see your habits', 'cch reset --yes       erase all captures'];
    case 'pending':
      if (args.includes('--approve')) return ['cch view              see updated habits', 'cch sync              share them with other tools'];
      if (args.includes('--discard')) return ['cch view              see current habits'];
      return ['cch pending --approve apply the proposals', 'cch pending --discard drop them'];
    case 'tombstone': return ['cch tombstones        list blocked rules'];
    case 'tombstones': return ['cch tombstone "<rule>" block another rule'];
    case 'diff': return ['cch view              see current habits'];
    case 'explain': return ['cch view              see all habits'];
    case 'import': return ['cch view              see merged habits', 'cch sync              share them with other tools'];
    case 'sync': return ['open the written rules files in your other tools to confirm'];
    case 'migrate': return ['cch view              confirm your habits moved'];
    case 'capture': return ['cch learn             compile habits from captured signals'];
    case 'git-capture': return ['cch learn             compile habits from your commits', 'cch view              see the result'];
    case 'learn': return ['cch view              see updated habits', 'cch pending           review proposals', 'cch sync              share with other tools'];
    case 'shell-init': return ['add `eval "$(cc-habits shell-init)"` to ~/.zshrc, then restart your shell'];
    case 'tools': return ['cch init              register hooks for your detected tools'];
    default: return undefined;
  }
}
