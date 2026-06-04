import { execFileSync } from 'child_process';
import { FAQ_DATABASE, type FAQEntry } from './faq-db';
import { VERSION, promptYesNo } from './cli';
import { runInteractiveMenu } from './menu';

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function scoreEntry(entry: FAQEntry, queryTokens: string[]): number {
  const targets = [
    ...entry.keywords,
    ...entry.question.toLowerCase().split(/\s+/),
    entry.category.toLowerCase()
  ];
  let score = 0;
  for (const qt of queryTokens) {
    for (const t of targets) {
      if (t === qt) { score += 1; break; }
      if (levenshtein(qt, t) === 1) { score += 0.5; break; }
    }
  }
  return score;
}

const CONFIDENCE_THRESHOLD = 2;

export function searchFaq(query: string, db: FAQEntry[] = FAQ_DATABASE): { high: FAQEntry[], low: FAQEntry[] } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = db
    .map(e => ({ entry: e, score: scoreEntry(e, tokens) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const high = scored.filter(r => r.score >= CONFIDENCE_THRESHOLD).map(r => r.entry);
  const low  = scored.filter(r => r.score < CONFIDENCE_THRESHOLD).map(r => r.entry);
  return { high, low };
}

const REPO_URL = 'https://github.com/Shreyan1/cc-habits';

export function openBrowser(url: string): void {
  if (!url.startsWith(REPO_URL + '/')) throw new Error('URL assertion failed');
  const platform = process.platform;
  if (platform === 'darwin') {
    execFileSync('open', [url]);
  } else if (platform === 'win32') {
    // cmd.exe re-parses its arguments even when invoked via execFileSync, so a
    // bare `&` in the query string terminates the `start` command and the rest
    // of the URL (`&body=...`) is run as a separate shell command. Escape every
    // `&` as `^&` so cmd treats it literally.
    execFileSync('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
  } else {
    execFileSync('xdg-open', [url]);
  }
}

export function buildIssueUrl(query: string): string {
  const body = [
    `**Query:** ${query}`,
    `**cc-habits version:** ${VERSION}`,
    `**Node.js:** ${process.version}`,
    `**OS:** ${process.platform}`,
    '',
    '_Describe what you expected and what happened:_',
  ].join('\n');
  const base = `${REPO_URL}/issues/new`;
  return `${base}?title=${encodeURIComponent(`FAQ Search: ${query}`)}&body=${encodeURIComponent(body)}`;
}

export function entriesInCategory(category: string, db: FAQEntry[] = FAQ_DATABASE): FAQEntry[] {
  return db.filter(e => e.category === category);
}

function printEntry(entry: FAQEntry): void {
  process.stdout.write(`\n  Q: ${entry.question}\n`);
  process.stdout.write(`  A: ${entry.answer.replace(/\n/g, '\n     ')}\n\n`);
}

export async function runCategoryMenu(db: FAQEntry[] = FAQ_DATABASE): Promise<string | null> {
  const categories = [...new Set(db.map(e => e.category))];
  // `args` is unused on this path: runCategoryMenu maps the selection back to a
  // category by reference and never spawns a subprocess, unlike the main menu.
  const items = categories.map(cat => ({
    label: cat,
    args: [] as string[],
    hint: `Browse ${cat} questions`
  }));
  const selected = await runInteractiveMenu(items);
  return selected ? categories[items.indexOf(selected)] ?? null : null;
}

// No-query path: let the user pick a category, then print every Q&A in it.
// We deliberately do NOT route the category name back through searchFaq, since
// a multi-word category (e.g. "Ollama / Local LLM") rarely scores above the
// confidence threshold and would be misreported as a near-miss.
async function browseCategories(): Promise<number> {
  // The arrow-key menu needs an interactive terminal. In a non-TTY context
  // (piped, CI) fall back to printing the whole FAQ so the command is still
  // useful instead of rendering an undrivable menu. Mirrors the top-level menu
  // guard in index.ts.
  if (!process.stdin.isTTY) {
    for (const entry of FAQ_DATABASE) printEntry(entry);
    return 0;
  }
  const category = await runCategoryMenu();
  if (!category) return 0;
  const entries = entriesInCategory(category);
  if (entries.length === 0) {
    process.stdout.write('  No entries in this category.\n\n');
    return 0;
  }
  for (const entry of entries) printEntry(entry);
  return 0;
}

export async function cmdFaq(query?: string): Promise<number> {
  if (!query || !query.trim()) return browseCategories();

  const { high, low } = searchFaq(query);

  if (high.length > 0) {
    for (const entry of high) printEntry(entry);
    const solved = await promptYesNo('  Did this solve your issue? [y/n] ');
    if (solved) return 0;
  } else if (low.length > 0) {
    process.stdout.write('  Closest matches:\n');
    for (const entry of low) process.stdout.write(`  • ${entry.question}\n`);
    process.stdout.write('\n');
  } else {
    process.stdout.write('  No matches found.\n\n');
  }

  const raise = await promptYesNo('  Open a pre-filled GitHub issue? [y/n] ');
  if (raise) openBrowser(buildIssueUrl(query));
  return 0;
}
