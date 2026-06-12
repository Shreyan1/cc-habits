import { spawnSync } from 'child_process';
import {
  Provider,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
  ProviderNotInstalledError,
  ProviderQuotaError,
} from './types';

export class GeminiCliProvider implements Provider {
  name = 'gemini-cli';

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    const result = spawnSync('gemini', ['-p', prompt], {
      timeout: opts.timeoutMs,
      encoding: 'utf-8',
    });

    if (result.error) {
      if ((result.error as any).code === 'ENOENT') {
        throw new ProviderNotInstalledError(this.name);
      }
      if (result.signal === 'SIGTERM' || (result.error as any).code === 'ETIMEDOUT') {
        throw new ProviderTimeoutError(this.name, opts.timeoutMs);
      }
      throw result.error;
    }

    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    const combined = (stdout + '\n' + stderr).toLowerCase();

    if (result.status !== 0) {
      if (combined.includes('quota') || combined.includes('credit') || combined.includes('balance exhausted')) {
        throw new ProviderQuotaError(this.name, result.stderr || undefined);
      }
      if (combined.includes('rate limit') || combined.includes('429') || combined.includes('too many requests')) {
        throw new ProviderRateLimitError(this.name);
      }
      if (
        combined.includes('auth') ||
        combined.includes('login') ||
        combined.includes('unauthorized') ||
        combined.includes('key') ||
        combined.includes('token')
      ) {
        throw new ProviderAuthError(this.name, result.stderr || undefined);
      }
      throw new Error(`gemini CLI failed with exit code ${result.status}: ${result.stderr || result.stdout}`);
    }

    return result.stdout || '';
  }
}
