import fs from 'fs';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, readHabitsMd, readSignals, parseHabits,
  readPending, clearPending, writeHabitsMd, serialiseHabits, writeSnapshot,
  readTombstones, addTombstone, initMemoriesMd, readMemoriesMd, writeMemoriesMd,
  parseMemories, serialiseMemories, addMemoryTombstone, readMemoryTombstones,
  readHistory, appendHistory, logError, detectManualDeletes, applyMemoryUpdates,
  writePending, writeConfigFile,
  type Memory, type Signal,
} from './storage';
import { applyUpdates, pendingToUpdates, applyDecay, toPending, type AppliedChange } from './confidence';
import { registerHooks, addImportToClaudeMd, installLocalGitHook, installGlobalGitTemplateHook, registerJsonHooks, registerCodexHooks, registerKimiHooks, registerClineHooks, resolveHookBinaryPath } from './install';
import { computeDiff } from './diff';
import { explainHabit } from './explain';
import { exportProfile, importHabits, fetchProfile } from './portable';
import { lintPath } from './lint';
import { discoverSessions, bootstrap } from './bootstrap';
import { syncTargets, SyncTarget, readSyncTargets } from './sync';
import { runMigration } from './migrate';
import { captureFromCli } from './capture';
import { runGitCapture, shouldTriggerGitLearn } from './git-collector';
import { extractRules, extractMemoryCandidates } from './extractor';
import { ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError } from './providers';
import { memoriesEnabled, setMemoriesEnabled, consentGiven, recordConsent, setGloballyDisabled } from './config';
import { formatStopSummary, autoApplyWarning } from './hook';
import { detectInstalledTools, isCliOnPath } from './detect';
import { SUPPORTED_TOOLS } from './supported';

export const VERSION = '0.5.3';

// Turn a provider failure into a plain-language, actionable hint. Returns
// undefined for non-provider errors so the caller can rethrow them.
function providerHint(e: unknown): string | undefined {
  if (e instanceof ProviderRateLimitError) {
    return 'provider rate-limited (HTTP 429) after retries, nothing changed this run.\n' +
      '  Tip: wait a minute and retry, or switch provider with `cch init` (Ollama is free and local).';
  }
  if (e instanceof ProviderTimeoutError) {
    return 'provider request timed out, nothing changed this run. Check your network and retry.';
  }
  if (e instanceof ProviderPayloadError) {
    return 'extraction batch was too large for this provider (HTTP 413), nothing changed this run.\n' +
      '  Tip: switch to Anthropic or OpenAI which accept larger payloads, or run `cch reset --yes` to clear the signal log.';
  }
  return undefined;
}

// Cap a signal batch to at most 50 entries AND at most MAX_BATCH_BYTES of total
// diff content. Groq and some other providers return 413 when the request body
// exceeds their hard limit; a count cap alone is not enough when diffs are large
// (e.g. committing big files). Returns both the final batch and a description
// of how it was trimmed for the log message.
const MAX_BATCH_SIGNALS = 50;
const MAX_BATCH_BYTES   = 180_000; // ~180 KB, well under Groq's 200 KB request limit

export function capBatch(signals: Signal[]): { batch: Signal[]; desc: string } {
  const countCapped = signals.slice(-MAX_BATCH_SIGNALS);
  let byteTotal = 0;
  let byteIdx = countCapped.length;
  // Walk newest-first and stop when the next one would exceed the budget.
  for (let i = countCapped.length - 1; i >= 0; i--) {
    const len = (countCapped[i]!.diff ?? '').length;
    if (byteTotal + len > MAX_BATCH_BYTES && byteTotal > 0) {
      break;
    }
    byteTotal += len;
    byteIdx = i;
  }
  const batch = countCapped.slice(byteIdx);
  const total = signals.length;
  const sent  = batch.length;
  if (sent === total) return { batch, desc: `${total}` };
  return { batch, desc: `${sent} of ${total} (capped to fit provider limits)` };
}

// Config file path is derived from storagePaths so CC_HABITS_DIR overrides
// both data files AND the provider config in one environment variable.
const CONFIG_FILE = storagePaths.configFile;

const OLLAMA_DEFAULT_URL   = 'http://localhost:11434';
const OLLAMA_DEFAULT_MODEL = 'llama3.2';

const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

const NO_COLOR = !process.stdout.isTTY || !!process.env['NO_COLOR'];

function c(code: string, text: string): string {
  return NO_COLOR ? text : `${code}${text}${RESET}`;
}

// Strip terminal control characters (ESC, BEL, CSI sequences, C0/C1 controls) from
// untrusted content before display. A captured diff or LLM-produced rule could embed
// ANSI escape codes that spoof output, hide text, or manipulate the user's terminal
// when they run `cc-habits log` / `view` / `explain` / `pending`.
// eslint-disable-next-line no-control-regex
const TERM_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
function term(s: string): string {
  return (s ?? '').replace(TERM_CONTROL, '');
}

