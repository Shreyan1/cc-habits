import os from 'os';
import { type Memory, getRuleHash } from './storage';
import { shuffledTips, TIP_MARKERS } from './tips';

export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[38;2;150;210;30m';  // Softer Acid Lime (#96D21E)
export const YELLOW = '\x1b[38;2;140;90;215m';  // Softer Purple/Learning (#8C5AD7)
export const RED = '\x1b[38;2;215;60;105m';  // Softer Neon Pink/Negatives (#D73C69)
export const CYAN = '\x1b[38;2;20;160;220m';   // Softer Accent Cyan (#14A0DC)
export const ACID_LIME = '\x1b[38;2;176;255;26m'; // Vivid Acid Lime (#B0FF1A), loading bar only
export const RESET = '\x1b[0m';

export const NO_COLOR = !process.stdout.isTTY || !!process.env['NO_COLOR'];

export function c(code: string, text: string): string {
  return NO_COLOR ? text : `${code}${text}${RESET}`;
}

// Collapse the user's home directory to ~ for readable, copy-pasteable proof
// paths. Returns the path unchanged when it is not under the home directory.
export function tildePath(p: string): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const normalizedP = p.toLowerCase().replace(/\\/g, '/');
    const normalizedHome = home.toLowerCase().replace(/\\/g, '/');
    if (normalizedP === normalizedHome || normalizedP.startsWith(normalizedHome + '/')) {
      return '~' + p.slice(home.length);
    }
  } else if (p === home || p.startsWith(home + '/')) {
    return '~' + p.slice(home.length);
  }
  return p;
}

// Strip terminal control characters (ESC, BEL, CSI sequences, C0/C1 controls) from
// untrusted content before display.
// eslint-disable-next-line no-control-regex
const TERM_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
export function term(s: string): string {
  return (s ?? '').replace(TERM_CONTROL, '');
}

