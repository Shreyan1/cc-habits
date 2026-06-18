import fs from 'fs';
import path from 'path';
import { storagePaths } from './storage';
import { setConfigValue } from './config';
import { runSelectMenu } from './menu';
import { isCloudOllamaModel } from './providers';
import {
  c, BOLD, CYAN, YELLOW, GREEN, RED, DIM, tildePath,
  promptChoice, promptYesNo, promptYesNoDefaultTrue, promptSecret
} from './cli-ui';

// Persist the chosen provider as a set of upserts (not a whole-file overwrite),
// so selecting a new provider replaces any stale `provider:` line (e.g. a leftover
// parked codex-cli) while preserving unrelated keys like consent_given and
// memories_enabled. Always writes the `provider` key so the selection is explicit.
function saveProviderConfig(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    setConfigValue(key, value);
  }
}

const CONFIG_FILE = storagePaths.configFile;
const OLLAMA_DEFAULT_URL   = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

// The LLM providers cc-habits can use to extract habits. This is the brain that
// reads diffs, NOT the coding tool that produces them. Single source of truth for
// both validation and the error message so they never drift.
export const VALID_PROVIDERS = ['claude-cli', 'gemini-cli', 'codex-cli', 'anthropic', 'ollama', 'openai', 'groq'] as const;

// Coding tools a user might confuse for a provider (because they pass --provider
// codex meaning "set up Codex"). Maps the bare tool name to the right guidance,
// usually pointing at its `-cli` provider equivalent.
const TOOL_NOT_PROVIDER: Record<string, string> = {
  codex: 'Did you mean `codex-cli`? That uses your authenticated Codex CLI as the provider. ' +
    "(Codex's edit-capture hooks are configured separately, when the tool is detected.)",
  claude: 'Did you mean `claude-cli`? That uses your authenticated Claude CLI as the provider.',
  gemini: 'Did you mean `gemini-cli`? That uses your authenticated Gemini CLI as the provider.',
  kimi: 'Kimi is a coding tool, not an LLM provider for cc-habits. Pick one of the providers below.',
  cline: 'Cline is a coding tool, not an LLM provider for cc-habits. Pick one of the providers below.',
  cursor: 'Cursor is a coding tool, not an LLM provider for cc-habits. Pick one of the providers below.',
};

/**
 * Validate a --provider value before any side effects. Returns an error message
 * (with tailored guidance for the tool-vs-provider mix-up) or null when valid.
 */
export function validateProviderFlag(provider: string): string | null {
  if ((VALID_PROVIDERS as readonly string[]).includes(provider)) return null;
  const hint = TOOL_NOT_PROVIDER[provider.toLowerCase()];
  const base = `cc-habits: '${provider}' is not a valid AI provider.`;
  const supported = `  Supported: anthropic, openai, groq, ollama.`;
  const experimental = `  Experimental (WIP): claude-cli, gemini-cli, codex-cli.`;
  return hint ? `${base}\n  ${hint}\n${supported}\n${experimental}` : `${base}\n${supported}\n${experimental}`;
}


interface OllamaTagsModel {
  name: string;
}

interface OllamaTagsResponse {
  models?: OllamaTagsModel[];
}

export function showDataFlowNotice(): void {
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, '  How cc-habits uses your code\n'));
  process.stdout.write(c(DIM, '  ──────────────────────────────\n'));
  process.stdout.write('  • Captures the diff of files you edit during a Claude Code session.\n');
  process.stdout.write('  • Redacts email / PAN / card numbers (best-effort, pattern-based, not exhaustive).\n');
  process.stdout.write('  • Sends batched diffs to the AI provider you choose below, once per session, to learn habits.\n');
  process.stdout.write('  • A local-only provider (Ollama) sends nothing off your machine.\n');
  process.stdout.write(c(DIM, '  Opt out anytime: add a .cc-habits-ignore file in a repo, set CC_HABITS_DISABLE=1,\n'));
  process.stdout.write(c(DIM, '  inspect captures with `cc-habits log`, or erase them with `cc-habits reset --yes`.\n'));
}

