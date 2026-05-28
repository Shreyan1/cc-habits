import { execSync } from 'child_process';
import { captureFromCli } from './capture';
import { readHistory, readSignals } from './storage';

export function runGitCapture(range?: string, cwdOverride?: string): { signalsCaptured: number } {
  let signalsCaptured = 0;
  const execOpts = cwdOverride ? { cwd: cwdOverride } : {};
  
  // Resolve commit range. If none provided, default to last commit: HEAD~1..HEAD
  let commitRange = range?.trim();
  if (!commitRange) {
    try {
      // Check if HEAD~1 exists
      execSync('git rev-parse --verify HEAD~1', { ...execOpts, stdio: 'ignore' });
      commitRange = 'HEAD~1..HEAD';
    } catch {
      // No HEAD~1, so diff HEAD against empty tree
      commitRange = 'HEAD';
    }
  }

  try {
    let commits: string[] = [];
    if (commitRange.includes('..') || commitRange.includes('~')) {
      // Get all commits in the range (oldest first)
      const output = execSync(`git log --reverse --format="%H" ${commitRange}`, { ...execOpts, encoding: 'utf-8' });
      commits = output.split('\n').map(c => c.trim()).filter(Boolean);
    } else {
      // Single commit/ref. Verify it first.
      const sha = execSync(`git rev-parse ${commitRange}`, { ...execOpts, encoding: 'utf-8' }).trim();
      if (sha) commits = [sha];
    }

    for (const sha of commits) {
      // For each commit, get the list of changed files
      let parent = `${sha}~1`;
      try {
        execSync(`git rev-parse --verify ${parent}`, { ...execOpts, stdio: 'ignore' });
      } catch {
        // Fallback to empty tree SHA if no parent exists
        parent = '4b825dc642cb6eb9a0ff12f406d9b61400b5d465';
      }

      // Get changed files
      const filesOutput = execSync(`git diff --name-only ${parent} ${sha}`, { ...execOpts, encoding: 'utf-8' });
      const files = filesOutput.split('\n').map(f => f.trim()).filter(Boolean);

      for (const file of files) {
        try {
          // Get the diff for this specific file
          const diff = execSync(`git diff ${parent} ${sha} -- "${file}"`, { ...execOpts, encoding: 'utf-8' });
          if (diff.trim()) {
            const captured = captureFromCli({
              file,
              diff,
              session: `git-${sha.slice(0, 7)}`,
              source: 'git'
            });
            if (captured) signalsCaptured++;
          }
        } catch {
          // Skip if file diff fails (e.g. binary files or deleted files where git diff fails)
        }
      }
    }
  } catch (e) {
    // Silent fail or log error (post-commit must never break git commits)
  }

  return { signalsCaptured };
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
