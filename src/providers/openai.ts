import { Provider, ProviderRateLimitError, ProviderTimeoutError } from './index';

// OpenAI Chat Completions API — also used by any compatible endpoint.
export class OpenAIProvider implements Provider {
  name = 'openai';
  protected endpoint = 'https://api.openai.com/v1/chat/completions';

  constructor(protected apiKey: string, protected model: string) {}

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
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
      if (res.status === 429) throw new ProviderRateLimitError(this.name);
      if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') throw new ProviderTimeoutError(this.name, opts.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