export async function interactiveOllamaSetup(
  tick: string,
  dash: string,
  failedModel?: string,
): Promise<string | null> {
  if (failedModel) {
    process.stdout.write(`\n  ⚠️ Ollama model '${failedModel}' was not found on your local instance.\n`);
  }

  // Connection retry loop. When Ollama is unreachable, let the user start it and
  // retry in place rather than re-running the whole `cch init` just to get back to
  // this point. A non-interactive shell cannot retry, so it bails once as before.
  let detectedModels: string[] = [];
  while (true) {
    let ollamaOk = false;
    detectedModels = [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${OLLAMA_DEFAULT_URL}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      ollamaOk = res.ok;
      if (res.ok) {
        const data = await res.json() as OllamaTagsResponse;
        detectedModels = (data.models ?? []).map(m => m.name);
      }
    } catch { /* not running or error fetching models */ }

    if (ollamaOk) break;

    process.stdout.write('\n');
    process.stdout.write(c(YELLOW, '  Ollama was not detected at ' + OLLAMA_DEFAULT_URL + '\n'));
    process.stdout.write('  1. Install Ollama: ' + c(CYAN, 'https://ollama.com/download') + '\n');
    process.stdout.write('  2. Pull a model (e.g. `ollama pull llama3.2`)\n');
    process.stdout.write('  3. Start Ollama (e.g. `ollama serve`)\n');
    process.stdout.write('\n');

    if (!process.stdin.isTTY) {
      process.stdout.write('  Please ensure Ollama is running and has a model loaded, then try running setup again.\n');
      return null;
    }

    const retry = await promptYesNoDefaultTrue('  Retry connecting to Ollama? [Y/n] ');
    if (!retry) {
      process.stdout.write(c(DIM, '  Skipped Ollama. Re-run `cch init --provider ollama` once it is running.\n'));
      return null;
    }
    process.stdout.write(c(DIM, '  Retrying...\n'));
  }

  process.stdout.write(`  ${tick} Ollama detected at ${OLLAMA_DEFAULT_URL}\n`);

  const otherModels = failedModel
    ? detectedModels.filter(m => m !== failedModel)
    : detectedModels;

  if (otherModels.length === 0) {
    process.stdout.write('\n');
    process.stdout.write(c(YELLOW, failedModel
      ? '  No other models were found on your local Ollama instance.\n'
      : '  No models were found on your local Ollama instance.\n'
    ));
    process.stdout.write(`  Please pull a model separately (for example, by running ${c(BOLD, `ollama pull ${OLLAMA_DEFAULT_MODEL}`)}),\n  and re-run setup once it is ready.\n`);
    return null;
  }

  process.stdout.write('\n');
  process.stdout.write(c(DIM, '  Suggested models (any Ollama model works, these fit cc-habits\' habit extraction):\n'));
  process.stdout.write(c(DIM, '    llama3.2              ~2GB    fastest, runs on almost anything (default)\n'));
  process.stdout.write(c(DIM, '    qwen2.5-coder:7b      ~4.7GB  recommended, best at reading code diffs\n'));
  process.stdout.write(c(DIM, '    qwen2.5-coder:3b      ~2GB    middle ground\n'));
  process.stdout.write(c(DIM, '    phi-4 or qwen2.5:14b  ~9GB+   highest quality, needs 16GB+ RAM\n'));
  process.stdout.write('\n');

  while (true) {
    const menuItems = otherModels.map(m => ({ label: m, value: m }));
    menuItems.push({ label: 'Configure/pull a different model separately', value: 'configure_separately' });

    const selected = await runSelectMenu(
      failedModel
        ? '  Detected other Ollama models (use ↑/↓ keys):'
        : '  Detected Ollama models (use ↑/↓ keys):',
      menuItems
    );
    if (selected === null || selected.value === 'configure_separately') {
      process.stdout.write('\n  Please configure or pull a different model separately, and re-run setup once ready.\n');
      return null;
    }

    const candidateModel = selected.value;
    process.stdout.write(`\n  Verifying model '${candidateModel}'...\n`);

    let verificationOk = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(`${OLLAMA_DEFAULT_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: candidateModel,
          prompt: 'Say "hello" in one word',
          stream: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const body = await res.json() as { response?: string };
        if (body && body.response) {
          verificationOk = true;
        }
      } else {
        try {
          const body = await res.json() as { error?: string };
          if (body && body.error) {
            process.stdout.write(c(RED, `  Model error: ${body.error}\n`));
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      process.stdout.write(c(RED, `  Verification failed to connect: ${String(err)}\n`));
    }

    if (verificationOk) {
      process.stdout.write(c(GREEN, `  ${tick} Model '${candidateModel}' verified successfully!\n`));
      saveProviderConfig({ provider: 'ollama', ollama_url: OLLAMA_DEFAULT_URL, ollama_model: candidateModel });
      process.stdout.write(`  ${tick} Ollama config saved (model: ${candidateModel})\n`);
      // Honesty: a `-cloud` model is not local. Do not let the "fully local"
      // framing of Ollama imply privacy it does not provide for this choice.
      if (isCloudOllamaModel(candidateModel)) {
        process.stdout.write(c(YELLOW, `  ⚠️  '${candidateModel}' is an Ollama cloud model. It runs on Ollama's servers,\n`));
        process.stdout.write(c(YELLOW, `      so your redacted diffs leave your machine. For a fully local setup that\n`));
        process.stdout.write(c(YELLOW, `      sends nothing off-device, pick a model without the '-cloud' suffix (e.g. llama3.2).\n`));
      }
      return candidateModel;
    } else {
      process.stdout.write(c(YELLOW, `  ⚠️ Model '${candidateModel}' appears to be broken or did not respond correctly.\n`));
      const tryAnother = await promptYesNo('  Would you like to try selecting a different model? [y/N] ');
      if (!tryAnother) {
        process.stdout.write('\n  Please configure/pull a working model separately, then come back and re-run cc-habits init.\n');
        return null;
      }
    }
  }
}

