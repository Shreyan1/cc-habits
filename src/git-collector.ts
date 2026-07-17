import { execFile } from 'child_process';
import { promisify } from 'util';
import { captureFromCli } from './capture';
import { readHistory, readSignals } from './storage';
import { mapWithConcurrencyLimit } from './concurrency';

const execFileAsync = promisify(execFile);

// SECURITY: this module runs automatically from the post-commit git hook, so it
// processes untrusted repository content (commit ranges and file names). Never
// build shell command strings here. We use execFileAsync with an argument array
// so no shell is involved and metacharacters in file names or refs are passed
// literally to git, never interpreted. We also validate the user-supplied range
// to block git option-injection (a ref starting with "-").

// Conservative allowlist for a commit range / ref. Must start with an
// alphanumeric or "/" (never "-", which git would read as an option) and may
// contain the usual ref characters plus a single ".." range separator.
const SAFE_REF = /^[A-Za-z0-9_/][A-Za-z0-9_./~^-]*(\.\.[A-Za-z0-9_./~^-]+)?$/;

async function git(args: string[], cwdOverride?: string, ignoreOutput = false): Promise<string> {
  const options = {
    encoding: 'utf-8' as const,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    ...(cwdOverride ? { cwd: cwdOverride } : {}),
  };
  if (ignoreOutput) {
    await execFileAsync('git', args, options);
    return '';
  }
  const { stdout } = await execFileAsync('git', args, options);
  return stdout;
}

export interface GitCaptureResult {
  signalsCaptured: number;
  // What was captured, newest-file-last, so the CLI can show the user exactly
  // what landed in the log without making them open `cch log`.
  captured: Array<{ file: string; commit: string }>;
}

export async function runGitCapture(range?: string, cwdOverride?: string): Promise<GitCaptureResult> {
  let signalsCaptured = 0;
  const captured: Array<{ file: string; commit: string }> = [];

  // Resolve commit range. If none provided, default to last commit HEAD~1..HEAD.
  let commitRange = range?.trim();
  if (commitRange) {
    // Reject anything that is not a plain ref/range. This blocks both shell
    // metacharacters and git option-injection via a leading dash.
    if (!SAFE_REF.test(commitRange)) {
      return { signalsCaptured: 0, captured };
    }
  } else {
    try {
      await git(['rev-parse', '--verify', 'HEAD~1'], cwdOverride, true);
      commitRange = 'HEAD~1..HEAD';
    } catch {
      commitRange = 'HEAD';
    }
  }

  try {
    let commits: string[] = [];
    if (commitRange.includes('..') || commitRange.includes('~')) {
      const output = await git(['log', '--reverse', '--format=%H', commitRange], cwdOverride);
      commits = output.split('\n').map(c => c.trim()).filter(Boolean);
    } else {
      const sha = (await git(['rev-parse', commitRange], cwdOverride)).trim();
      if (sha) commits = [sha];
    }

    for (const sha of commits) {
      let parent = `${sha}~1`;
      try {
        await git(['rev-parse', '--verify', parent], cwdOverride, true);
      } catch {
        // Fallback to the empty-tree SHA when no parent exists (first commit).
        parent = '4b825dc642cb6eb9a0ff12f406d9b61400b5d465';
      }

      // "--" separates revisions from pathspecs so a file named like an option
      // cannot be misread.
      const filesOutput = await git(['diff', '--name-only', parent, sha], cwdOverride);
      const files = filesOutput.split('\n').map(f => f.trim()).filter(Boolean);

      // Diff the modified files with a bounded pool. Each file spawns a git
      // child process, so fanning every file out at once (Promise.all over all
      // N files) can hit 100+ concurrent processes on a large commit and risk
      // FD/PID exhaustion on constrained CI. The pool caps in-flight work and,
      // because mapWithConcurrencyLimit preserves input order, the `captured`
      // array stays newest-file-last deterministically.
      const capturedForCommit = await mapWithConcurrencyLimit(
        files,
        8,
        async (file) => {
          try {
            const diff = await git(['diff', parent, sha, '--', file], cwdOverride);
            if (!diff.trim()) return null;
            const didCapture = captureFromCli({
              file,
              diff,
              session: `git-${sha.slice(0, 7)}`,
              source: 'git'
            });
            return didCapture ? ({ file, commit: sha.slice(0, 7) } as const) : null;
          } catch {
            // Skip files where git diff fails (binary, deleted, renamed edge cases).
            return null;
          }
        }
      );
      for (const entry of capturedForCommit) {
        if (entry) {
          signalsCaptured++;
          captured.push(entry);
        }
      }
    }
  } catch {
    // Silent fail. The post-commit hook must never break a commit.
  }

  return { signalsCaptured, captured };
}

export function shouldTriggerGitLearn(): boolean {
  try {
    const history = readHistory();
    const lastSnapshot = history[history.length - 1];
    const lastTs = lastSnapshot ? Date.parse(lastSnapshot.ts) : 0;

    const signals = readSignals();
    const newGitSignals = signals.filter(s => {
      if (s.source !== 'git') return false;
      const sigTs = s.ts ? Date.parse(s.ts) : 0;
      return sigTs > lastTs;
    });

    return newGitSignals.length >= 10; // Trigger learning every 10 commits/files
  } catch {
    return false;
  }
}
