import fs from 'fs';
import path from 'path';
import { writeConfigFile, storagePaths } from './storage';
import { runSelectMenu } from './menu';
import {
  c, BOLD, CYAN, YELLOW, GREEN, RED, DIM,
  promptChoice, promptYesNo, promptSecret
} from './cli-ui';

const CONFIG_FILE = storagePaths.configFile;
const OLLAMA_DEFAULT_URL   = 'http://localhost:11434';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';


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
  let ollamaOk = false;
  let detectedModels: string[] = [];

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

  if (failedModel) {
    process.stdout.write(`\n  ⚠️ Ollama model '${failedModel}' was not found on your local instance.\n`);
  }

  if (!ollamaOk) {
    process.stdout.write('\n');
    process.stdout.write(c(YELLOW, '  Ollama was not detected at ' + OLLAMA_DEFAULT_URL + '\n'));
    process.stdout.write('  1. Install Ollama: ' + c(CYAN, 'https://ollama.com/download') + '\n');
    process.stdout.write('  2. Pull a model (e.g. `ollama pull llama3.2`)\n');
    process.stdout.write('  3. Start Ollama (e.g. `ollama serve`)\n');
    process.stdout.write('\n  Please ensure Ollama is running and has a model loaded, then try running setup again.\n');
    return null;
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
      writeConfigFile(`provider: ollama\nollama_url: ${OLLAMA_DEFAULT_URL}\nollama_model: ${candidateModel}\n`);
      process.stdout.write(`  ${tick} Ollama config saved (model: ${candidateModel})\n`);
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

  if (provider !== 'ollama' && process.stdin.isTTY) {
    const ok = await promptYesNo(`  Send redacted diffs to ${provider} to learn habits? [y/N] `);
    if (!ok) {
      process.stdout.write(c(DIM, '  Cancelled, no cloud provider configured. Try Ollama for fully local.\n'));
      return;
    }
  }

  if (provider === 'ollama') {
    if (!process.stdin.isTTY) {
      writeConfigFile(`provider: ollama\nollama_url: ${OLLAMA_DEFAULT_URL}\nollama_model: ${OLLAMA_DEFAULT_MODEL}\n`);
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

export async function showProviderMenu(tick: string, dash: string): Promise<void> {
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