export function confidenceBar(conf: number, width = 22): string {
  const filled = Math.round(conf * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color = conf >= 0.70 ? GREEN : conf >= 0.50 ? YELLOW : RED;
  return c(color, bar);
}

const ICON_GRID: string[] = [
  '...........................',
  '...........GGGGGG..........',
  '..........GGGGGGGG.........',
  '..........GG....GG.........',
  '..........GG....GG.........',
  '...GGGGGGGGGGGGGGGGGGGGGG..',
  '..GGGGGGGGGGGGGGGGGGGGGGGG.',
  '.GGG....................GGG',
  '.GG....GG................GG',
  '.GG......GG..............GG',
  '.GG........GG............GG',
  '.GG......GG....BBBBBB....GG',
  '.GG....GG......BBBBBB....GG',
  '.GG......................GG',
  '.GG......................GG',
  '.GG......G........G......GG',
  '.GG......G........G......GG',
  '.GG......GGGGGGGGGG......GG',
  '.GGG....................GGG',
  '..GGGGGGGGGGGGGGGGGGGGGGGG.',
  '...GGGGGGGGGGGGGGGGGGGGGG..',
];

export function buildIconLines(): string[] {
  const colourOf = (ch: string): string => (ch === 'B' ? CYAN : GREEN);
  const lines: string[] = [];
  for (let r = 0; r < ICON_GRID.length; r += 2) {
    const top = ICON_GRID[r]!;
    const bot = ICON_GRID[r + 1] ?? '';
    let out = '';
    for (let col = 0; col < top.length; col++) {
      const t = top[col] !== '.' ? top[col]! : '';
      const b = bot[col] && bot[col] !== '.' ? bot[col]! : '';
      if (!t && !b) { out += ' '; continue; }
      if (t && b) {
        out += colourOf(t) === colourOf(b)
          ? c(colourOf(t), '█')
          : (NO_COLOR ? '█' : `${colourOf(t)}\x1b[48;2;20;160;220m▀${RESET}`);
      } else if (t) {
        out += c(colourOf(t), '▀');
      } else {
        out += c(colourOf(b), '▄');
      }
    }
    lines.push(out.replace(/\s+$/, ''));
  }
  return lines;
}

// Visible width of a pre-coloured string, ignoring ANSI escape sequences.
// eslint-disable-next-line no-control-regex
const visLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

export function renderBrandedCard(subtitle: string, statusText: string): void {
  const INNER = 44;
  const MARGIN = 2;
  const borderChar = c(DIM + CYAN, '│');
  const topBorder = c(DIM + CYAN, `┌${'─'.repeat(INNER)}┐`);
  const bottomBorder = c(DIM + CYAN, `└${'─'.repeat(INNER)}┘`);

  // Wrap one line of inner content in box borders, right-padding to INNER.
  const row = (content: string): string => {
    const pad = Math.max(0, INNER - visLen(content));
    return ' '.repeat(MARGIN) + borderChar + content + ' '.repeat(pad) + borderChar;
  };

  // Centre a pre-coloured text string within INNER columns.
  const centreText = (text: string): string => {
    const left = Math.floor((INNER - visLen(text)) / 2);
    return ' '.repeat(Math.max(0, left)) + text;
  };

  // Icon lines get a fixed left offset so the grid's internal positioning is
  // preserved. iconLeft centres the 27-wide grid within INNER.
  const ICON_WIDTH = 27;
  const iconLeft = Math.floor((INNER - ICON_WIDTH) / 2);

  // Clamp dynamic fields so long model names never overflow the box.
  const sub = subtitle.slice(0, INNER - 'cc-habits · '.length);
  const stat = statusText.slice(0, INNER);

  const title = c(BOLD + CYAN, 'cc-habits') + c(DIM, ' · ') + c(BOLD, sub);
  const tagline = c(DIM, 'One layer to rule them all');
  const status = c(DIM, stat);

  const blank = row('');
  process.stdout.write('\n');
  process.stdout.write(' '.repeat(MARGIN) + topBorder + '\n');
  process.stdout.write(blank + '\n');
  for (const line of buildIconLines()) process.stdout.write(row(' '.repeat(iconLeft) + line) + '\n');
  process.stdout.write(blank + '\n');
  process.stdout.write(row(centreText(title)) + '\n');
  process.stdout.write(row(centreText(tagline)) + '\n');
  process.stdout.write(row(centreText(status)) + '\n');
  process.stdout.write(' '.repeat(MARGIN) + bottomBorder + '\n');
  process.stdout.write('\n');
}

// Normalise a raw languages list into clean, deduped, lower-cased tokens. The
// source is signal-derived (untrusted), so strip control chars, drop blanks, and
// cap token length. Exported so views and tests share one definition.
export function normaliseLanguages(languages?: string[]): string[] {
  if (!languages || languages.length === 0) return [];
  return Array.from(new Set(
    languages
      .map(l => term(String(l)).trim().toLowerCase())
      .filter(Boolean)
      .map(l => l.slice(0, 12)),
  ));
}

// Compact dim language tag for a habit line, e.g. "  · ts, py". Empty string when
// there are no languages. Caps the visible list so a noisy signal cannot blow up
// the line; surplus shows as "+N".
export function langTag(languages?: string[]): string {
  const clean = normaliseLanguages(languages);
  if (clean.length === 0) return '';
  const shown = clean.slice(0, 4);
  const extra = clean.length - shown.length;
  return c(DIM, `  · ${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}`);
}

// One compact line per habit: confidence %, a short bar, the rule, then dim meta
// (sessions, languages, a downvote count only when it is non-zero) and the id. The
// previous three-line form scattered each habit; this packs the same signal into a
// single scannable row. Colour follows confidence, matching the bar thresholds.
export function renderHabitLine(
  h: { rule: string; confidence: number; reinforcing: number; contradicting: number; sessions_seen: number; first_learned?: string; languages?: string[] },
  isLearning: boolean
): void {
  const conf = h.confidence;
  const pct = `${Math.round(conf * 100)}%`.padStart(4);
  const pctColor = conf >= 0.70 ? GREEN : conf >= 0.50 ? YELLOW : RED;
  const bar = confidenceBar(conf, 10);
  const dn = (h.contradicting ?? 0) > 0 ? c(RED, ` ↓${h.contradicting}`) : '';
  const tag = isLearning ? c(YELLOW, ' (learning)') : '';
  const hash = getRuleHash(h.rule);
  const meta = c(DIM, ` · ${h.sessions_seen ?? 1} ses`) + langTag(h.languages);
  process.stdout.write(
    `  ${c(BOLD + pctColor, pct)} ${bar} ${term(h.rule)}${tag}${dn}${meta} ${c(DIM, `[${hash}]`)}\n`,
  );
}

export function printMemoriesEmptyState(enabled: boolean): void {
  if (enabled) {
    process.stdout.write(c(DIM, '  No memories recorded yet, memory learning is ON.\n'));
    process.stdout.write(c(DIM, '  They appear after sessions where you correct the agent. Keep coding.\n'));
  } else {
    process.stdout.write(c(DIM, '  No memories recorded yet, and memory learning is OFF.\n'));
    process.stdout.write(c(DIM, '  Enable it persistently:  cch memories --enable\n'));
    process.stdout.write(c(DIM, '  Or for one shell only:    export CC_HABITS_MEMORIES=1\n'));
  }
  process.stdout.write('\n');
}

// One compact line per memory: confidence %, the memory text, and (when present)
// the correction as a cyan "→ do this instead", then the id for `--delete`. The
// trigger terms and seen/last metadata are internal matching detail, so they are
// dropped from the line to keep it scannable; the full record stays in memories.md.
export function renderMemoryLine(memory: Memory, isCandidate: boolean): void {
  const conf = memory.confidence;
  const pct = `${Math.round(conf * 100)}%`.padStart(4);
  const pctColor = conf >= 0.70 ? GREEN : conf >= 0.50 ? YELLOW : RED;
  const tag = isCandidate ? c(YELLOW, ' (candidate)') : '';
  const hash = getRuleHash(memory.text);
  const corr = memory.correction ? '  ' + c(CYAN, `→ ${term(memory.correction)}`) : '';
  process.stdout.write(
    `  ${c(BOLD + pctColor, pct)} ${term(memory.text)}${tag}${corr} ${c(DIM, `[${hash}]`)}\n`,
  );
}

export function promptChoice(question: string, min: number, max: number): Promise<number | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise(resolve => {
    let colored = question;
    const m = question.match(/^(\s*)(.*?)(\s*\[\d+-\d+\]:?\s*)$/);
    if (m) {
      colored = m[1] + c(BOLD + CYAN, m[2]) + c(DIM, m[3]);
    }
    process.stdout.write(colored);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (ch: string): void => {
      if (ch === '\x03') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(0);
      }
      const n = parseInt(ch, 10);
      if (!isNaN(n) && n >= min && n <= max) {
        process.stdout.write(ch + '\n');
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(n);
      }
    };

    process.stdin.on('data', onData);
  });
}

