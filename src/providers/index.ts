import fs from 'fs';
import os from 'os';
import path from 'path';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GroqProvider } from './groq';
import { OllamaProvider } from './ollama';
import { ClaudeCliProvider } from './claude-cli';
import { GeminiCliProvider } from './gemini-cli';
import { CodexCliProvider } from './codex-cli';
import { spawnSync } from 'child_process';
import { storagePaths } from '../storage';

// Re-export the contract and error types so existing importers of './providers'
// keep working. The definitions live in types.ts to avoid an import cycle.
import type { Provider } from './types';
export { Provider, ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError, ProviderAuthError, ProviderNotInstalledError, ProviderQuotaError } from './types';

const REQUEST_TIMEOUT_MS = 30_000;
const REPO_SCAN_TIMEOUT_MS = 90_000;

export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'groq' | 'ollama' | 'claude-cli' | 'gemini-cli' | 'codex-cli';
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
  let configPath = storagePaths.configFile;
  if (!fs.existsSync(configPath)) {
    if (!process.env['CC_HABITS_DIR']) {
      const globalConfig = path.join(os.homedir(), '.cc-habits', 'config.yml');
      if (fs.existsSync(globalConfig)) {
        configPath = globalConfig;
      } else {
        return cfg;
      }
    } else {
      return cfg;
    }
  }
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    const read = (key: string): string | undefined => {
      const m = text.match(new RegExp(`${key}\\s*:\\s*["']?([^\\s"'\\n]+)["']?`));
      return m ? m[1] : undefined;
    };
    const provider = read('provider');
    if (provider === 'openai' || provider === 'groq' || provider === 'ollama' || provider === 'anthropic' || provider === 'claude-cli' || provider === 'gemini-cli' || provider === 'codex-cli') {
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

// Human-readable name of the provider extraction will actually use, honoring the
// same precedence as selectProvider (CC_HABITS_PROVIDER env > config file >
// ANTHROPIC_API_KEY env). Returns 'none' when nothing usable is configured. Used
// so the repo-scan warning and `cch status` name the concrete provider rather
// than a vague "your configured AI provider".
//
// A parked CLI provider sitting in config.yml (e.g. a leftover `provider:
// codex-cli` from `--provider` experimentation) is NOT a usable provider in this
// release, so it resolves to 'none' rather than being named as if it were active.
// An explicit CC_HABITS_PROVIDER override is still honored verbatim, since that is
// a deliberate, current choice rather than stale config.
export function resolveProviderLabel(): string {
  const forced = process.env['CC_HABITS_PROVIDER'];
  if (forced) return forced;
  const configExists = fs.existsSync(storagePaths.configFile)
    || (!process.env['CC_HABITS_DIR'] && fs.existsSync(path.join(os.homedir(), '.cc-habits', 'config.yml')));
  if (!configExists) {
    return process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'none';
  }
  const cfg = readConfig();
  if (isParkedProvider(cfg.provider)) return 'none';
  if (cfg.provider === 'ollama') return `ollama (${cfg.ollama_model ?? 'llama3.2'})`;
  return cfg.provider;
}

// CLI-linking providers are parked for this release (reachable only via an
// explicit --provider, never the default UX). Treated as not-usable everywhere
// the front door decides whether to offer or run an extraction.
const PARKED_PROVIDERS: readonly string[] = ['claude-cli', 'gemini-cli', 'codex-cli'];

export function isParkedProvider(provider: string): boolean {
  return PARKED_PROVIDERS.includes(provider);
}

// The single "can we actually extract right now?" gate. True only for a supported
// (non-parked) provider that has the credential it needs. Mirrors selectProvider's
// credential precedence so the front door never promises a scan it cannot run, and
// never prints "analyzing with X" only to fail with "no provider". Synchronous and
// network-free: a configured Ollama is assumed reachable (a real connection error
// is surfaced honestly by the scan itself, not masked as "no provider").
export function hasUsableProvider(): boolean {
  try {
    const cfg = readConfig();
    const provider = process.env['CC_HABITS_PROVIDER'] ?? cfg.provider;
    if (isParkedProvider(provider)) return false;
    if (provider === 'ollama') return true;
    if (provider === 'openai') return !!(process.env['OPENAI_API_KEY'] ?? cfg.openai_api_key);
    if (provider === 'groq') return !!(process.env['GROQ_API_KEY'] ?? cfg.groq_api_key);
    return !!(process.env['ANTHROPIC_API_KEY'] ?? cfg.anthropic_api_key); // anthropic (default)
  } catch {
    return false;
  }
}

export function selectProvider(): Provider {
  const cfg = readConfig();

  // Env vars override config file selection.
  const forced = process.env['CC_HABITS_PROVIDER'];
  const chosen = (forced ?? cfg.provider) as ProviderConfig['provider'];

  if (chosen === 'claude-cli') {
    return new ClaudeCliProvider();
  }
  if (chosen === 'gemini-cli') {
    return new GeminiCliProvider();
  }
  if (chosen === 'codex-cli') {
    return new CodexCliProvider();
  }
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

// ── Local Ollama auto-detection fallback ─────────────────────────────────────
//
// When no cloud provider is usable (no key configured), cc-habits would
// otherwise hard-fail. If a local Ollama daemon is running, prefer it instead so
// a user with Ollama installed "just works" without editing config.yml. The
// fallback is announced once per process so the choice is never silent.

const OLLAMA_PROBE_TIMEOUT_MS = 1500;
const PREFERRED_OLLAMA_MODELS = ['gemma4:31b-cloud', 'llama3.2'];

// True only when no provider was explicitly chosen and no cloud key is present,
// so we never override a user's deliberate provider selection.
function shouldTryOllamaFallback(): boolean {
  if (process.env['CC_HABITS_PROVIDER']) return false; // explicit choice, respect it
  const cfg = readConfig();
  if (cfg.provider !== 'anthropic') return false;      // explicit non-anthropic choice
  // cfg.provider === 'anthropic' here is either explicit or the default. Only fall
  // back when there is genuinely no anthropic key to use.
  return !(process.env['ANTHROPIC_API_KEY'] ?? cfg.anthropic_api_key);
}

// Probe a local Ollama and pick a model. Returns null when Ollama is unreachable
// or exposes no models. Bounded by a short timeout so it never hangs a hook.
export async function detectOllama(): Promise<{ url: string; model: string } | null> {
  const cfg = readConfig();
  const url = process.env['CC_HABITS_OLLAMA_URL'] ?? cfg.ollama_url ?? 'http://localhost:11434';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json() as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map(m => m?.name).filter((n): n is string => !!n);
    if (names.length === 0) return null;
    // Preference order: configured model, then a known-good default, then first available.
    const preferred = [cfg.ollama_model, ...PREFERRED_OLLAMA_MODELS].find(p => p && names.includes(p));
    const model = preferred ?? names[0];
    return { url, model };
  } catch {
    return null; // unreachable, timed out, or malformed response
  } finally {
    clearTimeout(timer);
  }
}

let ollamaFallbackAnnounced = false;

// Reset the once-per-process announcement guard. Test-only.
export function resetOllamaAnnounceForTests(): void {
  ollamaFallbackAnnounced = false;
}

// Async provider resolution with local-Ollama fallback. Use this from the
// extraction paths. Falls back to Ollama only when no cloud provider is usable.
export async function selectProviderAsync(): Promise<Provider> {
  try {
    return selectProvider();
  } catch (e) {
    if (!shouldTryOllamaFallback()) throw e;
    const found = await detectOllama();
    if (!found) throw e; // keep the original "no provider configured" error
    if (!ollamaFallbackAnnounced) {
      ollamaFallbackAnnounced = true;
      process.stderr.write(`cc-habits: no provider configured, using local Ollama (${found.model})\n`);
    }
    return new OllamaProvider(found.url, found.model);
  }
}

export function probeCliProvider(name: 'claude' | 'gemini' | 'codex'): boolean {
  try {
    const result = spawnSync(name, ['--version'], {
      timeout: 2000,
      encoding: 'utf-8',
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

export { REQUEST_TIMEOUT_MS, REPO_SCAN_TIMEOUT_MS };
