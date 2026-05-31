import {
  cmdInit, cmdView, cmdLog, cmdReset, cmdPending, cmdTombstone, cmdTombstones,
  cmdDiff, cmdExplain, cmdLint, cmdExport, cmdImport, cmdBootstrap, cmdSync,
  cmdMemories, cmdMemoriesDelete, cmdMemoriesTombstones, cmdMemoriesToggle,
  cmdMigrate, cmdCapture, cmdGitCapture, cmdLearn, cmdShellInit, cmdSessionBanner, cmdTools,
} from './cli';
import { spawnSync } from 'child_process';
import { runMigration } from './migrate';
import { suggest, looksLikeEnvVar, nextSteps } from './suggestions';
import { runInteractiveMenu } from './menu';
import { maybeUpdateNotice } from './update-check';

const VERSION = '0.5.0';

// Print follow-up suggestions to stderr so stdout pipes stay clean. Only when
// the command succeeded and we are attached to an interactive terminal.
function printNextSteps(command: string, args: string[], code: number): void {
  if (code !== 0 || !process.stderr.isTTY) return;
  if (args.includes('--json')) return;
  const steps = nextSteps(command, args);
  if (!steps || steps.length === 0) return;
  process.stderr.write(`\n  Next:\n`);
  for (const s of steps) process.stderr.write(`    ${s}\n`);
}

// Print the "update available" notice to stderr so stdout pipes stay clean.
// Only on an interactive terminal, never for piped/--json output. The check is
// throttled and time-boxed inside maybeUpdateNotice, and never throws.
async function printUpdateNotice(args: string[]): Promise<void> {
  if (!process.stderr.isTTY || args.includes('--json')) return;
  try {
    const notice = await maybeUpdateNotice(VERSION);
    if (notice) process.stderr.write(`\n${notice}\n`);
  } catch {
    // update notice is cosmetic; never let it affect the command result
  }
}

const HELP = `cc-habits ${VERSION}, A tool-agnostic coding memory layer for developer habits and AI agents.
  Tip: 'cch' is a short alias for 'cc-habits'.

Usage:
  cc-habits tools                   List supported coding tools and which are detected here
  cc-habits init                    Install hooks, create habits.md, interactive provider setup
  cc-habits init --provider ollama  Skip API key prompt, configure Ollama (free, local)
  cc-habits bootstrap               Learn habits from past Claude Code sessions in this project
  cc-habits view                    Show current habits + recent signals
  cc-habits memories                Show coding memories (prompts to enable learning if off)
  cc-habits memories --enable       Turn on memory learning permanently (persists to config.yml)
  cc-habits memories --disable      Turn off memory learning
  cc-habits memories --delete "<t>" Delete and tombstone a memory so it is never re-learned
  cc-habits memories --tombstones   List tombstoned memories
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
  cc-habits migrate [--force]       Migrate storage from old ~/.claude/habits/ to ~/.cc-habits/
  cc-habits capture --file <p> --diff <d>  Directly append an edit signal (CLI capture adapter)
  cc-habits git-capture [--range r] Capture changes from git commits (HEAD~1..HEAD by default)
  cc-habits learn [--session id]    Compile habits and memories from collected signals
  cc-habits shell-init              Print shell wrapper for claude/gemini (eval "$(cc-habits shell-init)")
  cc-habits --version               Print the installed version
  cc-habits --help                  Show this message

Env (set in your shell, e.g. \`export CC_HABITS_PROVIDER=ollama\`; not cc-habits subcommands):
  CC_HABITS_DIR                     Override storage location (default ~/.cc-habits)
  CC_HABITS_PROVIDER                Override provider (anthropic|openai|groq|ollama)
  CC_HABITS_MEMORIES=1              Enable memory extraction for this shell (or: cch memories --enable)

Docs: https://github.com/Shreyan1/cc-habits
`;

