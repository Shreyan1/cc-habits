import Anthropic from '@anthropic-ai/sdk';
import { Provider, ProviderRateLimitError, ProviderTimeoutError } from './index';

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const message = await this.client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: opts.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal },
      );
      const first = message.content[0];
      if (!first || first.type !== 'text') return '';
      return (first as { type: 'text'; text: string }).text;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429) throw new ProviderRateLimitError(this.name);
      if ((e as { name?: string }).name === 'AbortError') throw new ProviderTimeoutError(this.name, opts.timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
