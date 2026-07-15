import { spawn } from 'child_process';
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
    return new Promise<string>((resolve, reject) => {
      const child = spawn('gemini', ['-p', '-'], {
        timeout: opts.timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('error', (err: any) => {
        if (err.code === 'ENOENT') {
          reject(new ProviderNotInstalledError(this.name));
        } else if (err.code === 'ETIMEDOUT') {
          reject(new ProviderTimeoutError(this.name, opts.timeoutMs));
        } else {
          reject(err);
        }
      });

      child.on('close', (status, signal) => {
        if (signal === 'SIGTERM') {
          reject(new ProviderTimeoutError(this.name, opts.timeoutMs));
          return;
        }

        const combined = (stdout + '\n' + stderr).toLowerCase();

        if (status !== 0) {
          if (combined.includes('quota') || combined.includes('credit') || combined.includes('balance exhausted')) {
            reject(new ProviderQuotaError(this.name, stderr || undefined));
            return;
          }
          if (combined.includes('rate limit') || combined.includes('429') || combined.includes('too many requests')) {
            reject(new ProviderRateLimitError(this.name));
            return;
          }
          if (
            combined.includes('auth') ||
            combined.includes('login') ||
            combined.includes('unauthorized') ||
            combined.includes('key') ||
            combined.includes('token')
          ) {
            reject(new ProviderAuthError(this.name, stderr || undefined));
            return;
          }
          reject(new Error(`gemini CLI failed with exit code ${status}: ${stderr || stdout}`));
          return;
        }

        resolve(stdout || '');
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