function confidenceBar(conf: number, width = 22): string {
  const filled = Math.round(conf * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = conf >= 0.70 ? GREEN : conf >= 0.50 ? YELLOW : RED;
  return c(color, bar);
}

// init ─────────────────────────────────────────────────────────────────────
// Consent prompt text (L5). Shown exactly once at first `cch init`. Honest
// about what leaves the machine and what does not.
const CONSENT_NOTICE = `
  cc-habits captures code diffs from your AI coding sessions and sends them to
  your chosen LLM provider (Anthropic, OpenAI, Groq, or a local Ollama model)
  to extract your coding habits.

  What leaves your machine: code diffs (redacted for emails, card numbers, IDs).
  What stays local:         habits.md, log.jsonl, memories.md, config.yml.
  What cc-habits stores:    nothing. There are no cc-habits servers.

  Review the full privacy policy: https://github.com/Shreyan1/cc-habits/blob/main/PRIVACY.md
`;

export async function cmdInit(providerFlag?: string): Promise<number> {
  process.stdout.write(c(BOLD, 'cc-habits: initialising...\n'));

  // L5: consent gate — show once, skip if already recorded, abort on N.
  if (!consentGiven()) {
    process.stdout.write(CONSENT_NOTICE);
    const agreed = await promptYesNoDefaultTrue('  Proceed with installation? [Y/n] ');
    if (!agreed) {
      process.stdout.write('  Installation cancelled. Nothing was changed.\n');
      return 0;
    }
    recordConsent();
    process.stdout.write('\n');
  }

  initHabitsMd();
  initLog();

  const tick = '✓';
  const dash = '~';

  const detected = detectInstalledTools();
  if (detected.length > 0) {
    process.stdout.write(`\n  Detected installed tools:\n`);
    for (const tool of detected) {
      process.stdout.write(`    • ${tool.name}\n`);
    }
    process.stdout.write('\n');

    const hookBin = resolveHookBinaryPath();

    for (const tool of detected) {
      if (tool.id === 'claude-code') {
        const register = await promptYesNoDefaultTrue(`  Register hooks in Claude Code? [Y/n] `);
        if (register) {
          const { postAdded, stopAdded, promptAdded, sessionStartAdded } = registerHooks(hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${sessionStartAdded ? tick : dash} SessionStart hook ${sessionStartAdded ? 'registered' : 'already registered'}\n`);
          const importAdded = addImportToClaudeMd();
          process.stdout.write(`    ${importAdded ? tick : dash} habits.md import ${importAdded ? 'added to' : 'already in'} ~/.claude/CLAUDE.md\n`);
        }
      } else if (tool.id === 'gemini') {
        const register = await promptYesNoDefaultTrue(`  Register hooks in Gemini CLI? [Y/n] `);
        if (register) {
          const { postAdded, stopAdded, promptAdded, sessionStartAdded } = registerJsonHooks(tool.settingsPath, 'gemini', hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} AfterTool hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} AfterAgent hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} BeforeAgent hook ${promptAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${sessionStartAdded ? tick : dash} SessionStart hook ${sessionStartAdded ? 'registered' : 'already registered'}\n`);
        }
      } else if (tool.id === 'codex') {
        const register = await promptYesNoDefaultTrue(`  Register hooks in Codex CLI? [Y/n] `);
        if (register) {
          const { postAdded, stopAdded } = registerCodexHooks(tool.settingsPath, hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
        }
      } else if (tool.id === 'kimi') {
        const register = await promptYesNoDefaultTrue(`  Register hooks in Kimi Code CLI? [Y/n] `);
        if (register) {
          const { postAdded, stopAdded, promptAdded, sessionStartAdded } = registerKimiHooks(tool.settingsPath, hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${sessionStartAdded ? tick : dash} SessionStart hook ${sessionStartAdded ? 'registered' : 'already registered'}\n`);
        }
      } else if (tool.id === 'cline') {
        const register = await promptYesNoDefaultTrue(`  Register hooks in Cline/RooCode? [Y/n] `);
        if (register) {
          const { postAdded, stopAdded } = registerClineHooks(tool.settingsPath, hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
        }
      } else if (tool.id === 'cursor') {
        process.stdout.write(`  ${dash} Cursor detected, edits will be captured automatically via the VS Code extension or Git commits.\n`);
      }
    }
  } else {
    const { postAdded, stopAdded, promptAdded } = registerHooks();
    process.stdout.write(`  ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
    process.stdout.write(`  ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
    process.stdout.write(`  ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);
    const importAdded = addImportToClaudeMd();
    process.stdout.write(`  ${importAdded ? tick : dash} habits.md import ${importAdded ? 'added to' : 'already in'} ~/.claude/CLAUDE.md\n`);
  }

  const hasAnthropicEnv = !!process.env['ANTHROPIC_API_KEY'];
  const hasConfigFile   = fs.existsSync(CONFIG_FILE);

  if (providerFlag) {
    await configureProvider(providerFlag, tick, dash);
  } else if (hasAnthropicEnv) {
    process.stdout.write(`  ${dash} ANTHROPIC_API_KEY found in environment\n`);
  } else if (hasConfigFile) {
    process.stdout.write(`  ${dash} Provider config already exists at ~/.cc-habits/config.yml\n`);
  } else {
    await showProviderMenu(tick, dash);
  }

  const providerReady = hasAnthropicEnv || fs.existsSync(CONFIG_FILE) || !!providerFlag;
  const habitsEmpty = parseHabits(readHabitsMd());
  const hasExistingHabits = Object.values(habitsEmpty).some(h => h.length > 0);

  if (providerReady && !hasExistingHabits) {
    const sessions = discoverSessions();
    if (sessions.length > 0) {
      process.stdout.write('\n');
      process.stdout.write(
        `  Found ${c(BOLD, String(sessions.length))} Claude Code session${sessions.length === 1 ? '' : 's'} for this project.\n`,
      );
      const yes = await promptYesNo('  Bootstrap habits from past sessions? [y/N] ');
      if (yes) {
        process.stdout.write('\n');
        process.stdout.write(c(DIM, '  Extracting patterns...\n'));
        try {
          const result = await bootstrap();
          if (result.habitsLearned > 0) {
            process.stdout.write(
              `  ${tick} Learned ${c(BOLD, String(result.habitsLearned))} habit${result.habitsLearned === 1 ? '' : 's'}` +
              ` across ${c(BOLD, String(result.categories.length))} categor${result.categories.length === 1 ? 'y' : 'ies'}` +
              ` from ${result.signalsExtracted} edits\n`,
            );
          } else {
            process.stdout.write(c(DIM, '  No clear patterns found yet. Habits will emerge as you code more.\n'));
          }
        } catch (e) {
          process.stdout.write(c(DIM, `  Bootstrap skipped: ${String(e).slice(0, 80)}\n`));
        }
      }
    }
  }

  const inGitRepo = fs.existsSync('.git');
  if (inGitRepo) {
    const installLocal = await promptYesNo('  Install git capture hook locally in this project? [y/N] ');
    if (installLocal) {
      const added = installLocalGitHook();
      process.stdout.write(`  ${added ? tick : dash} Local Git post-commit hook ${added ? 'installed' : 'already installed or failed'}\n`);
    }
  }

  const installGlobal = await promptYesNo('  Install git capture hook globally for all new repositories? [y/N] ');
  if (installGlobal) {
    const added = installGlobalGitTemplateHook();
    process.stdout.write(`  ${added ? tick : dash} Global Git template post-commit hook ${added ? 'installed' : 'already installed or failed'}\n`);
  }

  // Enable memory learning by default for new installs. If the user already has
  // an explicit setting (from a previous init or manual edit) leave it alone.
  const { getConfigValue } = await import('./config');
  if (!getConfigValue('memories_enabled')) {
    setMemoriesEnabled(true);
    process.stdout.write(`  ${tick} Memory learning enabled by default.\n`);
    process.stdout.write(c(DIM, '  To disable at any time: cch memories --disable\n'));
  }

  process.stdout.write('\n');
  process.stdout.write(
    c(BOLD, 'cc-habits is ready.') + ' Start a coding session or commit changes to begin learning.\n',
  );
  process.stdout.write(c(DIM, '  Habits are stored at ~/.cc-habits/habits.md\n'));
  return 0;
}

// Plain-language data-flow disclosure shown before any provider is configured.
// Responsible AI: the user must understand what is captured and where it goes
// before cc-habits sends anything to a third party.
function showDataFlowNotice(): void {
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, '  How cc-habits uses your code\n'));
  process.stdout.write(c(DIM, '  ──────────────────────────────\n'));
  process.stdout.write('  • Captures the diff of files you edit during a Claude Code session.\n');
  process.stdout.write('  • Redacts email / PAN / card numbers (best-effort, pattern-based, not exhaustive).\n');
  process.stdout.write('  • Sends batched diffs to the AI provider you choose below, once per session, to learn patterns.\n');
  process.stdout.write('  • A local-only provider (Ollama) sends nothing off your machine.\n');
  process.stdout.write(c(DIM, '  Opt out anytime: add a .cc-habits-ignore file in a repo, set CC_HABITS_DISABLE=1,\n'));
  process.stdout.write(c(DIM, '  inspect captures with `cc-habits log`, or erase them with `cc-habits reset --yes`.\n'));
}

async function showProviderMenu(tick: string, dash: string): Promise<void> {
  showDataFlowNotice();
  process.stdout.write('\n');
  process.stdout.write(
    c(YELLOW, '  Note: ') +
    'Claude Code subscriptions and Anthropic API keys are sold separately.\n',
  );
  process.stdout.write(
    c(DIM, '  If you only have a Claude Code plan, Ollama (free, local) is a great option.\n'),
  );
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, '  How should cc-habits call the AI?\n\n'));
  process.stdout.write('  [1] Anthropic API  ' + c(DIM, '(~$0.09/month, console.anthropic.com)') + '\n');
  process.stdout.write('  [2] Ollama         ' + c(DIM, '(free, local, ollama.com/download)') + '\n');
  process.stdout.write('  [3] OpenAI API     ' + c(DIM, '(your own key, platform.openai.com)') + '\n');
  process.stdout.write('  [4] Groq API       ' + c(DIM, '(free tier, console.groq.com)') + '\n');
  process.stdout.write('  [5] Skip for now   ' + c(DIM, '(captures signals, skips extraction)') + '\n');
  process.stdout.write('\n');

  const choice = await promptChoice('  Enter choice [1-5]: ', 1, 5);

  if (choice === null || choice === 5) {
    process.stdout.write(c(DIM, '  Skipped. Run `cc-habits init --provider <name>` any time to configure.\n'));
    return;
  }

  const nameMap: Record<number, string> = { 1: 'anthropic', 2: 'ollama', 3: 'openai', 4: 'groq' };
  await configureProvider(nameMap[choice]!, tick, dash);
}

async function configureProvider(provider: string, tick: string, dash: string): Promise<void> {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });

  // Cloud providers send redacted diffs off-machine, require explicit consent
  // in an interactive session. Non-interactive (--provider in a script) is itself
  // an explicit opt-in, so we don't block it.
  if (provider !== 'ollama' && process.stdin.isTTY) {
    const ok = await promptYesNo(`  Send redacted diffs to ${provider} to learn habits? [y/N] `);
    if (!ok) {
      process.stdout.write(c(DIM, '  Cancelled, no cloud provider configured. Try Ollama for fully local.\n'));
      return;
    }
  }

  if (provider === 'ollama') {
    // Try a quick reachability check so we can warn if Ollama isn't running.
    let ollamaOk = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(OLLAMA_DEFAULT_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      ollamaOk = res.ok;
    } catch { /* not running */ }

    if (ollamaOk) {
      process.stdout.write(`  ${tick} Ollama detected at ${OLLAMA_DEFAULT_URL}\n`);
    } else {
      process.stdout.write('\n');
      process.stdout.write(c(YELLOW, '  Ollama not detected at ' + OLLAMA_DEFAULT_URL + '\n'));
      process.stdout.write('  1. Install: ' + c(CYAN, 'https://ollama.com/download') + '\n');
      process.stdout.write('  2. Pull model: ' + c(BOLD, `ollama pull ${OLLAMA_DEFAULT_MODEL}`) + '\n');
      process.stdout.write('  3. Start: ' + c(BOLD, 'ollama serve') + '\n');
      process.stdout.write(c(DIM, '  Config written, re-run cc-habits init once Ollama is running to verify.\n'));
    }
    writeConfigFile(`provider: ollama\nollama_url: ${OLLAMA_DEFAULT_URL}\nollama_model: ${OLLAMA_DEFAULT_MODEL}\n`);
    process.stdout.write(`  ${tick} Ollama config saved (model: ${OLLAMA_DEFAULT_MODEL})\n`);
    return;
  }

  if (provider === 'anthropic') {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Get an API key at https://console.anthropic.com\n\n'));
    const key = await promptSecret('  Enter your Anthropic API key (hidden): ');
    if (key) {
      writeConfigFile(`anthropic_api_key: ${key}\n`);
      process.stdout.write(`  ${tick} API key saved to ~/.cc-habits/config.yml\n`);
    } else {
      process.stdout.write(`  ${dash} No key entered. Set ANTHROPIC_API_KEY env var before use.\n`);
    }
    return;
  }

  if (provider === 'openai') {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Get an API key at https://platform.openai.com\n\n'));
    const key = await promptSecret('  Enter your OpenAI API key (hidden): ');
    if (key) {
      writeConfigFile(`provider: openai\nopenai_api_key: ${key}\nopenai_model: gpt-4o-mini\n`);
      process.stdout.write(`  ${tick} OpenAI config saved (model: gpt-4o-mini)\n`);
    } else {
      process.stdout.write(`  ${dash} No key entered.\n`);
    }
    return;
  }

  if (provider === 'groq') {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Get a free API key at https://console.groq.com\n\n'));
    const key = await promptSecret('  Enter your Groq API key (hidden): ');
    if (key) {
      writeConfigFile(`provider: groq\ngroq_api_key: ${key}\ngroq_model: llama-3.3-70b-versatile\n`);
      process.stdout.write(`  ${tick} Groq config saved\n`);
    } else {
      process.stdout.write(`  ${dash} No key entered.\n`);
    }
    return;
  }

  process.stderr.write(`cc-habits: unknown provider '${provider}'. Choose: anthropic, ollama, openai, groq\n`);
}

