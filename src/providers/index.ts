import fs from 'fs';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GroqProvider } from './groq';
import { OllamaProvider } from './ollama';
import { storagePaths } from '../storage';

// Re-export the contract and error types so existing importers of './providers'
// keep working. The definitions live in types.ts to avoid an import cycle.
import type { Provider } from './types';
export { Provider, ProviderRateLimitError, ProviderTimeoutError } from './types';

const REQUEST_TIMEOUT_MS = 10_000;

export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'groq' | 'ollama';
  anthropic_api_key?: string;
  openai_api_key?: string;
  openai_model?: string;
  groq_api_key?: string;
  groq_model?: string;
  ollama_url?: string;
  ollama_model?: string;
}

// Minimal regex-driven YAML reader. The config file path comes from storagePaths
// so that CC_HABITS_DIR overrides both data files AND the provider config together.
function readConfig(): ProviderConfig {
  const cfg: ProviderConfig = { provider: 'anthropic' };
  if (!fs.existsSync(storagePaths.configFile)) return cfg;
  try {
    const text = fs.readFileSync(storagePaths.configFile, 'utf-8');
    const read = (key: string): string | undefined => {
      const m = text.match(new RegExp(`${key}\\s*:\\s*["']?([^\\s"'\\n]+)["']?`));
      return m ? m[1] : undefined;
    };
    const provider = read('provider');
    if (provider === 'openai' || provider === 'groq' || provider === 'ollama' || provider === 'anthropic') {
      cfg.provider = provider;
    }
    cfg.anthropic_api_key = read('anthropic_api_key');
    cfg.openai_api_key = read('openai_api_key');
    cfg.openai_model = read('openai_model');
    cfg.groq_api_key = read('groq_api_key');
    cfg.groq_model = read('groq_model');
    cfg.ollama_url = read('ollama_url');
    cfg.ollama_model = read('ollama_model');
  } catch {
    // fall through to default
  }
  return cfg;
}

export function selectProvider(): Provider {
  const cfg = readConfig();

  // Env vars override config file selection.
  const forced = process.env['CC_HABITS_PROVIDER'];
  const chosen = (forced ?? cfg.provider) as ProviderConfig['provider'];

  if (chosen === 'openai') {
    const key = process.env['OPENAI_API_KEY'] ?? cfg.openai_api_key;
    if (!key) throw new Error('OpenAI provider selected but OPENAI_API_KEY/openai_api_key not set.');
    return new OpenAIProvider(key, cfg.openai_model ?? 'gpt-4o-mini');
  }
  if (chosen === 'groq') {
    const key = process.env['GROQ_API_KEY'] ?? cfg.groq_api_key;
    if (!key) throw new Error('Groq provider selected but GROQ_API_KEY/groq_api_key not set.');
    return new GroqProvider(key, cfg.groq_model ?? 'llama-3.3-70b-versatile');
  }
  if (chosen === 'ollama') {
    return new OllamaProvider(cfg.ollama_url ?? 'http://localhost:11434', cfg.ollama_model ?? 'llama3.2');
  }
  // anthropic (default)
  const key = process.env['ANTHROPIC_API_KEY'] ?? cfg.anthropic_api_key;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set and not found in config.');
  return new AnthropicProvider(key);
}

export { REQUEST_TIMEOUT_MS };
