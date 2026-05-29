import { Provider, ProviderTimeoutError } from './types';

// Local Ollama runtime — air-gapped option. No auth, no rate limits.
export class OllamaProvider implements Provider {
  name = 'ollama';

  constructor(private url: string, private model: string) {}

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
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
      if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);
      const data = await res.json() as { response?: string };
      return data.response ?? '';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw new ProviderTimeoutError(this.name, opts.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
