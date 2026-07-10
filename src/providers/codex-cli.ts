import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  Provider,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
  ProviderNotInstalledError,
  ProviderQuotaError,
} from './types';

/**
 * Uses the authenticated Codex CLI as the extraction brain, mirroring
 * ClaudeCliProvider / GeminiCliProvider but adapted to Codex's agent-style
 * `codex exec` interface:
 *
 *  - The prompt is piped via stdin (`-` placeholder) so large redacted diffs
 *    never hit the argv length limit.
 *  - `-s read-only` guarantees the extraction agent cannot modify any files,
 *    even though our prompt only asks for JSON. cc-habits must never let an
 *    extraction pass mutate the user's repo.
 *  - `--skip-git-repo-check` lets it run from any cwd (extraction is not tied
 *    to a repo).
 *  - `--output-last-message <file>` captures only the agent's final message,
 *    avoiding the interleaved tool/event chatter Codex otherwise prints to
 *    stdout. We read that file as the response.
 */
export class CodexCliProvider implements Provider {
  name = 'codex-cli';

  async generate(prompt: string, opts: { maxTokens: number; timeoutMs: number }): Promise<string> {
    const outFile = path.join(
      os.tmpdir(),
      `cc-habits-codex-${process.pid}-${Date.now()}.txt`,
    );

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          'codex',
          ['exec', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', '-o', outFile, '-'],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

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
          } else if (err.code === 'ETIMEDOUT') {
            reject(new ProviderTimeoutError(this.name, opts.timeoutMs));
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
              combined.includes('not logged in') ||
              combined.includes('unauthorized') ||
              combined.includes('authenticate') ||
              combined.includes('login') ||
              combined.includes('auth')
            ) {
              return reject(new ProviderAuthError(this.name, stderr || undefined));
            }
            return reject(new Error(`codex CLI failed with exit code ${code}: ${stderr || stdout}`));
          }
          resolve(stdout);
        });

        child.stdin.write(prompt);
        child.stdin.end();
      });

      let finalResponse = '';
      try {
        if (fs.existsSync(outFile)) finalResponse = fs.readFileSync(outFile, 'utf-8').trim();
      } catch {
        // fall through to stdout
      }
      return finalResponse || response;
    } finally {
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {
        // best-effort cleanup
      }
    }
  }
}
