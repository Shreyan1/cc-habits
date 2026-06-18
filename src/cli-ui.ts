import os from 'os';
import { type Memory, getRuleHash } from './storage';

export const BOLD   = '\x1b[1m';
export const DIM    = '\x1b[2m';
export const GREEN  = '\x1b[38;2;150;210;30m';  // Softer Acid Lime (#96D21E)
export const YELLOW = '\x1b[38;2;140;90;215m';  // Softer Purple/Learning (#8C5AD7)
export const RED    = '\x1b[38;2;215;60;105m';  // Softer Neon Pink/Negatives (#D73C69)
export const CYAN   = '\x1b[38;2;20;160;220m';   // Softer Accent Cyan (#14A0DC)
export const RESET  = '\x1b[0m';

export const NO_COLOR = !process.stdout.isTTY || !!process.env['NO_COLOR'];

export function c(code: string, text: string): string {
  return NO_COLOR ? text : `${code}${text}${RESET}`;
}

// Collapse the user's home directory to ~ for readable, copy-pasteable proof
// paths. Returns the path unchanged when it is not under the home directory.
export function tildePath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
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
  const topBorder    = c(DIM + CYAN, `┌${'─'.repeat(INNER)}┐`);
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
  const sub  = subtitle.slice(0, INNER - 'cc-habits · '.length);
  const stat = statusText.slice(0, INNER);

  const title   = c(BOLD + CYAN, 'cc-habits') + c(DIM, ' · ') + c(BOLD, sub);
  const tagline = c(DIM, 'One tool-agnostic developer memory layer');
  const status  = c(DIM, stat);

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

export function renderHabitLine(
  h: { rule: string; confidence: number; reinforcing: number; contradicting: number; sessions_seen: number; first_learned?: string },
  isLearning: boolean
): void {
  const bar = confidenceBar(h.confidence);
  const pct = `${Math.round(h.confidence * 100)}%`;
  const up = h.reinforcing ?? 0;
  const dn = h.contradicting ?? 0;
  const tag = isLearning ? c(YELLOW, ' (learning)') : '';
  const hash = getRuleHash(h.rule);
  process.stdout.write(`\n  ${c(DIM, `[${hash}]`)} ${term(h.rule)}${tag}\n`);
  process.stdout.write(
    `  [${bar}] ${c(BOLD, pct)}  ` +
    c(GREEN, `↑${up}`) + '  ' +
    (dn ? c(RED, `↓${dn}`) : c(DIM, `↓${dn}`)) +
    c(DIM, `  · ${h.sessions_seen ?? 1} session${h.sessions_seen === 1 ? '' : 's'}  · since ${h.first_learned ?? '?'}`) + '\n',
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

export function renderMemoryLine(memory: Memory, isCandidate: boolean): void {
  const bar = confidenceBar(memory.confidence);
  const pct = `${Math.round(memory.confidence * 100)}%`;
  const tag = isCandidate ? c(YELLOW, ' (candidate)') : '';
  const hash = getRuleHash(memory.text);
  process.stdout.write(`\n  ${c(DIM, `[${hash}]`)} ${term(memory.text)}${tag}\n`);
  if (memory.trigger.length > 0) {
    process.stdout.write(c(DIM, `  trigger: ${term(memory.trigger.join(', '))}\n`));
  }
  if (memory.correction) {
    process.stdout.write(c(DIM, `  correction: ${term(memory.correction)}\n`));
  }
  process.stdout.write(
    `  [${bar}] ${c(BOLD, pct)}  ` +
    c(DIM, `seen ${memory.seen} · ${memory.sessions_seen} session${memory.sessions_seen === 1 ? '' : 's'} · last ${memory.last_seen ?? '?'}`) + '\n',
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

/**
 * Run an async task while showing an animated braille spinner. The spinner only
 * animates on an interactive TTY: on a pipe or in CI it prints a single static
 * line instead so captured logs stay clean. The interval is always cleared and
 * the line redrawn in a finally block, so a thrown error (e.g. a provider
 * failure) never leaves a dangling timer or a half-drawn spinner behind.
 */
export async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${label}...\n`);
    return task();
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const restore = (): void => { process.stdout.write('\r\x1b[K\x1b[?25h'); };
  // Ctrl-C kills the process without running finally, which would otherwise leave
  // the terminal cursor hidden. Restore it on SIGINT, then exit with the standard
  // 128+SIGINT code. Removed in finally on the normal/throw paths.
  const onSigint = (): void => { restore(); process.exit(130); };
  process.stdout.write('\x1b[?25l'); // hide cursor while spinning
  process.once('SIGINT', onSigint);
  const timer = setInterval((): void => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r  ${c(CYAN, frames[i]!)} ${label}`);
  }, 80);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', onSigint);
    restore();
  }
}
