import { Provider, ProviderRateLimitError, ProviderTimeoutError, ProviderPayloadError, ProviderAuthError } from './types';

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

// OpenAI Chat Completions API, also used by any compatible endpoint (Groq).
export class OpenAIProvider implements Provider {
  name = 'openai';
  protected endpoint = 'https://api.openai.com/v1/chat/completions';

  constructor(protected apiKey: string, protected model: string) {}

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

      if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    }
    // Unreachable: the loop either returns, retries, or throws.
    throw new ProviderRateLimitError(this.name);
  }
}