async function main(): Promise<void> {
  // Silent auto-migration on startup
  try {
    runMigration();
  } catch {
    // ignore
  }

  const args = process.argv.slice(2);
  const command = args[0];

  // `--help`/`-h` always print the static reference. A bare `cch` or `cch help`
  // opens the interactive arrow-key menu when attached to a terminal, falling
  // back to the static text when output is piped or not a TTY.
  if (command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (!command || command === 'help') {
    if (process.stdin.isTTY && process.stderr.isTTY) {
      const item = await runInteractiveMenu();
      if (!item) process.exit(0);
      const res = spawnSync(process.execPath, [String(process.argv[1]), ...item.args], { stdio: 'inherit' });
      process.exit(res.status ?? 0);
    }
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  let code = 0;

  if (command === 'init') {
    const providerIdx = args.indexOf('--provider');
    const providerFlag = providerIdx >= 0 ? args[providerIdx + 1] : undefined;
    code = await cmdInit(providerFlag);
  } else if (command === 'bootstrap') {
    code = await cmdBootstrap();
  } else if (command === 'view') {
    code = cmdView();
  } else if (command === 'memories') {
    const deleteIdx = args.indexOf('--delete');
    if (deleteIdx >= 0) {
      code = cmdMemoriesDelete(args[deleteIdx + 1] ?? '');
    } else if (args.includes('--tombstones')) {
      code = cmdMemoriesTombstones();
    } else if (args.includes('--enable')) {
      code = cmdMemoriesToggle(true);
    } else if (args.includes('--disable')) {
      code = cmdMemoriesToggle(false);
    } else {
      code = await cmdMemories();
    }
  } else if (command === 'log') {
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;
    code = cmdLog(Number.isFinite(limit as number) ? limit : undefined);
  } else if (command === 'reset') {
    code = cmdReset(args.includes('--yes'));
  } else if (command === 'pending') {
    if (args.includes('--approve')) code = cmdPending('approve');
    else if (args.includes('--discard')) code = cmdPending('discard');
    else code = cmdPending('show');
  } else if (command === 'tools') {
    code = cmdTools();
  } else if (command === 'shell-init') {
    code = cmdShellInit();
  } else if (command === 'session-banner') {
    code = cmdSessionBanner();
  } else if (command === 'tombstone') {
    code = cmdTombstone(args[1] ?? '');
  } else if (command === 'tombstones') {
    code = cmdTombstones();
  } else if (command === 'diff') {
    let since: number | undefined;
    const sinceIdx = args.indexOf('--since');
    if (sinceIdx >= 0 && args[sinceIdx + 1]) since = parseInt(args[sinceIdx + 1], 10);
    code = cmdDiff(since);
  } else if (command === 'explain') {
    code = cmdExplain(args.slice(1).filter(a => !a.startsWith('--')).join(' '));
  } else if (command === 'lint') {
    const filePath = args.find((a, i) => i > 0 && !a.startsWith('--')) ?? '';
    const asJson = args.includes('--json');
    code = await cmdLint(filePath, asJson);
  } else if (command === 'export') {
    const out = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    code = cmdExport(out);
  } else if (command === 'import') {
    code = cmdImport(args[1] ?? '');
  } else if (command === 'sync') {
    const dirIdx = args.indexOf('--dir');
    const dir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    const targets = args.filter((a, i) =>
      i > 0 && !a.startsWith('--') && i !== dirIdx + 1,
    );
    code = cmdSync(targets, dir);
  } else if (command === 'migrate') {
    code = cmdMigrate(args.includes('--force'));
  } else if (command === 'capture') {
    const fileIdx = args.indexOf('--file');
    const diffIdx = args.indexOf('--diff');
    const sessionIdx = args.indexOf('--session');
    const sourceIdx = args.indexOf('--source');
    code = cmdCapture({
      file: fileIdx >= 0 ? args[fileIdx + 1] ?? '' : '',
      diff: diffIdx >= 0 ? args[diffIdx + 1] ?? '' : '',
      session: sessionIdx >= 0 ? args[sessionIdx + 1] : undefined,
      source: sourceIdx >= 0 ? args[sourceIdx + 1] : undefined,
    });
  } else if (command === 'git-capture') {
    const rangeIdx = args.indexOf('--range');
    const range = rangeIdx >= 0 ? args[rangeIdx + 1] : undefined;
    code = await cmdGitCapture(range);
  } else if (command === 'learn') {
    const sessionIdx = args.indexOf('--session');
    const sinceIdx = args.indexOf('--since');
    code = await cmdLearn({
      session: sessionIdx >= 0 ? args[sessionIdx + 1] : undefined,
      since: sinceIdx >= 0 && args[sinceIdx + 1] ? parseInt(args[sinceIdx + 1], 10) : undefined,
    });
  } else {
    // Unknown command. Distinguish a misplaced env var from a genuine typo.
    if (looksLikeEnvVar(command)) {
      const name = command.split('=')[0];
      process.stderr.write(`cc-habits: '${command}' looks like an environment variable, not a command.\n`);
      process.stderr.write(`  Set it in your shell instead, for example:\n`);
      process.stderr.write(`    export ${name}=<value>          # this shell only\n`);
      process.stderr.write(`  Add that line to ~/.zshrc or ~/.bashrc to make it permanent.\n`);
      process.stderr.write(`  Run \`cch --help\` to see the supported CC_HABITS_* variables.\n`);
    } else {
      const hint = suggest(command);
      process.stderr.write(`cc-habits: unknown command '${command}'`);
      if (hint) process.stderr.write(`\n  Did you mean '${hint}'?  Try: cc-habits ${hint}`);
      process.stderr.write('\n\n');
      process.stderr.write(HELP);
    }
    process.exit(1);
  }

  printNextSteps(command, args, code);
  await printUpdateNotice(args);
  process.exit(code);
}

main().catch(e => {
  process.stderr.write(`cc-habits: ${String(e)}\n`);
  process.exit(1);
});
