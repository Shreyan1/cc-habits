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
export { Provider, ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError, ProviderAuthError, ProviderNotInstalledError, ProviderQuotaError, ProviderModelNotFoundError } from './types';

const REQUEST_TIMEOUT_MS = 30_000;
const REPO_SCAN_TIMEOUT_MS = 90_000;

export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'groq' | 'ollama' | 'claude-cli' | 'gemini-cli' | 'codex-cli';
  anthropic_api_key?: string;
  openai_api_key?: string;
  openai_model?: string;
  openai_base_url?: string;
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
    const lines = text.split('\n').map(line => {
      const hashIdx = line.indexOf('#');
      return hashIdx !== -1 ? line.slice(0, hashIdx) : line;
    });
    const cleanText = lines.join('\n');
    const read = (key: string): string | undefined => {
      const m = cleanText.match(new RegExp(`^${key}\\s*:\\s*["']?([^\\s"'\\n]+)["']?`, 'm'));
      return m ? m[1] : undefined;
    };
    const provider = read('provider');
    if (provider === 'openai' || provider === 'groq' || provider === 'ollama' || provider === 'anthropic' || provider === 'claude-cli' || provider === 'gemini-cli' || provider === 'codex-cli') {
      cfg.provider = provider;
    }
    cfg.anthropic_api_key = read('anthropic_api_key');
    cfg.openai_api_key = read('openai_api_key');
    cfg.openai_model = read('openai_model');
    cfg.openai_base_url = read('openai_base_url');
    cfg.groq_api_key = read('groq_api_key');
    cfg.groq_model = read('groq_model');
    cfg.ollama_url = read('ollama_url');
    cfg.ollama_model = read('ollama_model');
  } catch {
    // fall through to default
  }
  return cfg;
}

async function readConfigAsync(): Promise<ProviderConfig> {
  const cfg: ProviderConfig = { provider: 'anthropic' };
  let configPath = storagePaths.configFile;
  if (!fs.existsSync(configPath)) {
    if (!process.env['CC_HABITS_DIR']) {
      const globalConfig = path.join(os.homedir(), '.cc-habits', 'config.yml');
      try {
        await fs.promises.access(globalConfig);
        configPath = globalConfig;
      } catch {
        return cfg;
      }
    } else {
      return cfg;
    }
  }
  try {
    const text = await fs.promises.readFile(configPath, 'utf-8');
    const lines = text.split('\n').map(line => {
      const hashIdx = line.indexOf('#');
      return hashIdx !== -1 ? line.slice(0, hashIdx) : line;
    });
    const cleanText = lines.join('\n');
    const read = (key: string): string | undefined => {
      const m = cleanText.match(new RegExp(`^${key}\\s*:\\s*["']?([^\\s"'\\n]+)["']?`, 'm'));
      return m ? m[1] : undefined;
    };
    const provider = read('provider');
    if (provider === 'openai' || provider === 'groq' || provider === 'ollama' || provider === 'anthropic' || provider === 'claude-cli' || provider === 'gemini-cli' || provider === 'codex-cli') {
      cfg.provider = provider;
    }
    cfg.anthropic_api_key = read('anthropic_api_key');
    cfg.openai_api_key = read('openai_api_key');
    cfg.openai_model = read('openai_model');
    cfg.openai_base_url = read('openai_base_url');
    cfg.groq_api_key = read('groq_api_key');
    cfg.groq_model = read('groq_model');
    cfg.ollama_url = read('ollama_url');
    cfg.ollama_model = read('ollama_model');
  } catch {
    // fall through to default
  }
  return cfg;
}

// Validates an optional openai_base_url read out of config.yml, for OpenAI-
// compatible endpoints (GLM/Zhipu, OpenRouter, DeepSeek, Together, ...). The
// API key is sent as a bearer token on every request, so the endpoint must be
// https:// except for a bare localhost/127.0.0.1 gateway, which has no TLS to
// offer. Called from selectProvider (not from readConfig itself) so that the
// many read-only callers of readConfig, e.g. hasUsableProvider,
// resolveProviderLabel, checkProviderReady, stay fail-open and never crash on
// a bad config value they do not even use; only the actual openai path that
// depends on the value throws, mirroring the existing "key not set" error.
function assertValidOpenAiBaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`openai_base_url "${rawUrl}" is not a valid URL. Use an https:// URL, e.g. https://api.z.ai/api/paas/v4.`);
  }
  const isLocalHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error(`openai_base_url must use https:// (http:// is only allowed for localhost/127.0.0.1 gateways). Got "${rawUrl}".`);
  }
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

/**
 * Honest one-line note about where the redacted diffs go, mirroring
 * resolveProviderLabel's precedence. Used in the live learn trace so the privacy
 * promise is restated at the exact moment data leaves (or does not leave) the
 * machine. Local Ollama is the only case where nothing leaves; an Ollama
 * `-cloud` model runs on Ollama's servers, so it is treated as remote.
 */
