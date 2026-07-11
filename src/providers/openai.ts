import { Provider, ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError, ProviderAuthError, ProviderModelNotFoundError } from './types';

// Up to this many extra attempts after the first 429 before giving up.
const MAX_RATE_LIMIT_RETRIES = 2;
// Cap any single backoff so a hostile or large Retry-After cannot stall a session.
const MAX_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry-After is either delta-seconds or an HTTP date. Parse both, return ms.
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

// Parses a response body as JSON without ever throwing or leaking the raw
// response text. A custom base_url may point at a non-OpenAI-compatible
// endpoint that returns HTML, plain text, or truncated JSON on error;
// returns undefined on any parse failure so callers can map that to a clean
// typed error instead of crashing with a raw SyntaxError.
async function readJsonSafely(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// OpenAI's standard 404 shape is { error: { code: 'model_not_found', message } }.
// OpenAI-compatible endpoints (GLM, OpenRouter, DeepSeek, Together, ...) vary
// their exact code, so also accept any message that mentions both "model" and
// "not found".
function isModelNotFoundBody(body: unknown): boolean {
  const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  if (!err) return false;
  if (err.code === 'model_not_found') return true;
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('model') && msg.includes('not found');
}

// OpenAI Chat Completions API, also used by any compatible endpoint (Groq,
// and any custom base_url the user configures, e.g. GLM/Zhipu, OpenRouter,
// DeepSeek, Together).
export class OpenAIProvider implements Provider {
  name = 'openai';
  protected endpoint = 'https://api.openai.com/v1/chat/completions';

  // baseUrl, when set, replaces the default OpenAI host entirely; the request
  // still goes to the standard `/chat/completions` path relative to it. A
  // trailing slash on baseUrl is tolerated. Left unset, behavior is unchanged.
  constructor(protected apiKey: string, protected model: string, baseUrl?: string) {
    if (baseUrl) this.endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  // One request attempt with its own timeout budget.
  private async attempt(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw new ProviderTimeoutError(this.name, opts.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const res = await this.attempt(prompt, opts);

      if (res.status === 429) {
        // Out of retries, surface the rate-limit error to the caller.
        if (attempt === MAX_RATE_LIMIT_RETRIES) throw new ProviderRateLimitError(this.name);
        // Honor Retry-After when present, otherwise exponential backoff, both capped.
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const backoff = Math.min(retryAfter ?? 1_000 * 2 ** attempt, MAX_BACKOFF_MS);
        await sleep(backoff);
        continue;
      }

      // 413: payload too large, the caller applied the byte-budget cap but
      // the batch still exceeded the provider's limit. Surface a typed error
      // so callers can show a clear message instead of a raw "HTTP 413".
      if (res.status === 413) throw new ProviderPayloadError(this.name);

      // 401/403: a rejected or expired API key. Surface a typed auth error so the
      // caller shows "check your API key" guidance instead of a raw "HTTP 401".
      if (res.status === 401 || res.status === 403) throw new ProviderAuthError(this.name);

      // 404: on api.openai.com this is always a bad path, but on a custom
      // base_url it commonly means the configured model does not exist on
      // that endpoint. Surface the typed error so the caller can name the
      // model instead of a raw "HTTP 404".
      if (res.status === 404) {
        const body = await readJsonSafely(res);
        if (isModelNotFoundBody(body)) throw new ProviderModelNotFoundError(this.name, this.model);
        throw new Error(`${this.name}: HTTP 404`);
      }

      if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);

      const data = await readJsonSafely(res);
      if (!data || typeof data !== 'object') {
        throw new Error(`${this.name}: received a malformed or unexpected response.`);
      }
      const content = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
      return content ?? '';
    }
    // Unreachable: the loop either returns, retries, or throws.
    throw new ProviderRateLimitError(this.name);
  }
}