// view ─────────────────────────────────────────────────────────────────────
export function cmdView(): number {
  const habitsMd = readHabitsMd();
  const allSignals = readSignals();
  const cats = parseHabits(habitsMd);

  const totalHabits = Object.values(cats).reduce((s, h) => s + h.length, 0);
  const activeHabits = Object.values(cats).flat().filter(h => (h.sessions_seen ?? 1) >= 2).length;
  const learningHabits = totalHabits - activeHabits;
  const totalSignals = allSignals.length;

  process.stdout.write('\n');
  process.stdout.write(c(BOLD + CYAN, '  cc-habits') + c(BOLD, ' · your coding habits\n'));
  process.stdout.write('\n');

  if (totalHabits === 0) {
    process.stdout.write(c(DIM, '  No habits learned yet.\n'));
    process.stdout.write(c(DIM, '  Use Claude Code for a session, then check back.\n'));
  } else {
    const hw = activeHabits === 1 ? 'habit' : 'habits';
    const cw = Object.keys(cats).length === 1 ? 'category' : 'categories';
    const sw = totalSignals === 1 ? 'signal' : 'signals';
    process.stdout.write(
      `  ${c(BOLD, String(activeHabits))} active ${hw} across ` +
      `${c(BOLD, String(Object.keys(cats).length))} ${cw}  ·  ` +
      c(DIM, `${learningHabits} learning  ·  ${totalSignals} ${sw} processed`) + '\n',
    );
    process.stdout.write('\n');

    for (const category of Object.keys(cats).sort()) {
      const habits = cats[category];
      const active = habits.filter(h => (h.sessions_seen ?? 1) >= 2);
      const learning = habits.filter(h => (h.sessions_seen ?? 1) < 2);
      if (active.length === 0 && learning.length === 0) continue;

      process.stdout.write(
        c(BOLD, `  ── ${category} `) + c(DIM, '─'.repeat(Math.max(0, 46 - category.length))) + '\n',
      );
      for (const h of active) renderHabitLine(h, false);
      for (const h of learning) renderHabitLine(h, true);
      process.stdout.write('\n');
    }
  }

  if (allSignals.length > 0) {
    process.stdout.write(c(BOLD, '  ── Recent signals ') + c(DIM, '─'.repeat(30)) + '\n');
    process.stdout.write('\n');
    for (const sig of allSignals.slice(-5)) {
      const ts = term((sig.ts ?? '').slice(0, 10));
      const f = term(sig.file ?? '');
      const diffLines = (sig.diff ?? '').split('\n').filter(ln => ln.startsWith('+') || ln.startsWith('-'));
      const removed = term(diffLines.find(ln => ln.startsWith('-'))?.slice(1).trim().slice(0, 45) ?? '');
      const added   = term(diffLines.find(ln => ln.startsWith('+'))?.slice(1).trim().slice(0, 45) ?? '');
      process.stdout.write(`  ${c(DIM, ts)}  ${c(CYAN, f)}\n`);
      if (removed) process.stdout.write(`    ${c(RED, '- ' + removed)}\n`);
      if (added)   process.stdout.write(`    ${c(GREEN, '+ ' + added)}\n`);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write(c(DIM, '  No signals yet. Make some edits in Claude Code.\n'));
    process.stdout.write('\n');
  }

  return 0;
}

function renderHabitLine(h: { rule: string; confidence: number; reinforcing: number; contradicting: number; sessions_seen: number; first_learned?: string }, isLearning: boolean): void {
  const bar = confidenceBar(h.confidence);
  const pct = `${Math.round(h.confidence * 100)}%`;
  const up = h.reinforcing ?? 0;
  const dn = h.contradicting ?? 0;
  const tag = isLearning ? c(YELLOW, ' (learning)') : '';
  process.stdout.write(`\n  ${term(h.rule)}${tag}\n`);
  process.stdout.write(
    `  [${bar}] ${c(BOLD, pct)}  ` +
    c(GREEN, `↑${up}`) + '  ' +
    (dn ? c(RED, `↓${dn}`) : c(DIM, `↓${dn}`)) +
    c(DIM, `  · ${h.sessions_seen ?? 1} session${h.sessions_seen === 1 ? '' : 's'}  · since ${h.first_learned ?? '?'}`) + '\n',
  );
}

// memories ────────────────────────────────────────────────────────────────
export function cmdMemoriesDelete(text: string): number {
  if (!text.trim()) {
    process.stderr.write('cc-habits memories --delete: requires a memory text string.\n');
    process.stderr.write('  Usage: cc-habits memories --delete "memory text"\n');
    return 1;
  }
  initMemoriesMd();
  const sections = parseMemories(readMemoriesMd());
  const normalised = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
  let found = false;
  for (const sectionMemories of Object.values(sections)) {
    const idx = sectionMemories.findIndex(
      m => m.text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ') === normalised,
    );
    if (idx >= 0) {
      sectionMemories.splice(idx, 1);
      found = true;
      break;
    }
  }
  addMemoryTombstone(text);
  writeMemoriesMd(serialiseMemories(sections));
  if (found) {
    process.stdout.write(`  memory deleted and tombstoned: ${text}\n`);
  } else {
    process.stdout.write(`  tombstoned (not found in memories.md): ${text}\n`);
  }
  return 0;
}

export function cmdMemoriesTombstones(): number {
  const list = readMemoryTombstones();
  if (list.length === 0) {
    process.stdout.write(c(DIM, '  No tombstoned memories.\n'));
    return 0;
  }
  process.stdout.write(c(BOLD, `\n  ${list.length} tombstoned memor${list.length === 1 ? 'y' : 'ies'}\n\n`));
  for (const t of list) process.stdout.write(`  ${c(DIM, t)}\n`);
  process.stdout.write('\n');
  return 0;
}

// Persist the memories-enabled flag and report the new state.
export function cmdMemoriesToggle(enabled: boolean): number {
  setMemoriesEnabled(enabled);
  if (enabled) {
    process.stdout.write(c(GREEN, '  ✓ memory learning enabled.\n'));
    process.stdout.write(c(DIM, '  Future sessions will learn from corrections you make to agent output.\n'));
    process.stdout.write(c(DIM, '  Next: keep coding, then run `cch memories` to see what was learned.\n'));
  } else {
    process.stdout.write(c(DIM, '  memory learning disabled. Existing memories are kept.\n'));
  }
  return 0;
}

// Shown when there are no memories yet, tailored to whether learning is on.
function printMemoriesEmptyState(enabled: boolean): void {
  if (enabled) {
    process.stdout.write(c(DIM, '  No memories recorded yet, memory learning is ON.\n'));
    process.stdout.write(c(DIM, '  They appear after sessions where you correct the agent. Keep coding.\n'));
  } else {
    process.stdout.write(c(DIM, '  No memories recorded yet, and memory learning is OFF.\n'));
    process.stdout.write(c(DIM, '  Enable it persistently:  cch memories --enable\n'));
    process.stdout.write(c(DIM, '  Or for one shell only:    export CC_HABITS_MEMORIES=1\n'));
  }
  process.stdout.write('\n');
}

export async function cmdMemories(): Promise<number> {
  initMemoriesMd();
  const memoriesMd = readMemoriesMd();
  const sections = parseMemories(memoriesMd);
  const allMemories = Object.values(sections).flat();
  const active = allMemories.filter(m => (m.sessions_seen ?? 1) >= 2);
  const candidates = allMemories.filter(m => (m.sessions_seen ?? 1) < 2);

  process.stdout.write('\n');
  process.stdout.write(c(BOLD + CYAN, '  cc-habits') + c(BOLD, ' · coding memories\n'));
  process.stdout.write(c(DIM, `  ${storagePaths.memoriesFile}\n`));
  process.stdout.write('\n');

  if (allMemories.length === 0) {
    const enabled = memoriesEnabled();
    // Offer to turn it on right here when disabled and running interactively.
    if (!enabled && process.stdin.isTTY) {
      const turnOn = await promptYesNo('  Enable memory learning now? [y/N] ');
      if (turnOn) return cmdMemoriesToggle(true);
    }
    printMemoriesEmptyState(enabled);
    return 0;
  }

  process.stdout.write(
    `  ${c(BOLD, String(active.length))} active ` +
    `· ${c(DIM, `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`)}\n`,
  );
  process.stdout.write(c(DIM, `  To delete: cc-habits memories --delete "memory text"\n\n`));

  for (const section of Object.keys(sections).sort()) {
    const memories = sections[section];
    if (!memories || memories.length === 0) continue;
    process.stdout.write(
      c(BOLD, `  ── ${section} `) + c(DIM, '─'.repeat(Math.max(0, 46 - section.length))) + '\n',
    );
    for (const memory of memories.filter(m => (m.sessions_seen ?? 1) >= 2)) renderMemoryLine(memory, false);
    for (const memory of memories.filter(m => (m.sessions_seen ?? 1) < 2)) renderMemoryLine(memory, true);
    process.stdout.write('\n');
  }

  return 0;
}

function renderMemoryLine(memory: Memory, isCandidate: boolean): void {
  const bar = confidenceBar(memory.confidence);
  const pct = `${Math.round(memory.confidence * 100)}%`;
  const tag = isCandidate ? c(YELLOW, ' (candidate)') : '';
  process.stdout.write(`\n  ${term(memory.text)}${tag}\n`);
  if (memory.trigger.length > 0) {
    process.stdout.write(c(DIM, `  trigger: ${term(memory.trigger.join(', '))}\n`));
  }
  if (memory.correction) {
    process.stdout.write(c(DIM, `  correction: ${term(memory.correction)}\n`));
  }
  process.stdout.write(
    `  [${bar}] ${c(BOLD, pct)}  ` +
    c(DIM, `seen ${memory.seen} · ${memory.sessions_seen} session${memory.sessions_seen === 1 ? '' : 's'} · last ${memory.last_seen ?? '?'}`) + '\n',
  );
}

// log (audit trail / Responsible AI) ────────────────────────────────────────
// The accountability surface: shows exactly what cc-habits captured and would
// send to the extractor. Content is already redacted at capture time. This lets
// a user verify what left (or would leave) their machine.
export function cmdLog(limit = 20): number {
  const signals = readSignals();
  process.stdout.write('\n');
  process.stdout.write(c(BOLD + CYAN, '  cc-habits') + c(BOLD, ' · capture log\n'));
  process.stdout.write(c(DIM, `  ${storagePaths.logFile}\n`));
  process.stdout.write(
    c(DIM, '  Diffs are redacted (email / PAN / card) at capture. Run `cc-habits reset --yes` to erase.\n'),
  );
  process.stdout.write('\n');

  if (signals.length === 0) {
    process.stdout.write(c(DIM, '  No signals captured yet.\n\n'));
    return 0;
  }

  const recent = signals.slice(-limit);
  process.stdout.write(
    c(DIM, `  showing ${recent.length} of ${signals.length} captured signal${signals.length === 1 ? '' : 's'}\n\n`),
  );
  for (const sig of recent) {
    const ts = term((sig.ts ?? '').slice(0, 19).replace('T', ' '));
    const lang = sig.language ? c(DIM, ` (${term(sig.language)})`) : '';
    process.stdout.write(`  ${c(DIM, ts)}  ${c(CYAN, term(sig.file ?? ''))}${lang}\n`);
    const diffLines = (sig.diff ?? '').split('\n').filter(ln => ln.startsWith('+') || ln.startsWith('-'));
    for (const ln of diffLines.slice(0, 4)) {
      if (ln.startsWith('+')) process.stdout.write(`    ${c(GREEN, term(ln.slice(0, 80)))}\n`);
      else process.stdout.write(`    ${c(RED, term(ln.slice(0, 80)))}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

// reset ────────────────────────────────────────────────────────────────────
export function cmdReset(yes: boolean): number {
  if (!yes) {
    process.stderr.write('cc-habits reset: requires --yes flag to confirm deletion.\n');
    return 1;
  }
  const deleted: string[] = [];
  for (const p of [
    storagePaths.habitsFile,
    storagePaths.memoriesFile,
    storagePaths.logFile,
    storagePaths.snapshotFile,
    storagePaths.pendingFile,
    storagePaths.memoryIndexFile,
    storagePaths.memoryPendingFile,
  ]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      deleted.push(p);
    }
  }
  if (deleted.length > 0) {
    for (const d of deleted) process.stdout.write(`  deleted ${d}\n`);
  } else {
    process.stdout.write('  nothing to delete\n');
  }
  process.stdout.write('cc-habits: reset complete. Hooks and tombstones remain.\n');
  return 0;
}

// pending (A4) ─────────────────────────────────────────────────────────────
export function cmdPending(action: 'show' | 'approve' | 'discard'): number {
  const pending = readPending();
  if (pending.length === 0) {
    process.stdout.write(c(DIM, '  No pending updates.\n'));
    process.stdout.write(c(DIM, '  New habits are automatically queued here after each session.\n'));
    process.stdout.write(c(DIM, '  Set CC_HABITS_AUTO=1 to skip review and auto-apply all habits.\n'));
    return 0;
  }

  if (action === 'show') {
    process.stdout.write(c(BOLD, `\n  ${pending.length} pending update${pending.length === 1 ? '' : 's'}\n\n`));
    for (const p of pending) {
      const decisionColor = p.decision === 'create' ? GREEN : p.decision === 'contradict' ? RED : YELLOW;
      process.stdout.write(`  ${c(decisionColor, term(p.decision.toUpperCase()))}  ${c(CYAN, `[${term(p.category)}]`)}  ${term(p.rule)}\n`);
      if (p.reasoning) process.stdout.write(c(DIM, `    └─ ${term(p.reasoning)}\n`));
    }
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Run `cc-habits pending --approve` to apply, or `cc-habits pending --discard` to drop.\n\n'));
    return 0;
  }

  if (action === 'discard') {
    clearPending();
    process.stdout.write(`  discarded ${pending.length} pending update${pending.length === 1 ? '' : 's'}\n`);
    return 0;
  }

  // approve
  const cats = parseHabits(readHabitsMd());
  const [newCount, updatedCount] = applyUpdates(cats, pendingToUpdates(pending));
  writeHabitsMd(serialiseHabits(cats));
  writeSnapshot(cats);
  clearPending();
  process.stdout.write(`  applied ${newCount} new, ${updatedCount} updated\n`);
  return 0;
}

// Shell wrapper (optional, opt-in) ─────────────────────────────────────────
// Prints a pending-habits banner to stderr, used by the shell wrapper before
// launching claude/gemini. Stays silent (and exits 0) when nothing is pending
// so it never adds noise to a clean session.
export function cmdSessionBanner(): number {
  const pending = readPending();
  if (pending.length === 0) return 0;
  const noun = pending.length === 1 ? 'suggestion' : 'suggestions';
  process.stderr.write(c(BOLD, `\n  cc-habits: ${pending.length} pending habit ${noun} to review\n`));
  for (const p of pending.slice(0, 5)) {
    process.stderr.write(c(DIM, `    - [${term(p.category)}] ${term(p.rule)}\n`));
  }
  if (pending.length > 5) process.stderr.write(c(DIM, `    ...and ${pending.length - 5} more\n`));
  process.stderr.write(c(DIM, '  Run `cch pending` to review, `cch pending --approve` to accept.\n\n'));
  return 0;
}

// Emits a shell snippet that wraps `claude` and `gemini` so the pending banner
// prints in the terminal before the tool launches. The user opts in by adding
// `eval "$(cc-habits shell-init)"` to their ~/.zshrc or ~/.bashrc. We only print
// the snippet, we never edit the user's rc file for them.
export function cmdShellInit(): number {
  // F5: embed the resolved absolute binary path so the wrapper does not depend on
  // PATH lookup of `cc-habits` (which a hijacked PATH entry could shadow). Fall
  // back to the bare name only when the install location cannot be determined.
  let cch = 'cc-habits';
  try {
    const hookBin = resolveHookBinaryPath();
    if (hookBin.includes(path.sep)) {
      const candidate = path.join(path.dirname(hookBin), 'cc-habits');
      if (fs.existsSync(candidate)) cch = candidate;
    }
  } catch { /* fall back to PATH-resolved cc-habits */ }

  // When we resolved an absolute path, call it directly (no PATH lookup). When we
  // could not, fall back to a PATH-guarded call so the wrapper still degrades safely.
  const runner = cch === 'cc-habits'
    ? 'command -v cc-habits >/dev/null 2>&1 && cc-habits session-banner 2>/dev/null || true'
    : `"${cch.replace(/"/g, '\\"')}" session-banner 2>/dev/null || true`;

  const snippet = `# cc-habits shell integration, add to ~/.zshrc or ~/.bashrc:
#   eval "$(cc-habits shell-init)"
# Prints pending habit suggestions before launching claude/gemini, then runs
# the real binary. The cc-habits path below is resolved at generation time to
# avoid PATH-hijack. Safe no-op when the binary is missing.
__cc_habits_banner() {
  ${runner}
}
claude() { __cc_habits_banner; command claude "$@"; }
gemini() { __cc_habits_banner; command gemini "$@"; }
`;
  process.stdout.write(snippet);
  return 0;
}

// Lists every coding tool cc-habits supports, how each is captured and injected,
// and whether it is currently detected on this machine.
export function cmdTools(): number {
  let detectedIds: Set<string>;
  try {
    detectedIds = new Set(detectInstalledTools().map(t => t.id));
  } catch {
    detectedIds = new Set();
  }

  process.stdout.write(c(BOLD, '\n  Supported tools\n\n'));
  for (const tool of SUPPORTED_TOOLS) {
    const installed = detectedIds.has(tool.id);
    const mark = installed ? c(GREEN, '✓') : c(DIM, '·');
    const status = installed ? c(GREEN, ' (detected)') : '';
    process.stdout.write(`  ${mark} ${c(BOLD, tool.name)}${status}\n`);
    process.stdout.write(c(DIM, `      capture: ${tool.capture}\n`));
    process.stdout.write(c(DIM, `      inject:  ${tool.inject}\n`));
  }
  process.stdout.write(c(DIM, '\n  ✓ = detected on this machine · · = supported but not detected\n'));
  process.stdout.write(c(DIM, '  Run `cch init` to register hooks for your detected tools.\n\n'));
  return 0;
}

// tombstone (A2 explicit command) ──────────────────────────────────────────
export function cmdTombstone(rule: string): number {
  if (!rule || !rule.trim()) {
    return cmdTombstones();
  }
  addTombstone(rule);
  process.stdout.write(`  tombstoned: ${rule}\n`);
  process.stdout.write(c(DIM, '  This rule will not be re-learned.\n'));
  return 0;
}

export function cmdTombstones(): number {
  const list = readTombstones();
  if (list.length === 0) {
    process.stdout.write(c(DIM, '  No tombstoned rules.\n'));
    return 0;
  }
  process.stdout.write(c(BOLD, `\n  ${list.length} tombstoned rule${list.length === 1 ? '' : 's'}\n\n`));
  for (const r of list) process.stdout.write(`  ✗ ${r}\n`);
  process.stdout.write('\n');
  return 0;
}

// diff (B1) ────────────────────────────────────────────────────────────────
export function cmdDiff(since?: number): number {
  const d = computeDiff(since);
  if (!d) {
    process.stdout.write(c(DIM, '  Not enough history yet. Run a Claude Code session first.\n'));
    return 0;
  }
  process.stdout.write(c(BOLD, '\n  Habits diff') + c(DIM, `  ${d.fromTs.slice(0, 19)} → ${d.toTs.slice(0, 19)}\n\n`));

  if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) {
    process.stdout.write(c(DIM, '  No changes.\n\n'));
    return 0;
  }

  if (d.added.length > 0) {
    process.stdout.write(c(GREEN, `  + ${d.added.length} added\n`));
    for (const a of d.added) process.stdout.write(`    ${c(GREEN, '+')} [${a.category}] ${a.habit.rule}\n`);
    process.stdout.write('\n');
  }
  if (d.removed.length > 0) {
    process.stdout.write(c(RED, `  - ${d.removed.length} removed\n`));
    for (const r of d.removed) process.stdout.write(`    ${c(RED, '-')} [${r.category}] ${r.habit.rule}\n`);
    process.stdout.write('\n');
  }
  if (d.changed.length > 0) {
    process.stdout.write(c(YELLOW, `  ~ ${d.changed.length} changed\n`));
    for (const ch of d.changed) {
      const arrow = ch.to > ch.from ? '↑' : '↓';
      const colour = ch.to > ch.from ? GREEN : RED;
      process.stdout.write(`    ${c(colour, arrow)} [${ch.category}] ${ch.rule}  ${ch.from.toFixed(2)} → ${c(BOLD, ch.to.toFixed(2))}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

// explain (B2) ─────────────────────────────────────────────────────────────
export function cmdExplain(query: string): number {
  if (!query) {
    process.stderr.write('cc-habits explain: requires a habit rule (or substring).\n');
    return 1;
  }
  const exp = explainHabit(query);
  if (!exp) {
    process.stdout.write(c(DIM, '  No matching habit found.\n'));
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, `  ${term(exp.rule)}\n`));
  process.stdout.write(c(DIM, `  Category: ${term(exp.category)}  ·  Confidence: ${(exp.confidence * 100).toFixed(0)}%  ·  Sessions: ${exp.sessions_seen}\n`));
  process.stdout.write(c(DIM, `  ↑${exp.reinforcing}  ↓${exp.contradicting}\n`));
  process.stdout.write('\n');
  if (exp.refs.length === 0) {
    process.stdout.write(c(DIM, '  No provenance recorded yet (habit predates v0.2 provenance tracking).\n\n'));
    return 0;
  }
  process.stdout.write(c(BOLD, '  Contributing signals:\n\n'));
  for (const ref of exp.refs) {
    process.stdout.write(`  ${c(CYAN, term(ref.file))}  ${c(DIM, term(ref.ts.slice(0, 19)))}  ${c(YELLOW, term(ref.decision))}\n`);
    const lines = ref.snippet.split('\n').slice(0, 4);
    for (const ln of lines) {
      if (ln.startsWith('+')) process.stdout.write(`    ${c(GREEN, term(ln.slice(0, 80)))}\n`);
      else if (ln.startsWith('-')) process.stdout.write(`    ${c(RED, term(ln.slice(0, 80)))}\n`);
      else process.stdout.write(`    ${c(DIM, term(ln.slice(0, 80)))}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

// lint (B3) ────────────────────────────────────────────────────────────────
export async function cmdLint(filePath: string, asJson: boolean): Promise<number> {
  if (!filePath) {
    process.stderr.write('cc-habits lint: requires a file path.\n  Usage: cc-habits lint <file>\n');
    return 1;
  }
  let findings;
  try {
    findings = await lintPath(filePath);
  } catch (e) {
    process.stderr.write(`cc-habits lint: ${String(e)}\n`);
    return 1;
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
    return findings.length > 0 ? 1 : 0;
  }
  if (findings.length === 0) {
    process.stdout.write(c(GREEN, '  ✓ ') + 'No habit violations found.\n');
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, `  ${findings.length} violation${findings.length === 1 ? '' : 's'} in ${filePath}\n\n`));
  for (const f of findings) {
    const loc = f.line > 0 ? `:${f.line}` : '';
    process.stdout.write(`  ${c(RED, '✗')} ${c(CYAN, filePath + loc)}\n`);
    process.stdout.write(`    ${c(YELLOW, f.rule)}\n`);
    if (f.snippet) process.stdout.write(`    ${c(DIM, '> ' + f.snippet)}\n`);
    process.stdout.write(`    ${f.explanation}\n\n`);
  }
  return 1;
}

// bootstrap ───────────────────────────────────────────────────────────────
export async function cmdBootstrap(): Promise<number> {
  const sessions = discoverSessions();

  if (sessions.length === 0) {
    process.stdout.write(c(DIM, '  No Claude Code sessions found for this project.\n'));
    process.stdout.write(c(DIM, '  Start a Claude Code session, make some edits, then try again.\n'));
    return 0;
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${c(BOLD, String(sessions.length))} session${sessions.length === 1 ? '' : 's'} found. ` +
    c(DIM, 'Extracting patterns...\n'),
  );

  try {
    const result = await bootstrap();

    if (result.signalsExtracted === 0) {
      process.stdout.write(c(DIM, `  Sessions found but no edits to learn from.\n\n`));
      return 0;
    }

    if (result.habitsLearned === 0 && result.habitsReinforced === 0) {
      process.stdout.write(c(DIM, '  No new patterns found (sessions may have already been processed).\n\n'));
      return 0;
    }

    process.stdout.write('\n');
    process.stdout.write(
      `  ${c(GREEN, '✓')} Scanned ${c(BOLD, String(result.sessionsWithEdits))} session${result.sessionsWithEdits === 1 ? '' : 's'}` +
      ` (${result.signalsExtracted} edits)\n`,
    );
    process.stdout.write(
      `  ${c(GREEN, '✓')} Learned ${c(BOLD, String(result.habitsLearned))} habit${result.habitsLearned === 1 ? '' : 's'}` +
      ` across ${c(BOLD, String(result.categories.length))} categor${result.categories.length === 1 ? 'y' : 'ies'}\n`,
    );
    if (result.habitsReinforced > 0) {
      process.stdout.write(`  ${c(GREEN, '✓')} Reinforced ${result.habitsReinforced} existing habit${result.habitsReinforced === 1 ? '' : 's'}\n`);
    }
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Run `cc-habits view` to see your habits.\n\n'));
    return 0;
  } catch (e) {
    process.stderr.write(`cc-habits bootstrap: ${String(e)}\n`);
    return 1;
  }
}

// export/import (C4) ───────────────────────────────────────────────────────
export function cmdExport(outputPath?: string, includeMemories = false): number {
  const content = exportProfile({ version: VERSION, outputPath, includeMemories });
  if (outputPath) {
    const note = includeMemories ? ' (habits + memories)' : '';
    process.stdout.write(`  exported${note} to ${outputPath}\n`);
  } else {
    process.stdout.write(content);
  }
  return 0;
}

export async function cmdImport(source: string): Promise<number> {
  if (!source) {
    process.stderr.write('cc-habits import: requires a file path or https:// URL.\n  Usage: cc-habits import <file.md|https://...>\n');
    return 1;
  }

  if (source.startsWith('http://')) {
    process.stderr.write('cc-habits import: only https:// URLs are supported (not http://).\n');
    return 1;
  }

  let incoming: string;
  if (source.startsWith('https://')) {
    process.stdout.write(c(DIM, `  fetching ${source}...\n`));
    try {
      incoming = await fetchProfile(source);
    } catch (e) {
      process.stderr.write(`cc-habits import: ${String(e)}\n`);
      return 1;
    }
  } else {
    if (!fs.existsSync(source)) {
      process.stderr.write(`cc-habits import: file not found: ${source}\n`);
      return 1;
    }
    incoming = fs.readFileSync(source, 'utf-8');
  }

  const result = importHabits(incoming);
  const memNote = result.memoriesImported !== undefined && result.memoriesImported > 0
    ? `, ${result.memoriesImported} memories imported`
    : '';
  process.stdout.write(`  imported: ${result.added} new habit${result.added === 1 ? '' : 's'}, ${result.merged} merged${memNote}\n`);
  return 0;
}

// sync (Patch 1: portable AGENTS.md / Cursor / Cline emitter) ───────────────
const VALID_SYNC_TARGETS: SyncTarget[] = ['agents', 'cursor', 'copilot', 'gemini', 'cline', 'aider', 'continue', 'jetbrains', 'windsurf'];

export function cmdSync(rawTargets: string[], dir?: string): number {
  // Default target is AGENTS.md, the cross-tool standard. `all` expands to every target.
  let targets: SyncTarget[];
  if (rawTargets.length === 0) {
    targets = ['agents'];
  } else if (rawTargets.includes('all')) {
    targets = [...VALID_SYNC_TARGETS];
  } else {
    const invalid = rawTargets.filter(t => !VALID_SYNC_TARGETS.includes(t as SyncTarget));
    if (invalid.length > 0) {
      process.stderr.write(
        `cc-habits sync: unknown target '${invalid[0]}'.\n` +
        `  Valid targets: ${VALID_SYNC_TARGETS.join(', ')}, all\n`,
      );
      return 1;
    }
    targets = rawTargets as SyncTarget[];
  }

  try {
    const result = syncTargets(targets, dir ? { baseDir: dir } : {});
    if (result.skipped) {
      process.stdout.write(c(DIM, '  No active habits to sync yet. Keep coding, habits graduate after 2 sessions.\n'));
      return 0;
    }
    process.stdout.write('\n');
    for (const p of result.written) {
      process.stdout.write(`  ${c(GREEN, '✓')} wrote ${p}\n`);
    }
    process.stdout.write(c(DIM, '\n  Any agent that reads these files now knows your habits.\n\n'));
    return 0;
  } catch (e) {
    process.stderr.write(`cc-habits sync: ${String(e)}\n`);
    return 1;
  }
}

// migrate ──────────────────────────────────────────────────────────────────
export function cmdMigrate(force = false): number {
  const result = runMigration(force);
  if (result.migrated) {
    process.stdout.write(`  migration complete: copied ${result.copiedFiles.length} files to ${storagePaths.habitsDir}\n`);
    if (result.claudeMdUpdated) {
      process.stdout.write(`  updated CLAUDE.md imports path.\n`);
    }
  } else {
    process.stdout.write(`  no migration needed or destination already populated.\n`);
  }
  return 0;
}

// capture ──────────────────────────────────────────────────────────────────
export function cmdCapture(opts: { file: string; diff: string; session?: string; source?: string }): number {
  const success = captureFromCli(opts);
  if (success) {
    return 0;
  }
  return 1;
}

// git-capture ──────────────────────────────────────────────────────────────
export async function cmdGitCapture(range?: string): Promise<number> {
  const { signalsCaptured } = runGitCapture(range);
  if (signalsCaptured > 0) {
    process.stdout.write(`  captured ${signalsCaptured} git commit signal${signalsCaptured === 1 ? '' : 's'}.\n`);
    if (shouldTriggerGitLearn()) {
      process.stdout.write(`  git signal threshold met. Triggering automated learn...\n`);
      await cmdLearn();
    }
  } else {
    process.stdout.write(`  no new git commit signals captured.\n`);
  }
  return 0;
}

// learn ────────────────────────────────────────────────────────────────────
export async function cmdLearn(opts: { session?: string; since?: number } = {}): Promise<number> {
  const allSignals = readSignals();
  let filtered = allSignals;
  
  if (opts.session) {
    filtered = allSignals.filter(s => s.session_id === opts.session);
  } else {
    const now = Date.now();
    const limitMs = (opts.since ?? 24) * 60 * 60 * 1000;
    
    const history = readHistory();
    const lastSnapshot = history[history.length - 1];
    const lastTs = lastSnapshot ? Date.parse(lastSnapshot.ts) : 0;
    
    filtered = allSignals.filter(s => {
      const sigTs = s.ts ? Date.parse(s.ts) : 0;
      if (opts.since !== undefined) {
        return (now - sigTs) <= limitMs;
      }
      return sigTs > lastTs;
    });
  }
  
  if (filtered.length < 3) {
    process.stdout.write(`  not enough signals to learn (need at least 3, found ${filtered.length}).\n`);
    return 0;
  }
  
  const { batch: capped, desc: batchDesc } = capBatch(filtered);
  process.stdout.write(`  learning from ${batchDesc} signal${filtered.length === 1 ? '' : 's'}...\n`);

  const habitsMd = readHabitsMd();
  const cats = parseHabits(habitsMd);

  const deleted = detectManualDeletes(cats);
  for (const d of deleted) addTombstone(d);

  const decayed = applyDecay(cats);
  
  const sessionId = opts.session || `learn-${new Date().toISOString().slice(0, 10)}`;
  let updates: Awaited<ReturnType<typeof extractRules>> = [];
  try {
    updates = await extractRules(capped, habitsMd);
  } catch (e) {
    const hint = providerHint(e);
    if (!hint) throw e;
    process.stdout.write(c(YELLOW, `  ${hint}\n`));
    return 0;
  }
  const changes: AppliedChange[] = [];
  const [newCount, updatedCount] = applyUpdates(cats, updates, { sessionId, changes });
  
  const autoApply = (process.env['CC_HABITS_AUTO'] || '').toLowerCase() === '1';
  const creates = updates.filter(u => (u.decision ?? '').toLowerCase() === 'create');
  let pendingCount = 0;
  if (!autoApply && creates.length > 0) {
    clearPending();
    const toAdd = toPending(creates);
    const deduped = toAdd.filter(p => p.rule);
    if (deduped.length > 0) {
      writePending(deduped);
      pendingCount = deduped.length;
    }
  } else {
    const warning = autoApplyWarning(creates.length);
    if (warning) process.stderr.write(c(YELLOW, '  ' + warning + '\n'));
  }

  const sessionLanguages = Array.from(
    new Set(capped.map(s => s.language).filter((l): l is string => !!l)),
  );
  if (sessionLanguages.length > 0) {
    for (const habits of Object.values(cats)) {
      for (const h of habits) {
        if (h.last_session_id !== sessionId) continue;
        const existing = new Set(h.languages ?? []);
        sessionLanguages.forEach(l => existing.add(l));
        h.languages = Array.from(existing).sort();
      }
    }
  }
  
  const serialised = serialiseHabits(cats);
  writeHabitsMd(serialised);
  writeSnapshot(cats);
  appendHistory({ ts: new Date().toISOString(), session_id: sessionId, habits_md: serialised });
  
  let memoryCandidatesCount = 0;
  if (memoriesEnabled()) {
    try {
      const memoriesMd = readMemoriesMd();
      const candidates = await extractMemoryCandidates(capped, memoriesMd);
      memoryCandidatesCount = applyMemoryUpdates(candidates);
    } catch (e) {
      const hint = providerHint(e);
      if (hint) process.stdout.write(c(YELLOW, `  memory extraction skipped: ${hint}\n`));
      logError(`learn: memory extraction failed: ${String(e)}`);
    }
  }
  
  const targets = readSyncTargets();
  if (targets.length > 0) {
    try {
      syncTargets(targets);
    } catch (e) {
      logError(`learn: sync failed: ${String(e)}`);
    }
  }
  
  const summary = formatStopSummary({
    newCount,
    updatedCount,
    decayed,
    tombstoned: deleted.length,
    changes,
    pendingCount,
    memoryCandidatesCount
  });
  process.stdout.write(summary + '\n');
  return 0;
}

// Helpers ──────────────────────────────────────────────────────────────────
function promptChoice(question: string, min: number, max: number): Promise<number | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (ch: string): void => {
      if (ch === '\x03') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(0);
      }
      const n = parseInt(ch, 10);
      if (!isNaN(n) && n >= min && n <= max) {
        process.stdout.write(ch + '\n');
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(n);
      }
      // ignore any other keypress
    };

    process.stdin.on('data', onData);
  });
}

export function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const done = (val: boolean, display: string): void => {
      process.stdout.write(display + '\n');
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(val);
    };

    const onData = (ch: string): void => {
      if (ch === '\x03') { done(false, ''); process.exit(0); }
      if (ch.toLowerCase() === 'y') done(true, 'y');
      else if (ch.toLowerCase() === 'n' || ch === '\r' || ch === '\n') done(false, 'n');
    };

    process.stdin.on('data', onData);
  });
}

export function promptYesNoDefaultTrue(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const done = (val: boolean, display: string): void => {
      process.stdout.write(display + '\n');
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(val);
    };

    const onData = (ch: string): void => {
      if (ch === '\x03') { done(false, ''); process.exit(0); }
      if (ch.toLowerCase() === 'y' || ch === '\r' || ch === '\n') done(true, 'y');
      else if (ch.toLowerCase() === 'n') done(false, 'n');
    };

    process.stdin.on('data', onData);
  });
}

function promptSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    let key = '';
    process.stdout.write(question);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (ch: string): void => {
      if (ch === '\n' || ch === '\r') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(key.trim());
      } else if (ch === '\x03') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '\x7f' || ch === '\b') {
        key = key.slice(0, -1);
      } else {
        key += ch;
      }
    };

    process.stdin.on('data', onData);
  });
}

export function cmdOn(): number {
  setGloballyDisabled(false);
  process.stdout.write(c(GREEN, '  ✓ cc-habits enabled.\n'));
  process.stdout.write(c(DIM, '  Capture and injection are now active.\n'));
  return 0;
}
 
export function cmdOff(): number {
  setGloballyDisabled(true);
  process.stdout.write(c(DIM, '  cc-habits disabled.\n'));
  process.stdout.write(c(DIM, '  Capture and injection are now paused.\n'));
  return 0;
}