export function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise(resolve => {
    let colored = question;
    const m = question.match(/^(\s*)(.*?\?)(\s*\[[yY]\/[nN]\]\s*)$/);
    if (m) {
      colored = m[1] + c(BOLD + CYAN, m[2]) + c(DIM, m[3]);
    }
    process.stdout.write(colored);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const done = (val: boolean, display: string): void => {
      process.stdout.write(display + '\n');
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(val);
    };

    const onData = (ch: string): void => {
      if (ch === '\x03') { done(false, ''); process.exit(0); }
      if (ch.toLowerCase() === 'y') done(true, 'y');
      else if (ch.toLowerCase() === 'n' || ch === '\r' || ch === '\n') done(false, 'n');
    };

    process.stdin.on('data', onData);
  });
}

export function promptYesNoDefaultTrue(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  return new Promise(resolve => {
    let colored = question;
    const m = question.match(/^(\s*)(.*?\?)(\s*\[[yY]\/[nN]\]\s*)$/);
    if (m) {
      colored = m[1] + c(BOLD + CYAN, m[2]) + c(DIM, m[3]);
    }
    process.stdout.write(colored);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const done = (val: boolean, display: string): void => {
      process.stdout.write(display + '\n');
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      resolve(val);
    };

    const onData = (ch: string): void => {
      if (ch === '\x03') { done(false, ''); process.exit(0); }
      if (ch.toLowerCase() === 'y' || ch === '\r' || ch === '\n') done(true, 'y');
      else if (ch.toLowerCase() === 'n') done(false, 'n');
    };

    process.stdin.on('data', onData);
  });
}

