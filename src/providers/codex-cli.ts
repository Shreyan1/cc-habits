import { spawnSync } from 'child_process';
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
    // A unique temp file for the final-message capture; always cleaned up.
    const outFile = path.join(
      os.tmpdir(),
      `cc-habits-codex-${process.pid}-${Date.now()}.txt`,
    );

    try {
      const result = spawnSync(
        'codex',
        ['exec', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never', '-o', outFile, '-'],
        {
          input: prompt,
          timeout: opts.timeoutMs,
          encoding: 'utf-8',
          maxBuffer: 32 * 1024 * 1024,
        },
      );

      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ProviderNotInstalledError(this.name);
        }
        if (result.signal === 'SIGTERM' || (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
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
          combined.includes('not logged in') ||
          combined.includes('unauthorized') ||
          combined.includes('authenticate') ||
          combined.includes('login') ||
          combined.includes('auth')
        ) {
          throw new ProviderAuthError(this.name, result.stderr || undefined);
        }
        throw new Error(`codex CLI failed with exit code ${result.status}: ${result.stderr || result.stdout}`);
      }

      // Prefer the captured final message; fall back to stdout if the file is
      // empty or absent (older Codex builds, or -o unsupported).
      let response = '';
      try {
        if (fs.existsSync(outFile)) response = fs.readFileSync(outFile, 'utf-8').trim();
      } catch {
        // fall through to stdout
      }
      return response || stdout;
    } finally {
      try {
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {
        // best-effort cleanup; never fail extraction over a temp file
      }
    }
  }
}