export async function configureProvider(provider: string, tick: string, dash: string): Promise<void> {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });

  if (provider === 'claude-cli' || provider === 'gemini-cli' || provider === 'codex-cli') {
    saveProviderConfig({ provider });
    process.stdout.write(`  ${tick} Config saved (provider: ${provider})\n`);
    process.stdout.write(c(DIM, `    ↳ proof, written to ${tildePath(CONFIG_FILE)}: provider: ${provider}\n`));
    return;
  }

  if (provider !== 'ollama' && process.stdin.isTTY) {
    const ok = await promptYesNo(`  Send redacted diffs to ${provider} to learn habits? [y/N] `);
    if (!ok) {
      process.stdout.write(c(DIM, '  Cancelled, no cloud provider configured. Try Ollama for fully local.\n'));
      return;
    }
  }

  if (provider === 'ollama') {
    if (!process.stdin.isTTY) {
      saveProviderConfig({ provider: 'ollama', ollama_url: OLLAMA_DEFAULT_URL, ollama_model: OLLAMA_DEFAULT_MODEL });
      return;
    }
    await interactiveOllamaSetup(tick, dash);
    return;
  }

  if (provider === 'anthropic') {
    process.stdout.write('\n');
    process.stdout.write(c(DIM, '  Get an API key at https://console.anthropic.com\n\n'));
    const key = await promptSecret('  Enter your Anthropic API key (hidden): ');
    if (key) {
      saveProviderConfig({ provider: 'anthropic', anthropic_api_key: key });
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
      saveProviderConfig({ provider: 'openai', openai_api_key: key, openai_model: 'gpt-4o-mini' });
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
      saveProviderConfig({ provider: 'groq', groq_api_key: key, groq_model: 'llama-3.3-70b-versatile' });
      process.stdout.write(`  ${tick} Groq config saved\n`);
    } else {
      process.stdout.write(`  ${dash} No key entered.\n`);
    }
    return;
  }

  // Defense in depth: cmdInit validates --provider up front, but if an invalid
  // value reaches here, fail clearly with the shared, tailored guidance.
  process.stderr.write((validateProviderFlag(provider) ?? `cc-habits: unknown provider '${provider}'.`) + '\n');
}

