/**
 * Multiple-Ollama-model behaviour: how detectOllama() chooses among installed
 * models (configured wins, then a preferred local default, then any local, and a
 * cloud model only as a last resort), and how OllamaProvider surfaces a model
 * that is not installed. fetch is mocked so these stay hermetic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectOllama, ProviderModelNotFoundError } from '../src/providers';
import { OllamaProvider } from '../src/providers/ollama';
import { storagePaths } from '../src/storage';

function tagsResponse(names: string[]): Response {
  return new Response(JSON.stringify({ models: names.map(n => ({ name: n })) }), { status: 200 });
}

describe('detectOllama model selection with several models', () => {
  const origConfig = storagePaths.configFile;
  const origFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-ollama-'));
    storagePaths.configFile = path.join(tmpDir, 'config.yml');
    process.env['CC_HABITS_DIR'] = tmpDir;
    delete process.env['CC_HABITS_OLLAMA_URL'];
  });
  afterEach(() => {
    storagePaths.configFile = origConfig;
    globalThis.fetch = origFetch;
    delete process.env['CC_HABITS_DIR'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers a local model over an installed cloud model when none is configured', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\n');
    globalThis.fetch = (async () => tagsResponse(['gemma4:31b-cloud', 'llama3.2:1b'])) as typeof fetch;
    const res = await detectOllama();
    expect(res?.model).toBe('llama3.2:1b'); // skips the -cloud model
  });

  it('honours an explicitly configured model, even a cloud one (deliberate choice)', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\nollama_model: gemma4:31b-cloud\n');
    globalThis.fetch = (async () => tagsResponse(['gemma4:31b-cloud', 'llama3.2:1b'])) as typeof fetch;
    const res = await detectOllama();
    expect(res?.model).toBe('gemma4:31b-cloud');
  });

  it('falls back to a known preferred local default when present', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\n');
    globalThis.fetch = (async () => tagsResponse(['codellama:13b', 'llama3.2', 'qwen2.5-coder:7b'])) as typeof fetch;
    const res = await detectOllama();
    expect(res?.model).toBe('llama3.2'); // first PREFERRED_OLLAMA_MODELS match
  });

  it('uses a cloud model only when nothing local is installed', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\n');
    globalThis.fetch = (async () => tagsResponse(['gemma4:31b-cloud'])) as typeof fetch;
    const res = await detectOllama();
    expect(res?.model).toBe('gemma4:31b-cloud'); // last-resort fallback
  });

  it('returns null when Ollama is unreachable', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\n');
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect(await detectOllama()).toBeNull();
  });

  it('returns null when no models are installed', async () => {
    fs.writeFileSync(storagePaths.configFile, 'provider: ollama\n');
    globalThis.fetch = (async () => tagsResponse([])) as typeof fetch;
    expect(await detectOllama()).toBeNull();
  });
});

describe('OllamaProvider model-not-found', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('throws ProviderModelNotFoundError on a 404 naming the model', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "model 'llama3.2' not found, try pulling it first" }), { status: 404 })
    ) as typeof fetch;
    const provider = new OllamaProvider('http://localhost:11434', 'llama3.2');
    await expect(provider.generate('p', { maxTokens: 10, timeoutMs: 1000 }))
      .rejects.toBeInstanceOf(ProviderModelNotFoundError);
  });

  it('carries the model name for the hint', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    ) as typeof fetch;
    const provider = new OllamaProvider('http://localhost:11434', 'mistral-x:7b');
    await provider.generate('p', { maxTokens: 10, timeoutMs: 1000 }).catch((e: unknown) => {
      expect(e).toBeInstanceOf(ProviderModelNotFoundError);
      expect((e as ProviderModelNotFoundError).model).toBe('mistral-x:7b');
    });
  });
});
