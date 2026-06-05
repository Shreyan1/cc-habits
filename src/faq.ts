import { execFileSync } from 'child_process';
import { FAQ_DATABASE, type FAQEntry } from './faq-db';
import { VERSION, promptYesNo, c, BOLD, DIM, CYAN, YELLOW } from './cli';
import { runInteractiveMenu, runSelectMenu } from './menu';
import readline from 'readline';

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

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren\'t', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'can\'t', 'cannot', 'could', 'couldn\'t',
  'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down', 'during',
  'each', 'feel',
  'few', 'for', 'from', 'further',
  'had', 'hadn\'t', 'has', 'hasn\'t', 'have', 'haven\'t', 'having', 'he', 'he\'d', 'he\'ll', 'he\'s', 'her', 'here', 'here\'s', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'how\'s',
  'i', 'i\'d', 'i\'ll', 'i\'m', 'i\'ve', 'if', 'in', 'into', 'is', 'isn\'t', 'it', 'it\'s', 'its', 'itself',
  'let\'s',
  'me', 'more', 'most', 'mustn\'t', 'my', 'myself',
  'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'shan\'t', 'she', 'she\'d', 'she\'ll', 'she\'s', 'should', 'shouldn\'t', 'so', 'some', 'such',
  'than', 'that', 'that\'s', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'there\'s', 'these', 'they', 'they\'d', 'they\'ll', 'they\'re', 'they\'ve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very',
  'was', 'wasn\'t', 'we', 'we\'d', 'we\'ll', 'we\'re', 'we\'ve', 'were', 'weren\'t', 'what', 'what\'s', 'when', 'when\'s', 'where', 'where\'s', 'which', 'while', 'who', 'who\'s', 'whom', 'why', 'why\'s', 'with', 'won\'t', 'would', 'wouldn\'t',
  'you', 'you\'d', 'you\'ll', 'you\'re', 'you\'ve', 'your', 'yours', 'yourself', 'yourselves'
]);

export function searchFaq(query: string, db: FAQEntry[] = FAQ_DATABASE): { high: FAQEntry[], low: FAQEntry[] } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const nonStopTokens = tokens.filter(t => !STOP_WORDS.has(t));
  const queryTokens = nonStopTokens.length > 0 ? nonStopTokens : tokens;

  const scored = db
    .map(e => ({ entry: e, score: scoreEntry(e, queryTokens) }))
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
    // codeql[js/indirect-command-line-injection] - url is validated to start with
    // REPO_URL+'/' on line 76 above, so it can only ever be a github.com URL.
    // All user-supplied content (query, body) is encodeURIComponent'd by buildIssueUrl
    // before reaching here, so shell-dangerous characters arrive percent-encoded.
    // The &→^& substitution handles the only cmd.exe metacharacter that survives
    // URL encoding because `%26` decodes back to `&` in the browser but the `^`
    // prefix keeps cmd.exe from interpreting it as a command separator.
    execFileSync('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
  } else {
    execFileSync('xdg-open', [url]); // codeql[js/indirect-command-line-injection] - url is validated to start with REPO_URL+'/' above; user input is encodeURIComponent'd by buildIssueUrl
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
  process.stdout.write(`\n  ${c(BOLD + CYAN, `Q: ${entry.question}`)}\n`);
  process.stdout.write(`  ${c(BOLD, 'A:')} ${entry.answer.replace(/\n/g, '\n     ')}\n\n`);
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

function askQuery(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function cmdFaq(query?: string): Promise<number> {
  if (!query || !query.trim()) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const q = await askQuery(
        `\n  ${c(BOLD + CYAN, 'What\'s your query?')} ${c(DIM, '(Type to search FAQ, or press Enter to browse categories):')} `,
      );
      if (q.trim()) {
        return cmdFaq(q);
      }
    }
    return browseCategories();
  }

  const { high, low } = searchFaq(query);

  let solved = false;
  if (high.length > 0) {
    for (const entry of high) printEntry(entry);
    solved = await promptYesNo('  Did this solve your issue? [y/n] ');
    if (solved) return 0;
  } else if (low.length > 0) {
    process.stdout.write(`\n  ${c(YELLOW, 'I don\'t have a direct answer for your query right now.')}\n`);
    process.stdout.write('  Here are the closest matches:\n\n');

    const menuItems = low.slice(0, 5).map(entry => ({
      label: entry.question,
      value: entry.id
    }));
    menuItems.push({ label: 'None of these / Search again', value: 'none' });

    const selected = await runSelectMenu(
      `  ${c(BOLD + CYAN, 'Select a question to view its answer (use ↑/↓ keys):')}`,
      menuItems
    );

    if (selected && selected.value !== 'none') {
      const chosenEntry = low.find(e => e.id === selected.value);
      if (chosenEntry) {
        printEntry(chosenEntry);
        solved = await promptYesNo('  Did this solve your issue? [y/n] ');
        if (solved) return 0;
      }
    }
  } else {
    process.stdout.write(`\n  ${c(YELLOW, 'I don\'t have a direct answer for your query right now.')}\n\n`);
  }

  if (!solved) {
    const retry = await promptYesNo('  Would you like to try searching with a different query? [y/n] ');
    if (retry) {
      const newQuery = await askQuery(
        `  ${c(BOLD + CYAN, 'Enter new query:')} `
      );
      if (newQuery.trim()) {
        return cmdFaq(newQuery);
      }
    }
  }

  const raise = await promptYesNo('  Open a pre-filled GitHub issue? [y/n] ');
  if (raise) {
    const url = buildIssueUrl(query);
    process.stdout.write(`\n  Opening browser... If it does not open, you can manually create the issue here:\n  ${c(CYAN, url)}\n\n`);
    openBrowser(url);
  }
  return 0;
}
