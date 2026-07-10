import { spawn } from 'child_process';
import {
  Provider,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
  ProviderNotInstalledError,
  ProviderQuotaError,
} from './types';

export class AntigravityCliProvider implements Provider {
  name = 'antigravity-cli';

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('agy', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new ProviderTimeoutError(this.name, opts.timeoutMs));
      }, opts.timeoutMs);

      child.on('error', (err: any) => {
        clearTimeout(timeout);
        if (err.code === 'ENOENT') {
          reject(new ProviderNotInstalledError(this.name));
        } else {
          reject(err);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        const combined = (stdout + '\n' + stderr).toLowerCase();
        
        if (code !== 0) {
          if (combined.includes('quota') || combined.includes('credit') || combined.includes('balance exhausted')) {
            return reject(new ProviderQuotaError(this.name, stderr || undefined));
          }
          if (combined.includes('rate limit') || combined.includes('429') || combined.includes('too many requests')) {
            return reject(new ProviderRateLimitError(this.name));
          }
          if (
            combined.includes('auth') ||
            combined.includes('login') ||
            combined.includes('unauthorized') ||
            combined.includes('key') ||
            combined.includes('token')
          ) {
            return reject(new ProviderAuthError(this.name, stderr || undefined));
          }
          return reject(new Error(`antigravity CLI failed with exit code ${code}: ${stderr || stdout}`));
        }

        resolve(stdout || '');
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
