/**
 * Tests for provider config parsing in readConfig (src/providers/index.ts).
 *
 * The reader must anchor each key at column 0 with the multiline flag, the same
 * convention config.ts already uses in setConfigValue/getConfigValue. Two real
 * failure modes this guards:
 *   1. A commented-out setting (`# provider: openai` above `provider: ollama`)
 *      must NOT be read as active. An unanchored match takes the first hit
 *      anywhere in the file, so it would wrongly pick the commented value.
 *   2. A value that legitimately contains `#` (an API key like `sk-a#bc`) must
 *      survive intact. This locks out the naive `line.indexOf('#')` comment
 *      strip that would truncate such a value at the first `#`.
 *
 * Exercised through selectProvider(), which calls readConfig(); the OpenAI path
 * uses a mocked fetch to read the key back off the Authorization header, the
 * same pattern as openai-base-url.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { storagePaths } from '../src/storage';
import { selectProvider } from '../src/providers';

const origConfigFile = storagePaths.configFile;
const origFetch = globalThis.fetch;
const SAVED_ENV = ['OPENAI_API_KEY', 'CC_HABITS_PROVIDER', 'CC_HABITS_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};
const OPTS = { maxTokens: 10, timeoutMs: 1000 };

let tmpDir: string;

function writeConfig(body: string): void {
  fs.writeFileSync(storagePaths.configFile, body, 'utf-8');
}

beforeEach(() => {
  for (const k of SAVED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-config-anchor-'));
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

describe('readConfig: anchoring and comments', () => {
  it('ignores a commented-out provider line and reads the active one', () => {
    writeConfig(
      '# provider: openai\n' +
      'provider: ollama\n' +
      'ollama_url: http://localhost:11434\n' +
      'ollama_model: llama3.2:1b\n',
    );
    // Unanchored, this returned the OpenAI provider (first `provider:` hit is the
    // commented one) and threw for the missing key. Anchored, ollama wins.
    expect(selectProvider().name).toBe('ollama');
  });

  it('ignores an inline comment written after the value', () => {
    writeConfig(
      'provider: ollama   # switched from openai\n' +
      'ollama_url: http://localhost:11434\n' +
      'ollama_model: llama3.2:1b\n',
    );
    expect(selectProvider().name).toBe('ollama');
  });

  it('does not read a commented-out api key as active config', () => {
    writeConfig(
      '# openai_api_key: sk-should-not-be-used\n' +
      'provider: ollama\n' +
      'ollama_url: http://localhost:11434\n' +
      'ollama_model: llama3.2:1b\n',
    );
    // The commented openai_api_key must not make selectProvider believe OpenAI
    // is configured; ollama is the active provider and selection must succeed.
    expect(selectProvider().name).toBe('ollama');
  });

  it('preserves a value that legitimately contains a hash', async () => {
    // A `#` mid-value (here an API key) must survive: no naive comment strip that
    // would truncate `sk-a#bc` to `sk-a`.
    writeConfig(
      'provider: openai\n' +
      'openai_api_key: "sk-a#bc"\n' +
      'openai_model: gpt-4o-mini\n',
    );
    let authHeader = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      authHeader = String((init.headers as Record<string, string>)['Authorization'] ?? '');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as typeof fetch;

    const provider = selectProvider();
    expect(provider.name).toBe('openai');
    await provider.generate('prompt', OPTS);
    expect(authHeader).toBe('Bearer sk-a#bc');
  });
});