export function extractionPrivacyNote(): string {
  const label = resolveProviderLabel();
  if (label === 'none') return '';
  const forced = process.env['CC_HABITS_PROVIDER'];
  const cfg = readConfig();
  const provider = forced ?? cfg.provider;
  if (provider === 'ollama') {
    const model = process.env['CC_HABITS_OLLAMA_MODEL'] ?? cfg.ollama_model;
    return isCloudOllamaModel(model)
      ? 'sending redacted diffs to Ollama Cloud'
      : 'nothing leaves this machine';
  }
  return `sending redacted diffs to ${provider}`;
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

export interface ProviderReadiness {
  ok: boolean;
  reason?: string;       // short, plain-language cause when not ok
  suggestion?: string;   // one actionable next step
}

// Network-aware pre-flight for the configured provider. hasUsableProvider() only
// checks that a credential exists (synchronous, never touches the network), so a
// running-but-broken Ollama (daemon down, model not pulled) still passes it and
// then dies on the actual generate call, AFTER we have already announced work and
// prompted the user. This probes the one provider we can verify locally (Ollama)
// so the scan/learn flow can skip with an actionable message up front instead of
// printing "analyzing..." and then "fetch failed". Cloud key providers are left to
// hasUsableProvider (credential) plus the typed error on the real call.
export async function checkProviderReady(): Promise<ProviderReadiness> {
  const cfg = readConfig();
  const provider = process.env['CC_HABITS_PROVIDER'] ?? cfg.provider;
  if (provider !== 'ollama') return { ok: true };

  const url   = process.env['CC_HABITS_OLLAMA_URL'] ?? cfg.ollama_url ?? 'http://localhost:11434';
  const model = process.env['CC_HABITS_OLLAMA_MODEL'] ?? cfg.ollama_model ?? 'llama3.2';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `Ollama returned HTTP ${res.status}`, suggestion: 'Restart Ollama, then retry.' };
    }
    const data  = await res.json() as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map(m => m?.name).filter((n): n is string => !!n);
    // A cloud model is not in the local tag list and runs remotely, so a reachable
    // daemon is all we can verify here; a real cloud outage surfaces on the generate
    // call and is mapped to a friendly message by the caller.
    if (isCloudOllamaModel(model)) return { ok: true };
    if (names.length > 0 && !names.includes(model)) {
      return {
        ok: false,
        reason: `Ollama model "${model}" is not installed`,
        suggestion: `Run \`ollama pull ${model}\`, or \`cch init --provider ollama\` to pick an installed model.`,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'Ollama is not reachable',
      suggestion: 'Start it with `ollama serve` (or open the Ollama app), then retry. No API key needed.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function selectProvider(cfgInput?: ProviderConfig): Provider {
  const cfg = cfgInput ?? readConfig();

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
    // The model name is passed through unchanged, no allowlist: a custom
    // base_url points at an OpenAI-compatible endpoint that may serve models
    // OpenAI itself never heard of (e.g. glm-4.6, deepseek-chat).
    if (cfg.openai_base_url) assertValidOpenAiBaseUrl(cfg.openai_base_url);
    return new OpenAIProvider(key, cfg.openai_model ?? 'gpt-4o-mini', cfg.openai_base_url);
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
// Local-only defaults. cc-habits markets Ollama as the "fully local, nothing
// leaves your machine" option, so auto-selection must never prefer a cloud model.
const PREFERRED_OLLAMA_MODELS = ['llama3.2', 'qwen2.5-coder:7b', 'qwen2.5-coder:3b'];

// Ollama "cloud" models carry a `-cloud` tag suffix (e.g. gemma4:31b-cloud).
// Their inference runs on Ollama's servers, not the local machine: requests are
// proxied through the local daemon but the data still leaves the device. This
// matters for cc-habits' "fully local" privacy claim, so callers use this to tell
// the truth about where a given model runs.
export function isCloudOllamaModel(model?: string): boolean {
  return !!model && /-cloud$/i.test(model.trim());
}

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
    // Preference order, biased away from cloud models so we never silently route a
    // "local" fallback through Ollama's cloud: an explicitly configured model wins
    // (even a cloud one, since that is the user's deliberate choice), then a known
    // local default, then any local model, and only a cloud model when nothing
    // local is installed.
    const configured   = cfg.ollama_model && names.includes(cfg.ollama_model) ? cfg.ollama_model : undefined;
    const preferredLocal = PREFERRED_OLLAMA_MODELS.find(p => names.includes(p));
    const firstLocal   = names.find(n => !isCloudOllamaModel(n));
    const model = configured ?? preferredLocal ?? firstLocal ?? names[0];
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
    const cfg = await readConfigAsync();
    return selectProvider(cfg);
  } catch (e) {
    if (!shouldTryOllamaFallback()) throw e;
    const found = await detectOllama();
    if (!found) throw e; // keep the original "no provider configured" error
    if (!ollamaFallbackAnnounced) {
      ollamaFallbackAnnounced = true;
      const where = isCloudOllamaModel(found.model)
        ? `Ollama cloud model ${found.model} (runs on Ollama's servers, redacted diffs leave your machine)`
        : `local Ollama (${found.model})`;
      process.stderr.write(`cc-habits: no provider configured, using ${where}\n`);
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
