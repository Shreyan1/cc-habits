import {
  cmdInit, cmdView, cmdLog, cmdReset, cmdPending, cmdTombstone, cmdTombstones,
  cmdDiff, cmdExplain, cmdLint, cmdExport, cmdImport, cmdBootstrap, cmdSync,
} from './cli';

const VERSION = '0.2.9';

// Fuzzy command suggestion ─────────────────────────────────────────────────
const KNOWN_COMMANDS = [
  'init', 'bootstrap', 'view', 'log', 'reset', 'pending', 'tombstone', 'tombstones',
  'diff', 'explain', 'lint', 'export', 'import', 'sync',
];

function levenshtein(a: string, b: string): number {
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

function suggest(cmd: string): string | undefined {
  const lower = cmd.toLowerCase();
  // Unambiguous prefix match wins immediately.
  const prefixMatches = KNOWN_COMMANDS.filter(c => c.startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];
  // Fall back to nearest Levenshtein neighbour (threshold: 2 edits).
  let best: string | undefined;
  let bestDist = Infinity;
  for (const known of KNOWN_COMMANDS) {
    const d = levenshtein(lower, known);
    if (d < bestDist) { bestDist = d; best = known; }
  }
  return bestDist <= 2 ? best : undefined;
}

const HELP = `cc-habits ${VERSION} — Claude Code learns your coding habits, automatically.
  Tip: 'cch' is a short alias for 'cc-habits'.

Usage:
  cc-habits init                    Install hooks, create habits.md — interactive provider setup
  cc-habits init --provider ollama  Skip API key prompt, configure Ollama (free, local)
  cc-habits bootstrap               Learn habits from past Claude Code sessions in this project
  cc-habits view                    Show current habits + recent signals
  cc-habits log [--limit N]         Show the capture log (audit trail of what was sent)
  cc-habits pending                 Show pending updates queued for the next session write
  cc-habits pending --approve       Apply pending updates to habits.md
  cc-habits pending --discard       Drop pending updates without applying
  cc-habits diff [--since N]        Show changes between the last two writes (or N writes ago)
  cc-habits explain "<rule>"        Show signals that contributed to a habit
  cc-habits lint <file> [--json]    Check a file against current habits (LLM-driven)
  cc-habits export [path]           Print habits.md (or write to path)
  cc-habits import <file>           Merge habits from a portable file
  cc-habits sync [targets] [--dir]  Write habits to AGENTS.md / Cursor / Cline (default: agents)
  cc-habits tombstone "<rule>"      Mark a rule so it is never re-learned
  cc-habits tombstones              List tombstoned rules
  cc-habits reset --yes             Delete habits.md, log.jsonl, pending, snapshot
  cc-habits --version               Print the installed version
  cc-habits --help                  Show this message

Env:
  CC_HABITS_DIR                     Override storage location (default ~/.claude/habits)
  CC_HABITS_PROVIDER                Override provider (anthropic|openai|groq|ollama)

Docs: https://github.com/Shreyan1/cc-habits
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  if (command === 'init') {
    const providerIdx = args.indexOf('--provider');
    const providerFlag = providerIdx >= 0 ? args[providerIdx + 1] : undefined;
    process.exit(await cmdInit(providerFlag));
  } else if (command === 'bootstrap') {
    process.exit(await cmdBootstrap());
  } else if (command === 'view') {
    process.exit(cmdView());
  } else if (command === 'log') {
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;
    process.exit(cmdLog(Number.isFinite(limit as number) ? limit : undefined));
  } else if (command === 'reset') {
    process.exit(cmdReset(args.includes('--yes')));
  } else if (command === 'pending') {
    if (args.includes('--approve')) process.exit(cmdPending('approve'));
    else if (args.includes('--discard')) process.exit(cmdPending('discard'));
    else process.exit(cmdPending('show'));
  } else if (command === 'tombstone') {
    process.exit(cmdTombstone(args[1] ?? ''));
  } else if (command === 'tombstones') {
    process.exit(cmdTombstones());
  } else if (command === 'diff') {
    let since: number | undefined;
    const sinceIdx = args.indexOf('--since');
    if (sinceIdx >= 0 && args[sinceIdx + 1]) since = parseInt(args[sinceIdx + 1], 10);
    process.exit(cmdDiff(since));
  } else if (command === 'explain') {
    process.exit(cmdExplain(args.slice(1).filter(a => !a.startsWith('--')).join(' ')));
  } else if (command === 'lint') {
    const filePath = args.find((a, i) => i > 0 && !a.startsWith('--')) ?? '';
    const asJson = args.includes('--json');
    process.exit(await cmdLint(filePath, asJson));
  } else if (command === 'export') {
    const out = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    process.exit(cmdExport(out));
  } else if (command === 'import') {
    process.exit(cmdImport(args[1] ?? ''));
  } else if (command === 'sync') {
    const dirIdx = args.indexOf('--dir');
    const dir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    // Targets are positional args that are not flags and not the --dir value.
    const targets = args.filter((a, i) =>
      i > 0 && !a.startsWith('--') && i !== dirIdx + 1,
    );
    process.exit(cmdSync(targets, dir));
  } else {
    const hint = suggest(command);
    process.stderr.write(`cc-habits: unknown command '${command}'`);
    if (hint) process.stderr.write(`\n  Did you mean '${hint}'?  Try: cc-habits ${hint}`);
    process.stderr.write('\n\n');
    process.stderr.write(HELP);
    process.exit(1);
  }
}

main().catch(e => {
  process.stderr.write(`cc-habits: ${String(e)}\n`);
  process.exit(1);
});
