import fs from 'fs';
import path from 'path';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH means the process does not exist.
    // EPERM means the process exists but we don't have permission to signal it,
    // which still implies it is alive.
    return e.code !== 'ESRCH';
  }
}

/**
 * Attempts to acquire an atomic file lock.
 * If the lock is held by another alive process, it will poll until timeoutMs.
 * If the lock is stale (held by a dead process), the lock is broken and acquired.
 */
export async function acquireLock(
  lockFile: string,
  timeoutMs = 10000,
  pollIntervalMs = 100
): Promise<boolean> {
  const start = Date.now();
  const dir = path.dirname(lockFile);
  // Per-process temp file holding our pid. We hard-link it onto the lock path:
  // link() is atomic and fails with EEXIST if the target exists, so the lock
  // file, once present, ALREADY contains the pid. This closes the TOCTOU window
  // where a plain create-then-write left the lock momentarily empty and a racing
  // process misread that empty file as a stale lock and broke it.
  const tmpFile = `${lockFile}.${process.pid}.tmp`;

  while (true) {
    try {
      // Ensure the directory exists
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Stage our pid in a temp file, then atomically link it into place.
      fs.writeFileSync(tmpFile, String(process.pid));
      try {
        fs.linkSync(tmpFile, lockFile);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
      }
      return true;
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        // Lock file exists. Check if it's stale.
        try {
          const content = fs.readFileSync(lockFile, 'utf-8').trim();
          const pid = parseInt(content, 10);
          if (isNaN(pid) || !isPidAlive(pid)) {
            // Stale lock: break it by deleting it
            try {
              fs.unlinkSync(lockFile);
            } catch (unlinkErr) {
              // Ignore if deleted by someone else
            }
            // Retry immediately after breaking the stale lock
            continue;
          }
        } catch (readErr) {
          // If we couldn't read (maybe unlinked by someone else in the meantime),
          // retry immediately.
          continue;
        }
      } else {
        // Any other error (e.g. permission denied) is rethrown
        throw e;
      }
    }

    if (Date.now() - start >= timeoutMs) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Releases the lock file, only if it was acquired by the current process.
 */
export function releaseLock(lockFile: string): void {
  try {
    if (fs.existsSync(lockFile)) {
      const content = fs.readFileSync(lockFile, 'utf-8').trim();
      const pid = parseInt(content, 10);
      if (pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
