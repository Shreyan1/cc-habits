/**
 * Tests for optional custom base_url support on the OpenAI provider, which lets
 * any OpenAI-compatible endpoint (GLM/Zhipu, OpenRouter, DeepSeek, Together, a
 * local gateway, ...) stand in for api.openai.com.
 *
 * Covers: endpoint construction (default unchanged, custom base_url, trailing
 * slash), config validation (https required, localhost/127.0.0.1 http
 * exception), model pass-through with no allowlist, and typed-error mapping
 * against non-OpenAI response shapes (auth, 404 model_not_found, 429,
 * malformed/unexpected JSON). fetch is mocked per-test with a real Response,
 * following the pattern already used for OpenAIProvider 429 tests in
 * v031.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { selectProvider } from '../src/providers';
import { OpenAIProvider } from '../src/providers/openai';
import { ProviderAuthError, ProviderModelNotFoundError, ProviderRateLimitError } from '../src/providers/types';

const origConfigFile = storagePaths.configFile;
const origFetch = globalThis.fetch;
const SAVED_ENV = ['OPENAI_API_KEY', 'CC_HABITS_PROVIDER', 'CC_HABITS_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};
const OPTS = { maxTokens: 10, timeoutMs: 1000 };

let tmpDir: string;

function writeConfig(body: string): void {
  fs.writeFileSync(storagePaths.configFile, body, 'utf-8');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  for (const k of SAVED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-openai-baseurl-'));
  process.env['CC_HABITS_DIR'] = tmpDir;
  storagePaths.configFile = path.join(tmpDir, 'config.yml');
});

afterEach(() => {
  storagePaths.configFile = origConfigFile;
  for (const k of SAVED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  globalThis.fetch = origFetch;
});

describe('OpenAIProvider endpoint construction', () => {
  it('uses the default api.openai.com endpoint when base_url is unset', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;

    const provider = new OpenAIProvider('key', 'gpt-4o-mini');
    await provider.generate('prompt', OPTS);
    expect(calledUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('posts to <base_url>/chat/completions when base_url is set', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;

    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await provider.generate('prompt', OPTS);
    expect(calledUrl).toBe('https://api.z.ai/api/paas/v4/chat/completions');
  });

  it('strips a trailing slash on base_url before appending the path', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;

    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4/');
    await provider.generate('prompt', OPTS);
    expect(calledUrl).toBe('https://api.z.ai/api/paas/v4/chat/completions');
  });

  it('passes the configured model through unchanged, with no allowlist', async () => {
    let sentBody: { model?: string } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;

    const provider = new OpenAIProvider('key', 'glm-4.6-flash-unusual-name', 'https://api.z.ai/api/paas/v4');
    await provider.generate('prompt', OPTS);
    expect(sentBody.model).toBe('glm-4.6-flash-unusual-name');
  });
});

describe('selectProvider openai base_url wiring', () => {
  it('reads openai_base_url from config.yml and uses it for requests', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    writeConfig('provider: openai\nopenai_model: glm-4.6\nopenai_base_url: https://api.z.ai/api/paas/v4\n');
    const provider = selectProvider();

    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof fetch;

    await provider.generate('prompt', OPTS);
    expect(calledUrl).toBe('https://api.z.ai/api/paas/v4/chat/completions');
  });

  it('keeps the default endpoint when openai_base_url is unset', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    writeConfig('provider: openai\n');
    const provider = selectProvider() as unknown as { endpoint: string };
    expect(provider.endpoint).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('rejects a non-localhost http:// base_url with a clear plain-language error', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    writeConfig('provider: openai\nopenai_base_url: http://example.com/v1\n');
    expect(() => selectProvider()).toThrow(/https:\/\//);
  });

  it('allows http:// for a localhost gateway', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    writeConfig('provider: openai\nopenai_base_url: http://localhost:8080/v1\n');
    expect(() => selectProvider()).not.toThrow();
  });

  it('allows http:// for a 127.0.0.1 gateway', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    writeConfig('provider: openai\nopenai_base_url: http://127.0.0.1:8080/v1\n');
    expect(() => selectProvider()).not.toThrow();
  });

  it('rejects a malformed base_url', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    writeConfig('provider: openai\nopenai_base_url: not-a-url\n');
    expect(() => selectProvider()).toThrow(/not a valid URL/);
  });
});

describe('OpenAIProvider typed-error mapping against non-OpenAI response shapes', () => {
  it('maps 401 to ProviderAuthError for a compatible endpoint', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'Invalid API key' }, 401)) as typeof fetch;
    const provider = new OpenAIProvider('bad-key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('maps 403 to ProviderAuthError for a compatible endpoint', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: 'Forbidden' }, 403)) as typeof fetch;
    const provider = new OpenAIProvider('bad-key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('maps a standard OpenAI-shaped 404 model_not_found body to ProviderModelNotFoundError', async () => {
    const body = { error: { code: 'model_not_found', message: 'The model `glm-9000` does not exist' } };
    globalThis.fetch = (async () => jsonResponse(body, 404)) as typeof fetch;
    const provider = new OpenAIProvider('key', 'glm-9000', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderModelNotFoundError);
  });

  it('maps a differently-shaped 404 "model ... not found" message to ProviderModelNotFoundError', async () => {
    const body = { error: { message: 'model deepseek-xl not found on this deployment' } };
    globalThis.fetch = (async () => jsonResponse(body, 404)) as typeof fetch;
    const provider = new OpenAIProvider('key', 'deepseek-xl', 'https://openrouter.ai/api/v1');
    await expect(provider.generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderModelNotFoundError);
  });

  it('does not misclassify an unrelated 404 as model_not_found', async () => {
    globalThis.fetch = (async () => jsonResponse({ error: { message: 'route not found' } }, 404)) as typeof fetch;
    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.not.toBeInstanceOf(ProviderModelNotFoundError);
  });

  it('maps 429 to ProviderRateLimitError after exhausting retries', async () => {
    globalThis.fetch = (async () => new Response('', { status: 429, headers: { 'retry-after': '0' } })) as typeof fetch;
    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('maps a non-JSON 200 body to a clean typed error, not a raw SyntaxError', async () => {
    globalThis.fetch = (async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toThrow(/malformed|unexpected/i);
  });

  it('maps an empty 200 body to a clean error rather than crashing', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toThrow(/malformed|unexpected/i);
  });

  it('maps a JSON-but-null 200 body to a clean error rather than crashing', async () => {
    globalThis.fetch = (async () => new Response('null', { status: 200 })) as typeof fetch;
    const provider = new OpenAIProvider('key', 'glm-4.6', 'https://api.z.ai/api/paas/v4');
    await expect(provider.generate('prompt', OPTS)).rejects.toThrow(/malformed|unexpected/i);
  });

  it('never includes the API key or Authorization header in any thrown error message', async () => {
    const secretKey = 'sk-super-secret-value-12345';
    const cases: Array<() => Response> = [
      () => jsonResponse({ error: 'unauthorized' }, 401),
      () => jsonResponse({ error: { code: 'model_not_found', message: 'model x not found' } }, 404),
      () => new Response('', { status: 500 }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const makeRes of cases) {
      globalThis.fetch = (async () => makeRes()) as typeof fetch;
      const provider = new OpenAIProvider(secretKey, 'glm-4.6', 'https://api.z.ai/api/paas/v4');
      const err = await provider.generate('prompt', OPTS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error); // asserts it actually rejected, not a silent pass
      const msg = (err as Error).message;
      expect(msg).not.toContain(secretKey);
      expect(msg.toLowerCase()).not.toContain('bearer');
      expect(msg.toLowerCase()).not.toContain('authorization');
    }
  });
});
