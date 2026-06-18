import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { selectProviderAsync, detectOllama, resetOllamaAnnounceForTests, isCloudOllamaModel } from '../src/providers';

const origConfigFile = storagePaths.configFile;
const SAVED_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'CC_HABITS_PROVIDER', 'CC_HABITS_OLLAMA_URL', 'CC_HABITS_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function writeConfig(body: string): void {
  fs.writeFileSync(storagePaths.configFile, body, 'utf-8');
}

// Build a fake Ollama /api/tags responder.
function mockOllama(models: string[], opts: { ok?: boolean; reject?: boolean } = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (opts.reject) throw new Error('ECONNREFUSED');
    return {
      ok: opts.ok ?? true,
      json: async () => ({ models: models.map(name => ({ name })) }),
    } as Response;
  }));
}

beforeEach(() => {
  for (const k of SAVED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-provfb-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
  writeConfig('disabled: false\n'); // no provider, no key
  resetOllamaAnnounceForTests();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  storagePaths.configFile = origConfigFile;
  for (const k of SAVED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isCloudOllamaModel', () => {
  it('flags models with a -cloud tag suffix', () => {
    expect(isCloudOllamaModel('gemma4:31b-cloud')).toBe(true);
    expect(isCloudOllamaModel('gpt-oss:120b-cloud')).toBe(true);
    expect(isCloudOllamaModel('qwen3-coder:480b-CLOUD')).toBe(true);
  });
  it('does not flag local models or empty input', () => {
    expect(isCloudOllamaModel('llama3.2')).toBe(false);
    expect(isCloudOllamaModel('qwen2.5-coder:7b')).toBe(false);
    expect(isCloudOllamaModel('cloud-llama')).toBe(false); // -cloud must be a suffix
    expect(isCloudOllamaModel(undefined)).toBe(false);
    expect(isCloudOllamaModel('')).toBe(false);
  });
});

describe('detectOllama', () => {
  it('returns the first model when no preference matches', async () => {
    mockOllama(['mistral:latest', 'qwen:7b']);
    const res = await detectOllama();
    expect(res).toEqual({ url: 'http://localhost:11434', model: 'mistral:latest' });
  });

  it('prefers a known local model over a cloud model', async () => {
    // Never silently auto-select an Ollama cloud model: that would route a
    // "fully local" fallback through Ollama's servers without the user choosing it.
    mockOllama(['mistral:latest', 'gemma4:31b-cloud', 'llama3.2']);
    const res = await detectOllama();
    expect(res?.model).toBe('llama3.2');
  });

  it('falls back to any local model before a cloud model', async () => {
    mockOllama(['gemma4:31b-cloud', 'mistral:latest']);
    const res = await detectOllama();
    expect(res?.model).toBe('mistral:latest');
  });

  it('uses a cloud model only when nothing local is installed', async () => {
    mockOllama(['gemma4:31b-cloud']);
    const res = await detectOllama();
    expect(res?.model).toBe('gemma4:31b-cloud');
  });

  it('respects an explicitly configured model over the local default', async () => {
    writeConfig('ollama_model: qwen:7b\n');
    mockOllama(['llama3.2', 'qwen:7b']);
    const res = await detectOllama();
    expect(res?.model).toBe('qwen:7b');
  });

  it('returns null when Ollama is unreachable', async () => {
    mockOllama([], { reject: true });
    expect(await detectOllama()).toBeNull();
  });

  it('returns null when Ollama exposes no models', async () => {
    mockOllama([]);
    expect(await detectOllama()).toBeNull();
  });

  it('honors CC_HABITS_OLLAMA_URL', async () => {
    process.env['CC_HABITS_OLLAMA_URL'] = 'http://127.0.0.1:9999';
    mockOllama(['llama3.2']);
    const res = await detectOllama();
    expect(res?.url).toBe('http://127.0.0.1:9999');
  });
});

describe('selectProviderAsync Ollama fallback', () => {
  it('falls back to Ollama and announces a local model honestly', async () => {
    mockOllama(['llama3.2']);
    const provider = await selectProviderAsync();
    expect(provider.name).toBe('ollama');
    const announced = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(announced).toContain('using local Ollama (llama3.2)');
  });

  it('does not call a cloud-only fallback "local" in its announcement', async () => {
    mockOllama(['gemma4:31b-cloud']);
    const provider = await selectProviderAsync();
    expect(provider.name).toBe('ollama');
    const announced = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(announced).not.toContain('local Ollama (gemma4:31b-cloud)');
    expect(announced).toContain("leave your machine");
  });

  it('announces only once per process', async () => {
    mockOllama(['llama3.2']);
    await selectProviderAsync();
    await selectProviderAsync();
    const announces = stderrSpy.mock.calls.map(c => String(c[0])).filter(s => s.includes('using local Ollama'));
    expect(announces).toHaveLength(1);
  });

  it('rethrows the original error when no provider and Ollama is down', async () => {
    mockOllama([], { reject: true });
    await expect(selectProviderAsync()).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('uses the configured provider and never probes Ollama when a key is present', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const provider = await selectProviderAsync();
    expect(provider.name).not.toBe('ollama');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects an explicit non-Ollama provider choice and does not fall back', async () => {
    // Explicit groq with no key: must fail with the groq error, not silently use Ollama.
    writeConfig('provider: groq\n');
    mockOllama(['llama3.2']);
    await expect(selectProviderAsync()).rejects.toThrow(/Groq/);
    const announced = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(announced).not.toContain('Ollama');
  });
});
