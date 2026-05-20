import fs from 'fs';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, readHabitsMd, readSignals, parseHabits,
  readPending, clearPending, writeHabitsMd, serialiseHabits, writeSnapshot,
  readTombstones, addTombstone,
} from './storage';
import { applyUpdates, pendingToUpdates } from './confidence';
import { registerHooks, addImportToClaudeMd } from './install';
import { computeDiff } from './diff';
import { explainHabit } from './explain';
import { exportHabits, importHabits } from './portable';
import { lintPath } from './lint';
import { discoverSessions, bootstrap } from './bootstrap';
import { syncTargets, SyncTarget } from './sync';

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

function confidenceBar(conf: number, width = 22): string {
  const filled = Math.round(conf * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = conf >= 0.70 ? GREEN : conf >= 0.50 ? YELLOW : RED;
  return c(color, bar);
}

// ── init ──────────────────────────────────────────────────────────────────────

export async function cmdInit(providerFlag?: string): Promise<number> {
  process.stdout.write(c(BOLD, 'cc-habits: initialising...\n'));

  initHabitsMd();
  initLog();

  const { postAdded, stopAdded, promptAdded } = registerHooks();
  const tick = '✓';
  const dash = '~';
  process.stdout.write(`  ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
  process.stdout.write(`  ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
  process.stdout.write(`  ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);

  const importAdded = addImportToClaudeMd();
  const sym = importAdded ? tick : dash;
  process.stdout.write(`  ${sym} habits.md import ${importAdded ? 'added to' : 'already in'} ~/.claude/CLAUDE.md\n`);

  const hasAnthropicEnv = !!process.env['ANTHROPIC_API_KEY'];
  const hasConfigFile   = fs.existsSync(CONFIG_FILE);

  if (providerFlag) {
    // --provider <name> skips the interactive menu and goes straight to that provider.
    await configureProvider(providerFlag, tick, dash);
  } else if (hasAnthropicEnv) {
    process.stdout.write(`  ${dash} ANTHROPIC_API_KEY found in environment\n`);
  } else if (hasConfigFile) {
    process.stdout.write(`  ${dash} Provider config already exists at ~/.claude/habits/config.yml\n`);
  } else {
    await showProviderMenu(tick, dash);
  }

  // Offer bootstrap from past sessions if this is a fresh install with a provider configured.
  // Re-check config file existence here — it may have just been written by showProviderMenu().
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

  process.stdout.write('\n');
  process.stdout.write(
    c(BOLD, 'cc-habits is ready.') + ' Start a Claude Code session to begin learning.\n',
  );
  process.stdout.write(c(DIM, '  Habits are stored at ~/.claude/habits/habits.md\n'));
  return 0;
}

async function showProviderMenu(tick: string, dash: string): Promise<void> {
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
  process.stdout.write('  [1] Anthropic API  ' + c(DIM, '(~$0.09/month — console.anthropic.com)') + '\n');
  process.stdout.write('  [2] Ollama         ' + c(DIM, '(free, local — ollama.com/download)') + '\n');
  process.stdout.write('  [3] OpenAI API     ' + c(DIM, '(your own key — platform.openai.com)') + '\n');
  process.stdout.write('  [4] Groq API       ' + c(DIM, '(free tier — console.groq.com)') + '\n');
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
      process.stdout.write(c(DIM, '  Config written — re-run cc-habits init once Ollama is running to verify.\n'));
    }
    fs.writeFileSync(
      CONFIG_FILE,
      `provider: ollama\nollama_url: ${OLLAMA_DEFAULT_URL}\nollama_model: ${OLLAMA_DEFAULT_MODEL}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
    process.stdout.write(`  ${tick} Ollama config saved (model: ${OLLAMA_DEFAULT_MODEL})\n`);
    return;
  }

  if (provider === 'anthropic') {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Get an API key at https://console.anthropic.com\n\n'));
    const key = await promptSecret('  Enter your Anthropic API key (hidden): ');
    if (key) {
      fs.writeFileSync(CONFIG_FILE, `anthropic_api_key: ${key}\n`, { encoding: 'utf-8', mode: 0o600 });
      process.stdout.write(`  ${tick} API key saved to ~/.claude/habits/config.yml\n`);
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
      fs.writeFileSync(
        CONFIG_FILE,
        `provider: openai\nopenai_api_key: ${key}\nopenai_model: gpt-4o-mini\n`,
        { encoding: 'utf-8', mode: 0o600 },
      );
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
      fs.writeFileSync(
        CONFIG_FILE,
        `provider: groq\ngroq_api_key: ${key}\ngroq_model: llama-3.3-70b-versatile\n`,
        { encoding: 'utf-8', mode: 0o600 },
      );
      process.stdout.write(`  ${tick} Groq config saved\n`);
    } else {
      process.stdout.write(`  ${dash} No key entered.\n`);
    }
    return;
  }

  process.stderr.write(`cc-habits: unknown provider '${provider}'. Choose: anthropic, ollama, openai, groq\n`);
}

// ── view ──────────────────────────────────────────────────────────────────────

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
      const ts = (sig.ts ?? '').slice(0, 10);
      const f = sig.file ?? '';
      const diffLines = (sig.diff ?? '').split('\n').filter(ln => ln.startsWith('+') || ln.startsWith('-'));
      const removed = diffLines.find(ln => ln.startsWith('-'))?.slice(1).trim().slice(0, 45) ?? '';
      const added   = diffLines.find(ln => ln.startsWith('+'))?.slice(1).trim().slice(0, 45) ?? '';
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
  process.stdout.write(`\n  ${h.rule}${tag}\n`);
  process.stdout.write(
    `  [${bar}] ${c(BOLD, pct)}  ` +
    c(GREEN, `↑${up}`) + '  ' +
    (dn ? c(RED, `↓${dn}`) : c(DIM, `↓${dn}`)) +
    c(DIM, `  · ${h.sessions_seen ?? 1} session${h.sessions_seen === 1 ? '' : 's'}  · since ${h.first_learned ?? '?'}`) + '\n',
  );
}

// ── reset ─────────────────────────────────────────────────────────────────────

export function cmdReset(yes: boolean): number {
  if (!yes) {
    process.stderr.write('cc-habits reset: requires --yes flag to confirm deletion.\n');
    return 1;
  }
  const deleted: string[] = [];
  for (const p of [storagePaths.habitsFile, storagePaths.logFile, storagePaths.snapshotFile, storagePaths.pendingFile]) {
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

// ── pending (A4) ──────────────────────────────────────────────────────────────

export function cmdPending(action: 'show' | 'approve' | 'discard'): number {
  const pending = readPending();
  if (pending.length === 0) {
    process.stdout.write(c(DIM, '  No pending updates.\n'));
    process.stdout.write(c(DIM, '  Run cc-habits with --review mode (set CC_HABITS_REVIEW=1) for the next session to stage updates.\n'));
    return 0;
  }

  if (action === 'show') {
    process.stdout.write(c(BOLD, `\n  ${pending.length} pending update${pending.length === 1 ? '' : 's'}\n\n`));
    for (const p of pending) {
      const decisionColor = p.decision === 'create' ? GREEN : p.decision === 'contradict' ? RED : YELLOW;
      process.stdout.write(`  ${c(decisionColor, p.decision.toUpperCase())}  ${c(CYAN, `[${p.category}]`)}  ${p.rule}\n`);
      if (p.reasoning) process.stdout.write(c(DIM, `    └─ ${p.reasoning}\n`));
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

// ── tombstone (A2 explicit command) ───────────────────────────────────────────

export function cmdTombstone(rule: string): number {
  if (!rule) {
    process.stderr.write('cc-habits tombstone: requires a rule string.\n  Usage: cc-habits tombstone "Use strict mode"\n');
    return 1;
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

// ── diff (B1) ─────────────────────────────────────────────────────────────────

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

// ── explain (B2) ──────────────────────────────────────────────────────────────

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
  process.stdout.write(c(BOLD, `  ${exp.rule}\n`));
  process.stdout.write(c(DIM, `  Category: ${exp.category}  ·  Confidence: ${(exp.confidence * 100).toFixed(0)}%  ·  Sessions: ${exp.sessions_seen}\n`));
  process.stdout.write(c(DIM, `  ↑${exp.reinforcing}  ↓${exp.contradicting}\n`));
  process.stdout.write('\n');
  if (exp.refs.length === 0) {
    process.stdout.write(c(DIM, '  No provenance recorded yet (habit predates v0.2 provenance tracking).\n\n'));
    return 0;
  }
  process.stdout.write(c(BOLD, '  Contributing signals:\n\n'));
  for (const ref of exp.refs) {
    process.stdout.write(`  ${c(CYAN, ref.file)}  ${c(DIM, ref.ts.slice(0, 19))}  ${c(YELLOW, ref.decision)}\n`);
    const lines = ref.snippet.split('\n').slice(0, 4);
    for (const ln of lines) {
      if (ln.startsWith('+')) process.stdout.write(`    ${c(GREEN, ln.slice(0, 80))}\n`);
      else if (ln.startsWith('-')) process.stdout.write(`    ${c(RED, ln.slice(0, 80))}\n`);
      else process.stdout.write(`    ${c(DIM, ln.slice(0, 80))}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

// ── lint (B3) ─────────────────────────────────────────────────────────────────

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

// ── bootstrap ────────────────────────────────────────────────────────────────

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

// ── export/import (C4) ────────────────────────────────────────────────────────

export function cmdExport(outputPath?: string): number {
  const md = exportHabits(outputPath);
  if (outputPath) {
    process.stdout.write(`  exported to ${outputPath}\n`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

export function cmdImport(inputPath: string): number {
  if (!inputPath) {
    process.stderr.write('cc-habits import: requires a file path.\n  Usage: cc-habits import <file.md>\n');
    return 1;
  }
  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`cc-habits import: file not found: ${inputPath}\n`);
    return 1;
  }
  const incoming = fs.readFileSync(inputPath, 'utf-8');
  const result = importHabits(incoming);
  process.stdout.write(`  imported: ${result.added} new, ${result.merged} merged\n`);
  return 0;
}

// ── sync (Patch 1: portable AGENTS.md / Cursor / Cline emitter) ────────────────

const VALID_SYNC_TARGETS: SyncTarget[] = ['agents', 'cursor', 'cline'];

export function cmdSync(rawTargets: string[], dir?: string): number {
  // Default target is AGENTS.md — the cross-tool standard. `all` expands to every target.
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
      process.stdout.write(c(DIM, '  No active habits to sync yet. Keep coding — habits graduate after 2 sessions.\n'));
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function promptYesNo(question: string): Promise<boolean> {
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
