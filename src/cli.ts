import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  storagePaths, initHabitsMd, initLog, readHabitsMd, readSignals, parseHabits,
  writeHabitsMd, serialiseHabits, writeSnapshot,
  readTombstones, addTombstone, initMemoriesMd, readMemoriesMd, writeMemoriesMd,
  parseMemories, serialiseMemories, addMemoryTombstone, readMemoryTombstones,
  readHistory, appendHistory, logError, detectManualDeletes, applyMemoryUpdates,
  getRuleHash,
  type Memory, type Signal, type Habit,
} from './storage';
import { applyUpdates, applyDecay, type AppliedChange } from './confidence';
import { runSelectMenu } from './menu';
import { registerHooks, addImportToClaudeMd, installLocalGitHook, installGlobalGitTemplateHook, registerJsonHooks, registerCodexHooks, registerKimiHooks, registerClineHooks, resolveHookBinaryPath, deregisterHooks, removeImportFromClaudeMd, uninstallLocalGitHook, uninstallGlobalGitTemplateHook, deregisterJsonHooks, deregisterKimiHooks, deregisterClineHooks, areHooksRegistered, hookProofPaths, readRegisteredHooks } from './install';
import { computeDiff } from './diff';
import { explainHabit } from './explain';
import { exportProfile, importHabits, fetchProfile } from './portable';
import { lintPath } from './lint';
import { discoverSessions, bootstrap, type SessionFile } from './bootstrap';
import { scanRepo, type RepoScanResult } from './repo-scan';
import { syncTargets, SyncTarget, readSyncTargets, writePreferencesFile } from './sync';
import { runMigration } from './migrate';
import { captureFromCli } from './capture';
import { runGitCapture, shouldTriggerGitLearn } from './git-collector';
import { extractRules, extractMemoryCandidates } from './extractor';
import { ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError, ProviderAuthError, ProviderNotInstalledError, ProviderQuotaError, resolveProviderLabel, hasUsableProvider, isParkedProvider } from './providers';
import { memoriesEnabled, setMemoriesEnabled, consentGiven, recordConsent, setGloballyDisabled, getConfigValue, isGloballyDisabled } from './config';
import { formatStopSummary, autoApplyWarning } from './hook';
import { detectInstalledTools, isCliOnPath } from './detect';
import { SUPPORTED_TOOLS } from './supported';
import { explainProviderError } from './provider-errors';

export const VERSION = '0.7.10';

// Turn a provider failure into a plain-language, actionable hint. Returns
// undefined for non-provider errors so the caller can rethrow them.
const KNOWN_PROVIDER_ERRORS = [
  ProviderAuthError, ProviderNotInstalledError, ProviderQuotaError,
  ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError,
] as const;
function providerHint(e: unknown): string | undefined {
  if (!KNOWN_PROVIDER_ERRORS.some(T => e instanceof T)) return undefined;
  const explained = explainProviderError(e);
  return `${explained.what} · ${explained.side} · ${explained.nextStep}`;
}

function formatSessionBreakdown(sessions: SessionFile[]): string {
  const counts: Record<string, number> = { 'Claude Code': 0, 'Codex CLI': 0, 'Gemini CLI': 0, 'Kimi Code CLI': 0 };

  for (const s of sessions) {
    if (s.tool === 'claude-code') {
      counts['Claude Code']++;
    } else if (s.tool === 'codex') {
      counts['Codex CLI']++;
    } else if (s.tool === 'gemini') {
      counts['Gemini CLI']++;
    } else if (s.tool === 'kimi') {
      counts['Kimi Code CLI']++;
    }
  }

  const parts: string[] = [];

  if (counts['Claude Code'] > 0) {
    parts.push(`${counts['Claude Code']} Claude Code`);
  }

  if (counts['Codex CLI'] > 0) {
    parts.push(`${counts['Codex CLI']} Codex CLI`);
  }

  if (counts['Gemini CLI'] > 0) {
    parts.push(`${counts['Gemini CLI']} Gemini CLI`);
  }

  if (counts['Kimi Code CLI'] > 0) {
    parts.push(`${counts['Kimi Code CLI']} Kimi Code CLI`);
  }

  if (parts.length === 0) {
    return '';
  }

  return ` (${parts.join(', ')})`;
}

// Signal batch capping lives in batch.ts so the Stop hook (hook.ts) and this CLI
// path share one definition of the limits. Imported for local use here and
// re-exported so existing importers (tests) keep working.
import { capBatch } from './batch';
export { capBatch };

// Config file path is derived from storagePaths so CC_HABITS_DIR overrides
// both data files AND the provider config in one environment variable.
import {
  c, BOLD, DIM, GREEN, YELLOW, RED, CYAN, RESET, NO_COLOR, term, tildePath,
  confidenceBar, renderBrandedCard, renderHabitLine,
  printMemoriesEmptyState, renderMemoryLine,
  promptChoice, promptYesNo, promptYesNoDefaultTrue, promptSecret
} from './cli-ui';

import {
  configureProvider, interactiveOllamaSetup, showProviderMenu, OLLAMA_DEFAULT_MODEL,
  validateProviderFlag, reconfigureProviderMenu
} from './cli-provider';

export {
  c, BOLD, DIM, GREEN, YELLOW, RED, CYAN, RESET, NO_COLOR,
  promptYesNo, promptYesNoDefaultTrue,
  renderBrandedCard, confidenceBar, renderHabitLine,
  printMemoriesEmptyState, renderMemoryLine,
  promptChoice, promptSecret
};

const CONFIG_FILE = storagePaths.configFile;

const CONSENT_NOTICE = `
  cc-habits captures code diffs from your AI coding sessions and sends them to
  your chosen LLM provider (Anthropic, OpenAI, Groq, or a local Ollama model)
  to extract your coding habits. It also scans your repository on setup and manual command.

  What leaves your machine: redacted diffs and sampled file contents.
  What stays local:         habits.md, log.jsonl, memories.md, config.yml.
  What cc-habits stores:    nothing. There are no cc-habits servers.

  Review the full privacy policy: https://github.com/Shreyan1/cc-habits/blob/main/PRIVACY.md
`;