export function promptSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    let key = '';
    let colored = question;
    const m = question.match(/^(\s*)(.*?)(\s*\(hidden\):?\s*)$/);
    if (m) {
      colored = m[1] + c(BOLD + CYAN, m[2]) + c(DIM, m[3]);
    }
    process.stdout.write(colored);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (ch: string): void => {
      if (ch === '\n' || ch === '\r') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(key.trim());
      } else if (ch === '\x03') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '\x7f' || ch === '\b') {
        key = key.slice(0, -1);
      } else {
        key += ch;
      }
    };

    process.stdin.on('data', onData);
  });
}

// Learning-purple alias: the loading glyph is the same colour as the (learning)
// tag the user sees on candidate habits seconds later, so the loading state and
// the result speak one visual language.
export const LEARN = YELLOW;

// Motion encodes meaning: `distill` shows scattered signals converging into one
// habit (depth); `sweep` shows a bar travelling across a repo (breadth). Both are
// fixed-width so the label never jitters between frames.
const DISTILL_FRAMES = ['·     ·', ' ·   · ', '  · ·  ', '   ◆   ', '   ◇   ', '   ◆   '];
const SWEEP_FRAMES = ['[▰▱▱▱▱]', '[▱▰▱▱▱]', '[▱▱▰▱▱]', '[▱▱▱▰▱]', '[▱▱▱▱▰]'];

export type StepMotion = 'distill' | 'sweep';
export interface StepHandle {
  /** Mark a real, completed step. Prints a ✓ line instantly (no animation). */
  done(label: string): void;
  /** Animate a genuinely long step (an LLM round-trip) until `task` settles. */
  spin<T>(label: string, task: () => Promise<T>, opts?: { motion?: StepMotion; color?: string; items?: string[] }): Promise<T>;
}

/**
 * A small driver for the live "what cc-habits is doing right now" trace. Every
 * line corresponds to a real boundary in the work (no timers faking progress):
 * `done()` prints an instant ✓ line, `spin()` animates only while the awaited
 * task runs and finalises to a ✓ line. During a spin, a dim shuffled tip rotates
 * below the step to fill the real provider wait with something useful.
 *
 * Modes: `animate` (interactive TTY, full glyph + tips), `static` (piped/CI:
 * one plain line per step, no escape codes, no tips), `silent` (no output, just
 * runs the tasks). Defaults to animate on a TTY, static otherwise.
 */
export function steppedProgress(opts: { mode?: 'animate' | 'static' | 'silent' } = {}): StepHandle {
  const mode = opts.mode ?? (process.stdout.isTTY ? 'animate' : 'static');
  return {
    done(label: string): void {
      if (mode === 'silent') return;
      if (mode === 'static') { process.stdout.write(`  ${label}\n`); return; }
      process.stdout.write(`  ${c(GREEN, '✓')} ${c(DIM, label)}\n`);
    },
    spin<T>(label: string, task: () => Promise<T>, sopts: { motion?: StepMotion; color?: string; items?: string[] } = {}): Promise<T> {
      if (mode === 'silent') return task();
      if (mode === 'static') { process.stdout.write(`  ${label}...\n`); return task(); }
      return animateSpin(label, task, sopts);
    },
  };
}

