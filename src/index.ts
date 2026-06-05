import {
  cmdInit, cmdView, cmdLog, cmdReset, cmdPending, cmdTombstone, cmdTombstones,
  cmdDiff, cmdExplain, cmdLint, cmdExport, cmdImport, cmdBootstrap, cmdSync,
  cmdMemories, cmdMemoriesDelete, cmdMemoriesTombstones, cmdMemoriesToggle,
  cmdMigrate, cmdCapture, cmdGitCapture, cmdLearn, cmdShellInit, cmdSessionBanner, cmdTools, VERSION,
  cmdOn, cmdOff, cmdUninstall,
  c, BOLD, DIM, CYAN
} from './cli';
import { cmdFaq } from './faq';
import { spawnSync } from 'child_process';
import { runMigration } from './migrate';
import { suggest, looksLikeEnvVar, nextSteps } from './suggestions';
import { runInteractiveMenu, runSelectMenu, MENU_ITEMS } from './menu';
import { maybeUpdateNotice } from './update-check';
import { isGloballyDisabled } from './config';

// Print follow-up suggestions to stderr so stdout pipes stay clean. Only when
// the command succeeded and we are attached to an interactive terminal.
function printNextSteps(command: string, args: string[], code: number): void {
  if (code !== 0 || !process.stderr.isTTY) return;
  if (args.includes('--json')) return;
  const steps = nextSteps(command, args);
  if (!steps || steps.length === 0) return;
  process.stderr.write(`\n\n  ${c(BOLD + CYAN, 'Next:')}\n`);
  for (const s of steps) {
    if (s.startsWith('cch ')) {
      const cmdPart = s.slice(0, 22);
      const descPart = s.slice(22);
      process.stderr.write(`    ${c(CYAN, cmdPart)}${c(DIM, descPart)}\n`);
    } else {
      process.stderr.write(`    ${c(DIM, s)}\n`);
    }
  }
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

  Setup & Configuration:
    cc-habits init                    Install hooks, create habits.md, interactive provider setup
    cc-habits init --provider ollama  Skip API key prompt, configure Ollama (free, local)
    cc-habits tools                   List supported coding tools and which are detected here
    cc-habits on                      Enable cc-habits (resume capture and prompt injection)
    cc-habits off                     Disable cc-habits (pause capture and prompt injection)
    cc-habits shell-init              Print shell wrapper for claude/gemini (eval "$(cc-habits shell-init)")
    cc-habits migrate [--force]       Migrate storage from old ~/.claude/habits/ to ~/.cc-habits/
    cc-habits uninstall [--yes]       Uninstall cc-habits completely and delete all local files

  Habits Lifecycle:
    cc-habits bootstrap               Learn habits from past Claude Code sessions in this project
    cc-habits view                    Show current habits + recent signals
    cc-habits pending                 Show pending updates queued for the next session write
    cc-habits pending --approve       Apply pending updates to habits.md
    cc-habits pending --discard       Drop pending updates without applying
    cc-habits capture --file <p> --diff <d>  Directly append an edit signal (CLI capture adapter)
    cc-habits git-capture [--range r] Capture changes from git commits (HEAD~1..HEAD by default)
    cc-habits learn [--session id]    Compile habits and memories from collected signals

  Sharing & Portability:
    cc-habits sync [targets] [--dir]  Write habits to AGENTS.md / Cursor / Cline (default: agents)
    cc-habits export [path]           Export habits profile (add --include-memories for full bundle)
    cc-habits import <file|url>       Import habits from a file or https:// URL (auto-detects full bundle)

  Analysis & Debugging:
    cc-habits log [--limit N]         Show the capture log (audit trail of what was sent)
    cc-habits diff [--since N]        Show changes between the last two writes (or N writes ago)
    cc-habits explain "<rule>"        Show signals that contributed to a habit
    cc-habits lint <file> [--json]    Check a file against current habits (LLM-driven)

  Memory & Tombstones:
    cc-habits memories                Show coding memories (prompts to enable learning if off)
    cc-habits memories --enable       Turn on memory learning permanently (persists to config.yml)
    cc-habits memories --disable      Turn off memory learning
    cc-habits memories --delete "<t>" Delete and tombstone a memory so it is never re-learned
    cc-habits memories --tombstones   List tombstoned memories
    cc-habits tombstone [rule]        Block a habit rule (or list blocked rules when rule omitted)

  Getting Help:
    cc-habits faq [query]             Search the FAQ or raise an issue
    cc-habits --help                  Show this message
    cc-habits --version               Print the installed version

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

  async function runMainInteractiveMenu(): Promise<void> {
    const disabled = isGloballyDisabled();
    const items = MENU_ITEMS.map(item => {
      if (item.label === 'on' && !disabled) {
        return { ...item, disabled: true };
      }
      if (item.label === 'off' && disabled) {
        return { ...item, disabled: true };
      }
      return item;
    });
    const item = await runInteractiveMenu(items);
    if (!item) process.exit(0);

    if (item.args[0] === '--help') {
      const helpItems = [
        // Setup & Configuration
        { label: 'init                    Install hooks and set up a provider', args: ['init'] },
        { label: 'init --provider ollama  Skip key prompt, configure local Ollama', args: ['init', '--provider', 'ollama'] },
        { label: 'tools                   List supported coding tools', args: ['tools'] },
        { label: 'on                      Enable cc-habits', args: ['on'] },
        { label: 'off                     Disable cc-habits', args: ['off'] },
        { label: 'shell-init              Print shell wrapper', args: ['shell-init'] },
        { label: 'migrate                 Migrate storage location', args: ['migrate'] },
        { label: 'uninstall               Uninstall cc-habits completely', args: ['uninstall'] },
        
        // Habits Lifecycle
        { label: 'bootstrap               Learn habits from past sessions', args: ['bootstrap'] },
        { label: 'view                    Show current habits and signals', args: ['view'] },
        { label: 'pending                 Review queued habit suggestions', args: ['pending'] },
        { label: 'pending --approve       Apply pending updates to habits.md', args: ['pending', '--approve'] },
        { label: 'pending --discard       Drop pending updates', args: ['pending', '--discard'] },
        { label: 'git-capture             Capture changes from git commits', args: ['git-capture'] },
        { label: 'learn                   Compile habits from collected signals', args: ['learn'] },
        
        // Sharing & Portability
        { label: 'sync                    Share habits with other tools', args: ['sync'] },
        { label: 'export                  Export habits profile', args: ['export'] },
        { label: 'import                  Import habits profile', args: ['import'] },
        
        // Analysis & Debugging
        { label: 'log                     Show the capture log', args: ['log'] },
        { label: 'diff                    Show changes between last two writes', args: ['diff'] },
        { label: 'explain                 Show signals contributing to a habit', args: ['explain'] },
        { label: 'lint                    Check a file against habits', args: ['lint'] },
        
        // Memory & Tombstones
        { label: 'memories                Show coding memories', args: ['memories'] },
        { label: 'memories --enable       Turn on memory learning', args: ['memories', '--enable'] },
        { label: 'memories --disable      Turn off memory learning', args: ['memories', '--disable'] },
        { label: 'memories --tombstones   List tombstoned memories', args: ['memories', '--tombstones'] },
        { label: 'tombstone               Block a habit rule', args: ['tombstone'] },
        
        // Getting Help
        { label: 'faq                     Search FAQ or raise a GitHub issue', args: ['faq'] },
      ];

      const menuItems = helpItems.map(hi => ({
        label: hi.label,
        value: JSON.stringify(hi.args)
      }));
      menuItems.push({ label: 'Back to main menu', value: 'back' });

      const selectedHelp = await runSelectMenu(
        `  ${c(BOLD + CYAN, 'Select a detailed usage command to run (use ↑/↓ keys):')}`,
        menuItems
      );
      if (!selectedHelp || selectedHelp.value === 'back') {
        return runMainInteractiveMenu();
      }
      const chosenArgs = JSON.parse(selectedHelp.value);
      const res = spawnSync(process.execPath, [String(process.argv[1]), ...chosenArgs], { stdio: 'inherit' });
      process.exit(res.status ?? 0);
    }

    const res = spawnSync(process.execPath, [String(process.argv[1]), ...item.args], { stdio: 'inherit' });
    process.exit(res.status ?? 0);
  }

  if (!command || command === 'help') {
    if (process.stdin.isTTY && process.stderr.isTTY) {
      await runMainInteractiveMenu();
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
  } else if (command === 'uninstall') {
    code = await cmdUninstall(args.includes('--yes'));
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
  } else if (command === 'on') {
    code = cmdOn();
  } else if (command === 'off') {
    code = cmdOff();
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
    const out = args.find((a, i) => i > 0 && !a.startsWith('--'));
    const includeMemories = args.includes('--include-memories') || args.includes('--full');
    code = cmdExport(out, includeMemories);
  } else if (command === 'import') {
    code = await cmdImport(args[1] ?? '');
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
  } else if (command === 'faq') {
    const q = args.slice(1).join(' ');
    code = await cmdFaq(q);
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
