import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const snapshots = new Map<string, string>(); // uriString -> file content
const lastCaptured = new Map<string, number>(); // filePath -> timestamp

export function buildUnifiedDiff(prev: string, curr: string, fileName: string): string {
  const prevLines = prev.split(/\r?\n/);
  const currLines = curr.split(/\r?\n/);

  let prefixMatch = 0;
  while (prefixMatch < prevLines.length && prefixMatch < currLines.length && prevLines[prefixMatch] === currLines[prefixMatch]) {
    prefixMatch++;
  }

  let suffixMatch = 0;
  while (
    suffixMatch < prevLines.length - prefixMatch &&
    suffixMatch < currLines.length - prefixMatch &&
    prevLines[prevLines.length - 1 - suffixMatch] === currLines[currLines.length - 1 - suffixMatch]
  ) {
    suffixMatch++;
  }

  const trimmedPrev = prevLines.slice(prefixMatch, prevLines.length - suffixMatch);
  const trimmedCurr = currLines.slice(prefixMatch, currLines.length - suffixMatch);

  const m = trimmedPrev.length;
  const n = trimmedCurr.length;

  if (m === 0 && n === 0) return '';

  if (m > 1000 || n > 1000) {
    // Fallback for extremely large modified blocks to prevent memory/CPU DP explosion
    return [
      `--- ${fileName}`,
      `+++ ${fileName}`,
      ...trimmedPrev.map(l => `-${l}`),
      ...trimmedCurr.map(l => `+${l}`)
    ].join('\n');
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (trimmedPrev[i - 1] === trimmedCurr[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diffLines: string[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && trimmedPrev[i - 1] === trimmedCurr[j - 1]) {
      diffLines.push(` ${trimmedPrev[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.push(`+${trimmedCurr[j - 1]}`);
      j--;
    } else {
      diffLines.push(`-${trimmedPrev[i - 1]}`);
      i--;
    }
  }
  diffLines.reverse();

  return [
    `--- ${fileName}`,
    `+++ ${fileName}`,
    ...diffLines
  ].join('\n');
}

export function activateCollector(
  context: vscode.ExtensionContext,
  runCli: (args: string[]) => Promise<{ ok: boolean; out: string; err: string }>
): void {
  // Snapshot when document is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.scheme === 'file') {
        snapshots.set(doc.uri.toString(), doc.getText());
      }
    })
  );

  // Watch saves
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
      if (doc.uri.scheme !== 'file') return;

      const filePath = doc.fileName;
      // Skip cc-habits and Claude files to prevent infinite loops
      if (filePath.includes('.cc-habits') || filePath.includes('.claude')) return;

      const now = Date.now();
      const last = lastCaptured.get(filePath) ?? 0;
      if (now - last < 30000) return; // 30-second debounce per file

      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (folder) {
        const ignorePath = path.join(folder.uri.fsPath, '.cc-habits-ignore');
        if (fs.existsSync(ignorePath)) return;
      }

      const prev = snapshots.get(doc.uri.toString()) ?? '';
      const curr = doc.getText();
      if (prev === curr) return;

      const diff = buildUnifiedDiff(prev, curr, filePath);
      if (!diff.trim()) return;

      const result = await runCli([
        'capture',
        '--file', filePath,
        '--diff', diff,
        '--source', 'vscode'
      ]);

      if (result.ok) {
        lastCaptured.set(filePath, now);
        snapshots.set(doc.uri.toString(), curr); // update snapshot
      }
    })
  );

  // Snapshot active documents on startup
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'file') {
      snapshots.set(doc.uri.toString(), doc.getText());
    }
  }
}