// The animated two-line region (step line + rotating tip line) used by spin() in
// `animate` mode. Cursor handling keeps the region exactly two lines: a thrown
// error clears both and restores the cursor; success leaves a single ✓ line.
async function animateSpin<T>(
  label: string,
  task: () => Promise<T>,
  sopts: { motion?: StepMotion; color?: string; items?: string[] },
): Promise<T> {
  const frames = sopts.motion === 'sweep' ? SWEEP_FRAMES : DISTILL_FRAMES;
  const color = sopts.color ?? (sopts.motion === 'sweep' ? ACID_LIME : LEARN);
  // When `items` are supplied (e.g. the files in a repo scan), the secondary line
  // reveals them one at a time, each disappearing as the next appears, so the user
  // sees exactly what is in the batch the provider is working on. Otherwise it
  // rotates educational tips. Both fill the same genuine provider wait.
  const items = sopts.items && sopts.items.length > 0 ? sopts.items : null;
  const tips = shuffledTips();
  let ti = 0, mi = 0, fi = 0;
  let started = false;

  const secondaryLine = (): string => {
    const max = Math.max(20, (process.stdout.columns ?? 80)) - 1;
    const raw = items
      ? `  · ${items[ti % items.length]}`
      : `  ${TIP_MARKERS[mi % TIP_MARKERS.length]!} · ${tips[ti % tips.length]}`;
    return c(DIM, raw.length > max ? raw.slice(0, max - 1) + '…' : raw);
  };
  const draw = (): void => {
    const step = `  ${c(color, frames[fi]!)} ${label}`;
    process.stdout.write(started ? `\r\x1b[1A\x1b[K${step}\n\r\x1b[K${secondaryLine()}` : `${step}\n${secondaryLine()}`);
    started = true;
  };
  const showCursor = (): void => { process.stdout.write('\x1b[?25h'); };
  const clearRegion = (): void => { process.stdout.write('\r\x1b[K\x1b[1A\r\x1b[K'); };
  const onSigint = (): void => { clearRegion(); showCursor(); process.exit(130); };

  process.stdout.write('\x1b[?25l'); // hide cursor while animating
  process.once('SIGINT', onSigint);
  draw();
  const spinTimer = setInterval((): void => { fi = (fi + 1) % frames.length; draw(); }, 80);
  // Files cycle fast enough that the whole batch streams past during a typical
  // provider wait (so a 34-file scan actually shows all 34 names, not just the
  // first few), with a readable floor and ceiling. Tips dwell longer so each one
  // stays readable.
  const itemInterval = items ? Math.max(140, Math.min(900, Math.round(3000 / items.length))) : 5000;
  const secondaryTimer = setInterval((): void => { ti++; mi++; draw(); }, itemInterval);
  const cleanup = (): void => {
    clearInterval(spinTimer);
    clearInterval(secondaryTimer);
    process.removeListener('SIGINT', onSigint);
  };

  try {
    const result = await task();
    cleanup();
    // Clear the tip line, rewrite the step line as a persistent ✓, leave the
    // cursor on a fresh (blank) line ready for the next step or the summary.
    process.stdout.write(`\r\x1b[K\x1b[1A\r\x1b[K  ${c(GREEN, '✓')} ${c(DIM, label)}\n`);
    showCursor();
    return result;
  } catch (e) {
    cleanup();
    clearRegion();
    showCursor();
    throw e;
  }
}

/**
 * Back-compat wrapper over steppedProgress().spin for single-step callers. Keeps
 * the original signature so existing call sites animate (distill motion) on a
 * TTY and print one static line when piped.
 */
export function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  return steppedProgress().spin(label, task);
}