/**
 * `cch init` found a provider already set up (an ANTHROPIC_API_KEY in the
 * environment, or a saved config.yml). Instead of silently reusing it, offer a
 * clear, low-friction choice: keep it, pick a different provider or key, or
 * switch to local Ollama. One keystroke resolves it. In a non-interactive shell
 * promptChoice returns null, so the existing provider is kept untouched and init
 * never blocks.
 */
export async function reconfigureProviderMenu(
  currentLabel: string,
  tick: string,
  dash: string,
): Promise<void> {
  const isOllama = currentLabel.toLowerCase().startsWith('ollama');
  process.stdout.write('\n  cc-habits already has an AI provider configured.\n\n');
  process.stdout.write(`  [1] Keep ${currentLabel}\n`);
  process.stdout.write('  [2] Use a different provider or key\n');
  if (!isOllama) {
    process.stdout.write('  [3] Switch to Ollama' + c(DIM, '  (free, local, no key needed)') + '\n');
  }
  process.stdout.write('\n');

  const maxChoice = isOllama ? 2 : 3;
  const choice = await promptChoice(`  Enter choice [1-${maxChoice}]: `, 1, maxChoice);

  if (choice === null || choice === 1) {
    process.stdout.write(`  ${tick} Keeping ${currentLabel}.\n`);
    return;
  }
  if (!isOllama && choice === 3) {
    await configureProvider('ollama', tick, dash);
    return;
  }
  await showProviderMenu(tick, dash); // choice === 2: full provider menu
}

export async function showProviderMenu(tick: string, dash: string): Promise<void> {
  showDataFlowNotice();
  process.stdout.write('\n');
  process.stdout.write(
    c(YELLOW, '  Note: ') +
    'Claude Code subscriptions and Anthropic API keys are sold separately.\n',
  );
  process.stdout.write(
    c(DIM, '  Ollama (free, fully local) is a great option if you do not have an API key.\n'),
  );
  process.stdout.write('\n');
  process.stdout.write(c(BOLD, '  How should cc-habits call the AI?\n\n'));
  process.stdout.write('  [1] Anthropic API  ' + c(DIM, '(recommended, ~$0.09/month, console.anthropic.com)') + '\n');
  process.stdout.write('  [2] Ollama         ' + c(DIM, '(free, local, no key needed, ollama.com/download)') + '\n');
  process.stdout.write('  [3] OpenAI API     ' + c(DIM, '(your own key, platform.openai.com)') + '\n');
  process.stdout.write('  [4] Groq API       ' + c(DIM, '(free tier, console.groq.com)') + '\n');
  process.stdout.write('  [5] Skip for now   ' + c(DIM, '(captures signals, skips extraction)') + '\n');
  process.stdout.write('\n');

  const choice = await promptChoice('  Enter choice [1-5]: ', 1, 5);

  if (choice === null || choice === 5) {
    // Acknowledge the skip only. The caller (cmdInit) prints the full "needs a
    // provider" guidance once via its own no-provider check, so repeating it here
    // would duplicate the message.
    process.stdout.write(c(DIM, '  Skipped for now.\n'));
    return;
  }

  const nameMap: Record<number, string> = {
    1: 'anthropic',
    2: 'ollama',
    3: 'openai',
    4: 'groq',
  };
  await configureProvider(nameMap[choice]!, tick, dash);
}