// Show the user real proof of what was just registered: the resolved file path
// plus the exact cc-habits hook commands read back from disk (not echoed from
// intent). Best-effort and silent on any error, so it can never block init.
function printHookProof(toolId: string, settingsPath: string): void {
  try {
    for (const file of hookProofPaths(toolId, settingsPath)) {
      const hooks = readRegisteredHooks(file);
      if (hooks.length === 0) continue;
      process.stdout.write(c(DIM, `    ↳ proof, written to ${tildePath(file)}:\n`));
      for (const { event, command } of hooks) {
        process.stdout.write(c(DIM, `        ${(event + ':').padEnd(17)} ${command}\n`));
      }
    }
  } catch {
    // Proof is best-effort, never block or fail init over it.
  }
}

export async function cmdInit(providerFlag?: string): Promise<number> {
  // Fail fast on a bad --provider value BEFORE any side effects (consent, hook
  // registration, repo scan). Otherwise an invalid provider like `codex` would
  // run the whole init, prompt to send diffs to a nonexistent provider, then
  // silently leave the prior provider in place, confusing the user.
  if (providerFlag) {
    const err = validateProviderFlag(providerFlag);
    if (err) {
      process.stderr.write(err + '\n');
      return 1;
    }
  }

  renderBrandedCard('initialising...', 'Setting up hooks and configurations');

  // L5: consent gate, show once, skip if already recorded, abort on N.
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

  // Track whether Codex was wired this run. Codex edits frequently via shell
  // (sed/perl/apply_patch), which the PostToolUse hook cannot see, so we steer
  // the user toward git capture (which sees every edit regardless of how made).
  // Declared at function scope because the git-capture prompt below reads it.
  let codexRegistered = false;

  const detected = detectInstalledTools();
  if (detected.length > 0) {
    process.stdout.write(`\n  Detected installed tools:\n`);
    for (const tool of detected) {
      process.stdout.write(`    • ${tool.name}\n`);
    }
    process.stdout.write('\n');

    const hookBin = resolveHookBinaryPath();

    let first = true;
    for (const tool of detected) {
      if (!first) {
        process.stdout.write('\n');
      }
      first = false;

      if (tool.id === 'claude-code') {
        const register = await promptYesNoDefaultTrue('  Register hooks in Claude Code? [Y/n] ');
        if (register) {
          process.stdout.write('\n');
          const { postAdded, stopAdded, promptAdded, sessionStartAdded } = registerHooks(hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${sessionStartAdded ? tick : dash} SessionStart hook ${sessionStartAdded ? 'registered' : 'already registered'}\n`);
          const importAdded = addImportToClaudeMd();
          process.stdout.write(`    ${importAdded ? tick : dash} preferences.md import ${importAdded ? 'added to' : 'already in'} ~/.claude/CLAUDE.md\n`);
          printHookProof('claude-code', tool.settingsPath);
        }
      } else if (tool.id === 'gemini') {
        const register = await promptYesNoDefaultTrue('  Register hooks in Gemini CLI? [Y/n] ');
        if (register) {
          process.stdout.write('\n');
          const { postAdded, stopAdded, promptAdded, sessionStartAdded } = registerJsonHooks(tool.settingsPath, 'gemini', hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} AfterTool hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} AfterAgent hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} BeforeAgent hook ${promptAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${sessionStartAdded ? tick : dash} SessionStart hook ${sessionStartAdded ? 'registered' : 'already registered'}\n`);
          printHookProof('gemini', tool.settingsPath);
        }
      } else if (tool.id === 'codex') {
        const register = await promptYesNoDefaultTrue('  Register hooks in Codex CLI? [Y/n] ');
        if (register) {
          codexRegistered = true;
          process.stdout.write('\n');
          const { postAdded, promptAdded } = registerCodexHooks(tool.settingsPath, hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook (captures edits) ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} UserPromptSubmit hook (compiles habits) ${promptAdded ? 'registered' : 'already registered'}\n`);
          printHookProof('codex', tool.settingsPath);
          // Codex registers newly-added hooks as untrusted/disabled until the
          // user approves them, so a freshly written hook does NOT fire yet.
          process.stdout.write('\n');
          process.stdout.write(c(YELLOW, '    ! Codex disables new hooks until you trust them.\n'));
          process.stdout.write(c(DIM,    '      Open Codex: it will prompt that "hooks are new or changed",\n'));
          process.stdout.write(c(DIM,    '      approve the cc-habits hooks (or enable them in Codex\'s Hooks view).\n'));
          process.stdout.write(c(DIM,    '      Until then Codex captures nothing; `cch bootstrap` still learns from past sessions.\n'));
          // The hook only sees Codex's structured edit tool. When Codex (often with
          // non-Anthropic models) edits via shell (sed/perl), the hook fires but has
          // no diff to capture. Git capture is the reliable channel for those.
          process.stdout.write(c(DIM,    '      Note: Codex often edits via shell (sed/perl) the hook cannot see.\n'));
          process.stdout.write(c(DIM,    '      Enabling git capture below ensures those edits are still recorded.\n'));
        }
      } else if (tool.id === 'kimi') {
        const register = await promptYesNoDefaultTrue('  Register hooks in Kimi Code CLI? [Y/n] ');
        if (register) {
          process.stdout.write('\n');
          const { postAdded, stopAdded, promptAdded, sessionStartAdded } = registerKimiHooks(tool.settingsPath, hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${sessionStartAdded ? tick : dash} SessionStart hook ${sessionStartAdded ? 'registered' : 'already registered'}\n`);
          printHookProof('kimi', tool.settingsPath);
        }
      } else if (tool.id === 'cline') {
        const register = await promptYesNoDefaultTrue('  Register hooks in Cline/RooCode? [Y/n] ');
        if (register) {
          process.stdout.write('\n');
          const { postAdded, stopAdded } = registerClineHooks(tool.settingsPath, hookBin);
          process.stdout.write(`    ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
          process.stdout.write(`    ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
          printHookProof('cline', tool.settingsPath);
        }
      } else if (tool.id === 'cursor') {
        process.stdout.write(`  ${dash} Cursor has no hooks; enable Git capture below to learn from its edits.\n`);
      }
    }
    process.stdout.write('\n');
  } else {
    const { postAdded, stopAdded, promptAdded } = registerHooks();
    process.stdout.write(`  ${postAdded ? tick : dash} PostToolUse hook ${postAdded ? 'registered' : 'already registered'}\n`);
    process.stdout.write(`  ${stopAdded ? tick : dash} Stop hook ${stopAdded ? 'registered' : 'already registered'}\n`);
    process.stdout.write(`  ${promptAdded ? tick : dash} UserPromptSubmit hook ${promptAdded ? 'registered' : 'already registered'}\n`);
    const importAdded = addImportToClaudeMd();
    process.stdout.write(`  ${importAdded ? tick : dash} preferences.md import ${importAdded ? 'added to' : 'already in'} ~/.claude/CLAUDE.md\n`);
    printHookProof('claude-code', '');
  }

  if (providerFlag) {
    await configureProvider(providerFlag, tick, dash);
  } else if (hasUsableProvider()) {
    // A supported provider with its credential is already set up. Don't assume it
    // silently: let the user keep it, switch provider/key, or use Ollama. A parked
    // CLI provider is NOT usable, so it falls through to setup below instead of
    // being offered as a "keep" option.
    await reconfigureProviderMenu(resolveProviderLabel(), tick, dash);
  } else {
    await showProviderMenu(tick, dash);
  }

  const providerReady = hasUsableProvider();
  if (!providerReady) {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  cc-habits is capturing your edits now, but it needs an AI provider to turn them into habits.\n'));
    process.stdout.write(c(DIM, '  Add one any time:  cch init --provider anthropic   (API key)\n'));
    process.stdout.write(c(DIM, '  No key? Run a free local model:  https://ollama.com/download   then  cch init --provider ollama\n'));
  }
  const habitsEmpty = parseHabits(readHabitsMd());
  const hasExistingHabits = Object.values(habitsEmpty).some(h => h.length > 0);

  if (providerReady && !hasExistingHabits) {
    const sessions = discoverSessions();
    if (sessions.length > 0) {
      process.stdout.write('\n');
      process.stdout.write(
        `  Found ${c(BOLD, String(sessions.length))} session${sessions.length === 1 ? '' : 's'}${formatSessionBreakdown(sessions)} for this project.\n`,
      );
      const yes = await promptYesNoDefaultTrue('  Bootstrap habits from past sessions? (learns habits from your existing work instantly) [Y/n] ');
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

  const inGitRepo = fs.existsSync('.git');
  if (inGitRepo) {
    // When Codex is wired, git capture is the dependable channel for its
    // shell-based edits, so recommend it (default Yes) rather than default No.
    if (codexRegistered) {
      process.stdout.write(c(DIM, '  Recommended for Codex: git capture records edits the hook misses (shell/sed/perl).\n'));
    }
    const installLocal = codexRegistered
      ? await promptYesNoDefaultTrue('  Install git capture hook locally in this project? [Y/n] ')
      : await promptYesNo('  Install git capture hook locally in this project? [y/N] ');
    if (installLocal) {
      const added = installLocalGitHook();
      const gitMark = added === 'installed' ? tick : added === 'already' ? dash : '!';
      const gitMsg  = added === 'installed' ? 'installed' : added === 'already' ? 'already installed' : 'failed to install';
      process.stdout.write(`  ${gitMark} Local Git post-commit hook ${gitMsg}\n`);
    }
    process.stdout.write('\n');
  }

  const globalHookFile = path.join(os.homedir(), '.git-templates', 'hooks', 'post-commit');
  let globalHookAlready = false;
  try {
    const ghContent = fs.readFileSync(globalHookFile, 'utf-8');
    globalHookAlready = ghContent.includes('cc-habits git-capture') || ghContent.includes('cch git-capture');
  } catch { /* not installed yet */ }

  if (globalHookAlready) {
    process.stdout.write(`  ${dash} Global Git template post-commit hook already installed\n`);
  } else {
    const installGlobal = await promptYesNo('  Install git capture hook globally for all new repositories? [y/N] ');
    if (installGlobal) {
      const added = installGlobalGitTemplateHook();
      const gitMark = added === 'installed' ? tick : added === 'already' ? dash : '!';
      const gitMsg  = added === 'installed' ? 'installed' : added === 'already' ? 'already installed' : 'failed to install';
      process.stdout.write(`  ${gitMark} Global Git template post-commit hook ${gitMsg}\n`);
    }
  }
  process.stdout.write('\n');

  // Enable memory learning by default for new installs. If the user already has
  // an explicit setting (from a previous init or manual edit) leave it alone.
  if (!getConfigValue('memories_enabled')) {
    setMemoriesEnabled(true);
    process.stdout.write(`  ${tick} Memory learning enabled by default.\n`);
    process.stdout.write(c(DIM, '  To disable at any time: cch memories --disable\n'));
  }

  // One-time cold scan of this repository: infer habits from its source and
  // memories from its CLAUDE.md/AGENTS.md, applied directly. Runs once per repo
  // (guarded); re-run any time with `cch learn --repo`. Only attempted when a
  // provider can actually run it: without one we already showed how to add one
  // above, so printing a scan that is guaranteed to skip would just be noise.
  if (providerReady) {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Scanning this repository for habits...\n'));
    try {
      const scan = await scanRepo({
        confirm: () => promptYesNoDefaultTrue('   Proceed with scan? [Y/n] '),
      });
      renderRepoScan(scan);
    } catch {
      process.stdout.write(c(DIM, '  Repo scan skipped. Run `cch learn --repo` to retry.\n'));
    }
  }

  process.stdout.write('\n\n');
  process.stdout.write(
    c(BOLD, 'cc-habits is ready.') + ' Start a coding session or commit changes to begin learning.\n',
  );
  process.stdout.write(
    c(DIM, '  To verify: run `cch status` after your first session. It shows when each tool last fired the hook,\n') +
    c(DIM, '  logged only when the tool itself runs it (liveness proof, not just "registered").\n'),
  );
  return 0;
}

// view ─────────────────────────────────────────────────────────────────────
export function renderHabitsView(): number {
  const habitsMd = readHabitsMd();
  const allSignals = readSignals();
  const cats = parseHabits(habitsMd);

  const totalHabits = Object.values(cats).reduce((s, h) => s + h.length, 0);
  const activeHabits = Object.values(cats).flat().filter(h => (h.sessions_seen ?? 1) >= 2).length;
  const learningHabits = totalHabits - activeHabits;
  const totalSignals = allSignals.length;

  const provider = getConfigValue('provider') || 'not set';
  const model = getConfigValue(
    provider === 'ollama' ? 'ollama_model' :
    provider === 'openai' ? 'openai_model' :
    provider === 'groq' ? 'groq_model' : ''
  );
  const providerDisplay = provider === 'not set' ? 'no provider' : `${provider}${model ? ` ${model}` : ''}`;
  const statusDisplay = isGloballyDisabled() ? 'Disabled' : `Active  ·  ${providerDisplay}`;

  renderBrandedCard('your coding habits', statusDisplay);

  // Session awareness block
  const activeSessionId = process.env['CLAUDE_SESSION_ID'];
  const resolvedSessionId = activeSessionId || (allSignals.length > 0 ? allSignals[allSignals.length - 1].session_id : undefined);
  if (resolvedSessionId) {
    const sessionSignals = allSignals.filter(s => s.session_id === resolvedSessionId);
    const sessionCreated: Habit[] = [];
    const sessionReinforced: Habit[] = [];
    for (const category of Object.keys(cats)) {
      for (const h of cats[category]) {
        if (h.last_session_id === resolvedSessionId) {
          if ((h.sessions_seen ?? 1) === 1) {
            sessionCreated.push(h);
          } else {
            sessionReinforced.push(h);
          }
        }
      }
    }
    if (sessionSignals.length > 0 || sessionCreated.length > 0 || sessionReinforced.length > 0) {
      process.stdout.write(
        c(BOLD, '  ── This session ') + c(DIM, '─'.repeat(32)) + '\n'
      );
      process.stdout.write(`    Session ID: ${c(DIM, resolvedSessionId)}\n`);
      process.stdout.write(`    Signals:    ${c(BOLD, String(sessionSignals.length))} captured\n`);
      if (sessionCreated.length > 0 || sessionReinforced.length > 0) {
        process.stdout.write(`    Changes:\n`);
        for (const h of sessionCreated) {
          process.stdout.write(`      ${c(GREEN, '+')} ${h.rule} (learning)\n`);
        }
        for (const h of sessionReinforced) {
          process.stdout.write(`      ${c(CYAN, '^')} ${h.rule} (confidence: ${Math.round(h.confidence * 100)}%)\n`);
        }
      } else {
        process.stdout.write(`    Changes:    no habit changes yet\n`);
      }
      process.stdout.write('\n');
    }
  }

  if (totalHabits === 0) {
    process.stdout.write(c(DIM, '  No habits learned yet.\n'));
    process.stdout.write(c(DIM, '  Use Claude Code for a session, then check back.\n'));
  } else {
    const memoriesMd = readMemoriesMd();
    const memories = parseMemories(memoriesMd);
    const totalMemories = Object.values(memories).flat().length;

    const hw = activeHabits === 1 ? 'habit' : 'habits';
    const cw = Object.keys(cats).length === 1 ? 'category' : 'categories';
    const sw = totalSignals === 1 ? 'signal' : 'signals';
    const memSuffix = memoriesEnabled() && totalMemories > 0
      ? `  ·  ${c(BOLD, String(totalMemories))} memor${totalMemories === 1 ? 'y' : 'ies'}`
      : '';

    process.stdout.write(
      `  ${c(BOLD, String(activeHabits))} active ${hw} across ` +
      `${c(BOLD, String(Object.keys(cats).length))} ${cw}  ·  ` +
      c(DIM, `${learningHabits} learning  ·  ${totalSignals} ${sw} processed`) +
      c(DIM, memSuffix) + '\n',
    );
    if (learningHabits > 0) {
      process.stdout.write(c(DIM, '  (learning habits activate after 1 more session)\n'));
    }
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
      const diffLines = (sig.diff ?? '')
        .split('\n')
        .filter(ln => (ln.startsWith('+') && !ln.startsWith('+++')) || (ln.startsWith('-') && !ln.startsWith('---')));
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

export async function cmdView(): Promise<number> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const choice = await runSelectMenu(
      `  ${c(BOLD + CYAN, 'Select what you would like to view (use ↑/↓ keys):')}`,
      [
        { label: 'habits       Show current habits and recent signals', value: 'habits' },
        { label: 'memories     Show coding memories', value: 'memories' },
        { label: 'preferences  Show what your agents see (preferences.md)', value: 'prefs' },
      ]
    );
    if (!choice) return 0;
    if (choice.value === 'memories') return cmdMemories();
    if (choice.value === 'prefs') return cmdPrefs();
  }
  return renderHabitsView();
}

/**
 * `cch view prefs`, print the preferences.md that agents actually read via
 * the @import in CLAUDE.md. Transparency: shows exactly what cc-habits injects.
 */
export function cmdPrefs(): number {
  const prefsPath = storagePaths.preferencesFile;
  renderBrandedCard('active preferences', `injected via @import into ~/.claude/CLAUDE.md`);
  process.stdout.write(c(DIM, `  source: ${tildePath(prefsPath)}\n\n`));

  if (!fs.existsSync(prefsPath)) {
    process.stdout.write(c(DIM, '  No preferences.md yet.\n'));
    process.stdout.write(c(DIM, '  Run `cch init` to set up hooks, then code a few sessions for habits to appear.\n\n'));
    return 0;
  }

  const content = fs.readFileSync(prefsPath, 'utf-8').trim();
  if (!content) {
    process.stdout.write(c(DIM, '  preferences.md is empty, no active habits yet.\n'));
    process.stdout.write(c(DIM, '  Habits appear after 2+ coding sessions where you correct the agent.\n\n'));
    return 0;
  }

  process.stdout.write(content + '\n');
  process.stdout.write(
    c(DIM, '\n  ── edit: `cch view habits` · sync to other tools: `cch sync`\n\n'),
  );
  return 0;
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

  let targetText = text.trim();
  if (/^cch[a-f0-9]{8}$/i.test(targetText)) {
    let foundHash = false;
    for (const sectionMemories of Object.values(sections)) {
      const match = sectionMemories.find(m => getRuleHash(m.text) === targetText.toLowerCase());
      if (match) {
        targetText = match.text;
        foundHash = true;
        break;
      }
    }
    if (!foundHash) {
      process.stderr.write(`  Error: memory hash ${text} not found in memories.md\n`);
      return 1;
    }
  }

  const normalised = targetText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
  let found = false;
  let foundText = targetText;

  const matchNormalised = (mText: string, targetNormalised: string): boolean => {
    return mText.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ') === targetNormalised;
  };

  for (const sectionMemories of Object.values(sections)) {
    const idx = sectionMemories.findIndex(m => matchNormalised(m.text, normalised));
    if (idx >= 0) {
      foundText = sectionMemories[idx].text;
      sectionMemories.splice(idx, 1);
      found = true;
      break;
    }
  }

  if (!found && normalised.endsWith(' candidate')) {
    const fallbackNormalised = normalised.slice(0, normalised.length - ' candidate'.length).trim();
    for (const sectionMemories of Object.values(sections)) {
      const idx = sectionMemories.findIndex(m => matchNormalised(m.text, fallbackNormalised));
      if (idx >= 0) {
        foundText = sectionMemories[idx].text;
        sectionMemories.splice(idx, 1);
        found = true;
        break;
      }
    }
  }

  let tombstoneText = foundText;
  if (!found && targetText.trim().toLowerCase().endsWith(' (candidate)')) {
    tombstoneText = targetText.trim().slice(0, targetText.trim().length - ' (candidate)'.length).trim();
  }

  addMemoryTombstone(tombstoneText);
  writeMemoriesMd(serialiseMemories(sections));
  if (found) {
    process.stdout.write(`  memory deleted and tombstoned: ${tombstoneText}\n`);
  } else {
    process.stdout.write(`  tombstoned (not found in memories.md): ${tombstoneText}\n`);
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
    process.stdout.write(c(GREEN, '  ✓ Memory learning on.\n'));
    process.stdout.write(c(DIM, '  Future sessions will learn from corrections you make to agent output.\n'));
    process.stdout.write(c(DIM, '  Next: keep coding, then run `cch memories` to see what was learned.\n'));
  } else {
    process.stdout.write(c(DIM, '  ~ Memory learning off. Existing memories are kept.\n'));
  }
  return 0;
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
    const diffLines = (sig.diff ?? '')
      .split('\n')
      .filter(ln => (ln.startsWith('+') && !ln.startsWith('+++')) || (ln.startsWith('-') && !ln.startsWith('---')));
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
    storagePaths.memoryIndexFile,
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

export async function cmdUninstall(yes: boolean): Promise<number> {
  if (!yes) {
    const confirm = await promptYesNo('  Are you sure you want to completely uninstall cc-habits and delete all learned data? [y/N] ');
    if (!confirm) {
      process.stdout.write('  Uninstall cancelled.\n');
      return 0;
    }
  }

  process.stdout.write('\n  Uninstalling cc-habits...\n\n');

  const tick = '✓';
  const dash = '~';

  // 1. Deregister Claude Code hooks
  try {
    const { postRemoved, stopRemoved, promptRemoved, sessionStartRemoved } = deregisterHooks();
    if (postRemoved || stopRemoved || promptRemoved || sessionStartRemoved) {
      process.stdout.write(`  ${tick} Removed hooks from Claude Code (~/.claude/settings.json)\n`);
    }
  } catch (e) {
    process.stdout.write(`  ${dash} Claude Code hooks clean skipped: ${String(e)}\n`);
  }

  // 2. Remove Claude MD @import
  try {
    if (removeImportFromClaudeMd()) {
      process.stdout.write(`  ${tick} Removed @import from ~/.claude/CLAUDE.md\n`);
    }
  } catch (e) {
    process.stdout.write(`  ${dash} CLAUDE.md import clean skipped: ${String(e)}\n`);
  }

  // 3. Clean other tools
  try {
    const detected = detectInstalledTools();
    for (const tool of detected) {
      try {
        if (tool.id === 'gemini') {
          const { postAdded } = deregisterJsonHooks(tool.settingsPath);
          if (postAdded) process.stdout.write(`  ${tick} Removed hooks from Gemini CLI (${tool.settingsPath})\n`);
        } else if (tool.id === 'codex') {
          const jsonFile = path.join(path.dirname(tool.settingsPath), 'hooks.json');
          const { postAdded } = deregisterJsonHooks(jsonFile);
          if (postAdded) process.stdout.write(`  ${tick} Removed hooks from Codex CLI (${jsonFile})\n`);
        } else if (tool.id === 'kimi') {
          if (deregisterKimiHooks(tool.settingsPath)) {
            process.stdout.write(`  ${tick} Removed hooks from Kimi Code CLI (${tool.settingsPath})\n`);
          }
        } else if (tool.id === 'cline') {
          if (deregisterClineHooks(tool.settingsPath)) {
            process.stdout.write(`  ${tick} Removed hooks from Cline/RooCode (${tool.settingsPath})\n`);
          }
        }
      } catch (e) {
        process.stdout.write(`  ${dash} Clean hooks for ${tool.name} skipped: ${String(e)}\n`);
      }
    }
  } catch {
    // best-effort if detect fails
  }

  // 4. Git capture hooks
  try {
    if (uninstallLocalGitHook()) {
      process.stdout.write(`  ${tick} Removed local Git capture hook\n`);
    }
  } catch (e) {
    process.stdout.write(`  ${dash} Local Git hook clean skipped: ${String(e)}\n`);
  }

  try {
    if (uninstallGlobalGitTemplateHook()) {
      process.stdout.write(`  ${tick} Removed global Git template capture hook\n`);
    }
  } catch (e) {
    process.stdout.write(`  ${dash} Global Git hook clean skipped: ${String(e)}\n`);
  }

  // 5. Delete entire ~/.cc-habits directory
  const storeDir = storagePaths.habitsDir;
  if (fs.existsSync(storeDir)) {
    try {
      fs.rmSync(storeDir, { recursive: true, force: true });
      process.stdout.write(`  ${tick} Deleted storage directory: ${storeDir}\n`);
    } catch (e) {
      process.stdout.write(`  ${dash} Failed to delete storage directory ${storeDir}: ${String(e)}\n`);
    }
  }

  process.stdout.write('\n  cc-habits has been cleanly and completely uninstalled from your system.\n');
  return 0;
}

// Shell wrapper (optional, opt-in) ─────────────────────────────────────────
// Legacy session banner - kept as no-op to avoid breaking existing shell integrations.
export function cmdSessionBanner(): number {
  return 0;
}

// Human-readable "time since" for a signal timestamp, used by the liveness proof.
export function formatTimeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export interface FiredInfo { ts: string; count: number; file: string; }

// Most-recent signal + count per capture source. This is the "proof for the
// proof": these rows exist only because the official tool actually executed our
// hook on the user's real edits, so a registered-but-never-fired tool is exposed.
export function lastFiredBySource(signals: ReadonlyArray<{ ts: string; source?: string; file: string }>): Record<string, FiredInfo> {
  const out: Record<string, FiredInfo> = {};
  for (const s of signals) {
    if (!s.source) continue;
    const cur = out[s.source];
    if (!cur) {
      out[s.source] = { ts: s.ts, count: 1, file: s.file };
      continue;
    }
    cur.count += 1;
    if ((s.ts || '') > cur.ts) {
      cur.ts = s.ts;
      cur.file = s.file;
    }
  }
  return out;
}

// status ─────────────────────────────────────────────────────────────────────
// Read-only health check. Never throws, never writes. Answers "is it working?"
// Renders a bordered, tabular key-value table sized to the current terminal width.
export function cmdStatus(proof = false): number {
  // Subtract 2 from the reported column count. Some terminals include scrollbar
  // or decoration columns in process.stdout.columns, which causes content at the
  // exact boundary to wrap and push the right border onto the next line.
  const W  = Math.min(Math.max((process.stdout.columns ?? 80) - 2, 62), 118);
  const IW = W - 4; // inner visible width: '│ ' prefix + content + ' │' suffix

  const vis  = (s: string): number    => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const pad  = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - vis(s)));
  // ANSI-aware truncate: walks the string counting visible chars (skipping escape
  // sequences atomically), stops at n-1 chars, appends RESET + ellipsis so the
  // result is exactly n visible chars and no open color state is left behind.
  const trunc = (s: string, n: number): string => {
    if (vis(s) <= n) return s;
    let count = 0; let i = 0;
    while (i < s.length && count < n - 1) {
      if (s[i] === '\x1b' && s[i + 1] === '[') {
        const end = s.indexOf('m', i + 2);
        if (end !== -1) { i = end + 1; continue; }
      }
      count++; i++;
    }
    return s.slice(0, i) + '\x1b[0m…';
  };
  const line = (s: string): string    => `│ ${pad(trunc(s, IW), IW)} │\n`;
  const rule = (l: string, r: string): string => `${l}${'─'.repeat(W - 2)}${r}\n`;

  const ok   = c(GREEN,  '✓');
  const fail = c(YELLOW, '✗');
  const git  = c(DIM,    '~');

  // Read all state fresh. No cached snapshots, no stale module-level values.
  let allSignals: ReturnType<typeof readSignals> = [];
  try { allSignals = readSignals(); } catch { allSignals = []; }
  const firedBySource = lastFiredBySource(allSignals);

  let allHabits: Habit[] = [];
  try { allHabits = Object.values(parseHabits(readHabitsMd())).flat(); } catch { allHabits = []; }
  const activeCount   = allHabits.filter(h => (h.sessions_seen ?? 1) >= 2).length;
  const learningCount = allHabits.filter(h => (h.sessions_seen ?? 1) < 2).length;

  const sessionId   = process.env['CLAUDE_SESSION_ID']
    ?? (allSignals.length > 0 ? allSignals[allSignals.length - 1].session_id : undefined);
  const sessionSigs = sessionId ? allSignals.filter(s => s.session_id === sessionId).length : 0;

  const providerUsable = hasUsableProvider();
  const provider       = getConfigValue('provider');
  const configPath     = storagePaths.configFile;
  const configExists   = fs.existsSync(configPath);
  const memsOn         = memoriesEnabled();

  // Hook rows: one row per detected tool, glyph + name + liveness.
  const NAMEW    = 14;
  const hookRows: string[] = [];
  const detected = detectInstalledTools();

  if (detected.length === 0) {
    hookRows.push(line(`${git}  ${c(DIM, 'No coding tools detected')}`));
  } else {
    for (const tool of detected) {
      try {
        if (tool.id === 'cursor') {
          const cursorFired = firedBySource['vscode'];
          const desc = cursorFired
            ? c(GREEN, 'live') + c(DIM, ` · ${formatTimeAgo(cursorFired.ts)} · ${path.basename(cursorFired.file)} · ${cursorFired.count} sig${cursorFired.count === 1 ? '' : 's'}`)
            : c(DIM, 'git capture on commit');
          hookRows.push(line(`${git}  ${pad(c(BOLD, 'Cursor'), NAMEW)}  ${desc}`));
          continue;
        }
        const files      = hookProofPaths(tool.id, tool.settingsPath);
        const entries    = files.flatMap(f => readRegisteredHooks(f).map(h => ({ ...h, file: f })));
        const registered = tool.id === 'claude-code' ? areHooksRegistered() : entries.length > 0;
        const fired      = firedBySource[tool.id];
        const glyph      = registered ? ok : fail;
        let desc: string;
        if (!registered) {
          desc = c(YELLOW, 'not registered, run `cch init`');
        } else if (fired) {
          desc = c(GREEN, 'live') + c(DIM, ` · ${formatTimeAgo(fired.ts)} · ${path.basename(fired.file)} · ${fired.count} sig${fired.count === 1 ? '' : 's'}`);
        } else {
          desc = c(DIM, 'registered') + c(YELLOW, ` (edit in ${tool.name} to confirm)`);
          if (tool.id === 'codex') desc += c(DIM, '  shell edits invisible');
        }
        hookRows.push(line(`${glyph}  ${pad(c(BOLD, tool.name), NAMEW)}  ${desc}`));
        if (proof && registered && entries.length > 0) {
          const where = [...new Set(entries.map(e => e.file))];
          for (const file of where) {
            hookRows.push(line(c(DIM, `      ${tildePath(file)}`)));
            for (const e of entries.filter(x => x.file === file)) {
              hookRows.push(line(c(DIM, `      ${(e.event + ':').padEnd(17)} ${e.command}`)));
            }
          }
        }
      } catch {
        hookRows.push(line(`${git}  ${pad(c(BOLD, tool.name), NAMEW)}  ${c(DIM, '(could not read settings)')}`));
      }
    }
  }

  // Config rows: key padded to KEYW, value fills the rest.
  const KEYW = 10;
  const kv   = (key: string, value: string): string =>
    line(`${c(DIM, key.padEnd(KEYW))}${value}`);

  let providerVal: string;
  if (providerUsable) {
    const envKeyOnly = !configExists && !!process.env['ANTHROPIC_API_KEY'];
    providerVal = c(BOLD, resolveProviderLabel()) + (envKeyOnly ? c(DIM, '  (ANTHROPIC_API_KEY env)') : '');
  } else if (configExists && provider && !isParkedProvider(provider)) {
    providerVal = c(BOLD, provider) + c(YELLOW, '  configured, no API key found');
  } else {
    providerVal = c(YELLOW, 'No provider configured') + c(DIM, '  extraction paused, capture continues');
  }

  const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const importLine   = `@import ${storagePaths.preferencesFile}`;
  let importVal: string;
  try {
    const content = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';
    importVal = content.includes(importLine)
      ? ok + c(DIM, '  preferences.md in CLAUDE.md')
      : fail + c(YELLOW, '  not imported, run `cch init`');
  } catch {
    importVal = c(DIM, 'could not read CLAUDE.md');
  }

  const habitsVal = (activeCount === 0 && learningCount === 0)
    ? c(DIM, 'no habits yet')
    : c(BOLD, String(activeCount)) + ' active' + (learningCount > 0 ? c(DIM, ` · ${learningCount} learning`) : '');

  const signalsVal = allSignals.length === 0
    ? c(DIM, '0 captured')
    : c(BOLD, String(allSignals.length)) + ' total' + (sessionId ? c(DIM, ` · ${sessionSigs} this session`) : '');

  const memoryVal  = memsOn ? c(GREEN, 'on') : c(DIM, 'off');
  const versionVal = c(DIM, VERSION);

  // Render the bordered table.
  let out = rule('┌', '┐');
  for (const r of hookRows) out += r;
  out += rule('├', '┤');
  out += kv('provider', providerVal);
  out += kv('import', importVal);
  out += kv('habits', habitsVal);
  out += kv('signals', signalsVal);
  out += kv('memory', memoryVal);
  out += kv('version', versionVal);
  out += rule('└', '┘');
  process.stdout.write(out);

  // Next step: single actionable line below the box.
  try {
    const cats   = parseHabits(readHabitsMd());
    const active = Object.values(cats).flat().filter(h => (h.sessions_seen ?? 1) >= 2).length;
    if (!providerUsable) {
      process.stdout.write(c(DIM, '→ Run `cch init` to configure a provider.\n'));
    } else if (allSignals.length === 0) {
      process.stdout.write(c(DIM, '→ Run `cch bootstrap` to seed habits from past sessions.\n'));
    } else if (active === 0) {
      process.stdout.write(c(DIM, '  Keep coding, habits graduate after 2+ sessions.\n'));
    } else {
      process.stdout.write(c(GREEN, '  All good.') + c(DIM, ' Start a coding session to keep learning.\n'));
    }
  } catch {
    process.stdout.write(c(DIM, '→ Run `cch init` to get started.\n'));
  }

  return 0;
}

// Emits a shell snippet that wraps `claude` and `gemini` so the cc-habits
// session-banner runs in the terminal before the tool launches. The user opts
// in by adding `eval "$(cc-habits shell-init)"` to their ~/.zshrc or ~/.bashrc.
// We only print the snippet, we never edit the user's rc file for them.
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
# Shows cc-habits session summary before launching claude/gemini, then runs
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
  let targetRule = rule.trim();
  if (/^cch[a-f0-9]{8}$/i.test(targetRule)) {
    const cats = parseHabits(readHabitsMd());
    let found = false;
    for (const habits of Object.values(cats)) {
      const match = habits.find(h => getRuleHash(h.rule) === targetRule.toLowerCase());
      if (match) {
        targetRule = match.rule;
        found = true;
        break;
      }
    }
    if (!found) {
      process.stderr.write(`  Error: habit hash ${rule} not found in habits.md\n`);
      return 1;
    }
  }
  addTombstone(targetRule);
  process.stdout.write(`  tombstoned: ${targetRule}\n`);
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
    const lines = ref.snippet
      .split('\n')
      .filter(ln => !ln.startsWith('---') && !ln.startsWith('+++'))
      .slice(0, 4);
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
    if (getConfigValue('provider') === 'ollama' && process.stdin.isTTY && !asJson) {
      process.stdout.write(c(YELLOW, `\n  Ollama error: ${String(e)}\n`));
      const model = getConfigValue('ollama_model') || OLLAMA_DEFAULT_MODEL;
      const okModel = await interactiveOllamaSetup('✓', '~', model);
      if (okModel) {
        process.stdout.write('\n  Configuration updated. Retrying lint...\n\n');
        return cmdLint(filePath, asJson);
      }
      return 1;
    }
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
    process.stdout.write(c(DIM, '  No developer tool sessions found for this project.\n'));
    process.stdout.write(c(DIM, '  Start a session using Claude Code, Codex, Gemini, or Kimi, make some edits, then try again.\n'));
    return 0;
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${c(BOLD, String(sessions.length))} session${sessions.length === 1 ? '' : 's'} found${formatSessionBreakdown(sessions)}. ` +
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
    if (getConfigValue('provider') === 'ollama' && process.stdin.isTTY) {
      process.stdout.write(c(YELLOW, `\n  Ollama error: ${String(e)}\n`));
      const model = getConfigValue('ollama_model') || OLLAMA_DEFAULT_MODEL;
      const okModel = await interactiveOllamaSetup('✓', '~', model);
      if (okModel) {
        process.stdout.write('\n  Configuration updated. Retrying bootstrap...\n\n');
        return cmdBootstrap();
      }
      return 1;
    }
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

// repo scan ─────────────────────────────────────────────────────────────────
// Render the outcome of a one-time repository scan. Shared by `cch init` and the
// manual `cch learn --repo`.
export function renderRepoScan(scan: RepoScanResult): void {
  if (!scan.scanned) {
    if (scan.reason === 'already scanned') {
      process.stdout.write(c(DIM, '  This repo was already scanned. Re-run with `cch learn --repo`.\n'));
    } else if (scan.reason === 'no LLM provider configured') {
      process.stdout.write(c(DIM, '  Repo scan skipped: no AI provider configured. Add one: `cch init --provider anthropic`.\n'));
    } else {
      process.stdout.write(c(DIM, `  Repo scan skipped: ${scan.reason ?? 'nothing to analyze'}.\n`));
    }
    return;
  }

  const learned = scan.habitsLearned + scan.memoriesLearned;
  const memoriesUpdated = scan.memoriesUpdated ?? 0;
  if (learned === 0 && scan.habitsUpdated === 0 && memoriesUpdated === 0) {
    process.stdout.write(c(DIM, `  Scanned ${scan.filesAnalyzed} file${scan.filesAnalyzed === 1 ? '' : 's'}; no new habits found yet.\n`));
    return;
  }

  const bits: string[] = [];
  if (scan.habitsLearned > 0) bits.push(`${c(BOLD, String(scan.habitsLearned))} new habit${scan.habitsLearned === 1 ? '' : 's'}`);
  if (scan.habitsUpdated > 0) bits.push(`${scan.habitsUpdated} reinforced`);
  if (scan.memoriesLearned > 0) bits.push(`${c(BOLD, String(scan.memoriesLearned))} memor${scan.memoriesLearned === 1 ? 'y' : 'ies'}`);
  if (memoriesUpdated > 0) bits.push(`${memoriesUpdated} memor${memoriesUpdated === 1 ? 'y' : 'ies'} reinforced`);
  process.stdout.write(
    `  ✓ Learned ${bits.join(', ')} from ${scan.filesAnalyzed} file${scan.filesAnalyzed === 1 ? '' : 's'}` +
    `${scan.docsAnalyzed > 0 ? ` and ${scan.docsAnalyzed} doc${scan.docsAnalyzed === 1 ? '' : 's'}` : ''}.\n`,
  );

  if (scan.details) {
    if (scan.details.learnedHabits.length > 0) {
      process.stdout.write('\n  ' + c(BOLD + GREEN, 'New habits:') + '\n');
      for (const h of scan.details.learnedHabits) {
        process.stdout.write(`    • [${c(CYAN, h.category)}] ${h.rule}\n`);
      }
    }
    if (scan.details.reinforcedHabits.length > 0) {
      process.stdout.write('\n  ' + c(BOLD + CYAN, 'Reinforced habits:') + '\n');
      for (const h of scan.details.reinforcedHabits) {
        process.stdout.write(`    • [${c(CYAN, h.category)}] ${h.rule}\n`);
      }
    }
    if (scan.details.learnedMemories.length > 0) {
      process.stdout.write('\n  ' + c(BOLD + YELLOW, 'New memories:') + '\n');
      for (const m of scan.details.learnedMemories) {
        process.stdout.write(`    • ${m}\n`);
      }
    }
    if (scan.details.reinforcedMemories && scan.details.reinforcedMemories.length > 0) {
      process.stdout.write('\n  ' + c(BOLD + CYAN, 'Reinforced memories:') + '\n');
      for (const m of scan.details.reinforcedMemories) {
        process.stdout.write(`    • ${m}\n`);
      }
    }
    process.stdout.write('\n');
  }
}

// `cch learn --repo` (alias `cch learn this`): re-run the repo scan on demand,
// forcing past the once-per-repo guard.
export async function cmdLearnRepo(opts: { force?: boolean } = {}): Promise<number> {
  process.stdout.write(c(DIM, '  Scanning this repository...\n'));
  try {
    const scan = await scanRepo({
      force: opts.force ?? true,
      confirm: () => promptYesNoDefaultTrue('   Proceed with scan? [Y/n] '),
    });
    renderRepoScan(scan);
    return 0;
  } catch (e) {
    const hint = providerHint(e);
    if (hint) {
      process.stdout.write(c(YELLOW, `  ${hint}\n`));
      return 0;
    }
    process.stderr.write(`cc-habits learn --repo: ${String(e)}\n`);
    return 1;
  }
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
    process.stdout.write(`  not enough signals in capture log (found ${filtered.length}). Falling back to repository scan...\n\n`);
    return cmdLearnRepo({ force: true });
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
    if (getConfigValue('provider') === 'ollama' && process.stdin.isTTY) {
      process.stdout.write(c(YELLOW, `\n  Ollama error: ${String(e)}\n`));
      const model = getConfigValue('ollama_model') || OLLAMA_DEFAULT_MODEL;
      const okModel = await interactiveOllamaSetup('✓', '~', model);
      if (okModel) {
        process.stdout.write('\n  Configuration updated. Retrying learn...\n\n');
        return cmdLearn(opts);
      }
      return 1;
    }
    const hint = providerHint(e);
    if (!hint) throw e;
    process.stdout.write(c(YELLOW, `  ${hint}\n`));
    return 0;
  }
  const sessionLanguages = Array.from(
    new Set(capped.map(s => s.language).filter((l): l is string => !!l)),
  );
  const fallbackLanguage = sessionLanguages.length === 1 ? sessionLanguages[0] : undefined;

  const changes: AppliedChange[] = [];
  const [newCount, updatedCount] = applyUpdates(cats, updates, { sessionId, changes, fallbackLanguage });

  const creates = updates.filter(u => (u.decision ?? '').toLowerCase() === 'create');
  const warning = autoApplyWarning(creates.length);
  if (warning) process.stderr.write(c(YELLOW, '  ' + warning + '\n'));

  const serialised = serialiseHabits(cats);
  writeHabitsMd(serialised);
  writePreferencesFile(); // Phase 2: write preferences.md
  writeSnapshot(cats);
  appendHistory({ ts: new Date().toISOString(), session_id: sessionId, habits_md: serialised });
  
  let memoryCandidatesCount = 0;
  const addedMemories: string[] = [];
  const updatedMemories: string[] = [];
  if (memoriesEnabled()) {
    try {
      const memoriesMd = readMemoriesMd();
      const candidates = await extractMemoryCandidates(capped, memoriesMd);
      memoryCandidatesCount = applyMemoryUpdates(candidates, undefined, addedMemories, updatedMemories);
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
    signalsCount: capped.length,
    learningCount: Object.values(cats).flat().filter(h => (h.sessions_seen ?? 1) < 2).length,
    memoryCandidatesCount,
    addedMemories,
    memoryCandidatesUpdated: updatedMemories.length,
    updatedMemories,
  });
  process.stdout.write(summary + '\n');
  return 0;
}



export function cmdOn(): number {
  setGloballyDisabled(false);
  process.stdout.write('\n\n' + c(GREEN, '  ✓ cc-habits enabled.\n'));
  process.stdout.write(c(DIM, '  Capture and injection are now active.\n'));
  return 0;
}
 
export function cmdOff(): number {
  setGloballyDisabled(true);
  process.stdout.write('\n\n' + c(RED, '  ✗ cc-habits disabled.\n'));
  process.stdout.write(c(DIM, '  Capture and injection are now paused.\n'));
  return 0;
}
