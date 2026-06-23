import { Provider, ProviderTimeoutError, ProviderModelNotFoundError } from './types';

// Local Ollama runtime, air-gapped option. No auth, no rate limits.
export class OllamaProvider implements Provider {
  name = 'ollama';

  constructor(private url: string, private model: string) {}

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    // Local Ollama requires model connection/loading overhead (cold start).
    // Differentiate timeout: use 180 seconds for repository/doc scans (timeoutMs >= 90000),
    // and a dedicated 60 seconds connection/generation timeout for regular prompts.
    const actualTimeoutMs = opts.timeoutMs >= 90000 ? 180000 : 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), actualTimeoutMs);
    try {
      const res = await fetch(`${this.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { num_predict: opts.maxTokens },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        let rawError = '';
        try {
          const body = await res.json() as { error?: string };
          if (body && typeof body.error === 'string') {
            rawError = body.error;
            errMsg = `${body.error} (HTTP ${res.status})`;
          }
        } catch { /* ignore */ }
        // A missing model (not pulled, or a tag mismatch) is a setup problem, not
        // a generic failure: surface it as a typed error so the caller can tell
        // the user exactly how to fix it instead of crashing with a raw 404.
        if (res.status === 404 || /not found|try pulling/i.test(rawError)) {
          throw new ProviderModelNotFoundError(this.name, this.model);
        }
        throw new Error(`${this.name}: ${errMsg}`);
      }
      const data = await res.json() as { response?: string };
      return data.response ?? '';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw new ProviderTimeoutError(this.name, actualTimeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
