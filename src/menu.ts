import readline from 'readline';

// Self-contained arrow-key menu for `cch help`. No external dependencies: it
// uses Node's readline keypress events in raw mode. Pure helpers (nextIndex,
// renderMenu) are split out so they can be unit-tested without a TTY.

export interface MenuItem {
  label: string;   // shown in the menu
  args: string[];  // argv passed to cc-habits when selected
  hint: string;    // short description
  disabled?: boolean;
}

export const MENU_ITEMS: MenuItem[] = [
  { label: 'tools',          args: ['tools'],     hint: 'List supported coding tools' },
  { label: 'learn',          args: ['learn'],     hint: 'Learn habits from repository scan or signals' },
  { label: 'view',           args: ['view'],      hint: 'Show current habits or coding memories' },
  { label: 'pending',        args: ['pending'],   hint: 'Review queued habit suggestions' },
  { label: 'bootstrap',      args: ['bootstrap'], hint: 'Learn habits from past sessions' },
  { label: 'memories',       args: ['memories'],  hint: 'Show coding memories' },
  { label: 'sync',           args: ['sync'],      hint: 'Share habits with your other tools' },
  { label: 'log',            args: ['log'],       hint: 'Show the capture log' },
  { label: 'diff',           args: ['diff'],      hint: 'Show changes between the last two writes' },
  { label: 'init',           args: ['init'],      hint: 'Install hooks and set up a provider' },
  { label: 'on',             args: ['on'],        hint: 'Enable cc-habits' },
  { label: 'off',            args: ['off'],       hint: 'Disable cc-habits' },
  { label: 'faq',            args: ['faq'],       hint: 'Search the FAQ or raise a GitHub issue' },
  { label: 'help (all commands)', args: ['--help'],  hint: 'Print the full command reference' },
];

// Wrap-around index movement for up/down keys. Pure for testability.
export function nextIndex(
  current: number,
  key: 'up' | 'down',
  itemsOrLen: number | { disabled?: boolean }[],
): number {
  if (typeof itemsOrLen === 'number') {
    const len = itemsOrLen;
    if (len <= 0) return 0;
    return key === 'up' ? (current - 1 + len) % len : (current + 1) % len;
  }
  const len = itemsOrLen.length;
  if (len <= 0) return 0;
  let idx = current;
  for (let i = 0; i < len; i++) {
    idx = key === 'up' ? (idx - 1 + len) % len : (idx + 1) % len;
    if (!itemsOrLen[idx]?.disabled) {
      return idx;
    }
  }
  return current;
}

// Render the menu as a plain string (no cursor control) so tests can assert it.
export function renderMenu(items: MenuItem[], selected: number): string {
  const width = Math.max(...items.map(it => it.label.length));
  const lines = items.map((item, i) => {
    const pointer = i === selected ? '❯' : ' ';
    // Pad the raw label first, then colorize, so ANSI codes do not skew width.
    const padded = item.label.padEnd(width);
    let label = padded;
    let hint = item.hint;
    if (item.disabled) {
      label = `\x1b[2m${padded}\x1b[0m`;
      hint = `\x1b[2m${item.hint}\x1b[0m`;
    } else if (i === selected) {
      label = `\x1b[36m${padded}\x1b[0m`;
    }
    return `  ${pointer} ${label}  ${hint}`;
  });
  return lines.join('\n');
}

// Drives the interactive menu. Resolves with the chosen MenuItem, or null if the
// user cancels (q, Esc, Ctrl-C). Caller must ensure stdin/stdout are TTYs.
export function runInteractiveMenu(items: MenuItem[] = MENU_ITEMS): Promise<MenuItem | null> {
  return new Promise(resolve => {
    let selected = 0;
    while (selected < items.length && items[selected]?.disabled) {
      selected++;
    }
    if (selected >= items.length) selected = 0;

    const out = process.stderr;

    out.write('\n  cc-habits, use ↑/↓ to choose, Enter to run, q to quit\n\n');
    out.write(renderMenu(items, selected) + '\n');

    const redraw = (): void => {
      // Move cursor up over the rendered rows and clear to end, then reprint.
      readline.moveCursor(out, 0, -items.length);
      readline.cursorTo(out, 0);
      readline.clearScreenDown(out);
      out.write(renderMenu(items, selected) + '\n');
    };

    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw === true;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'down') {
        selected = nextIndex(selected, key.name, items);
        redraw();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (items[selected]?.disabled) return;
        cleanup();
        resolve(items[selected] ?? null);
        return;
      }
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        out.write('\n');
        resolve(null);
        return;
      }
    };

    stdin.on('keypress', onKey);
  });
}

export function runSelectMenu(
  title: string,
  items: { label: string; value: string; disabled?: boolean }[],
): Promise<{ label: string; value: string; disabled?: boolean } | null> {
  return new Promise(resolve => {
    let selected = 0;
    while (selected < items.length && items[selected]?.disabled) {
      selected++;
    }
    if (selected >= items.length) selected = 0;

    const out = process.stderr;

    out.write('\n' + title + '\n');

    const render = (): string => {
      const width = Math.max(...items.map(it => it.label.length));
      const lines = items.map((item, i) => {
        const pointer = i === selected ? '❯' : ' ';
        const padded = item.label.padEnd(width);
        let label = padded;
        if (item.disabled) {
          label = `\x1b[2m${padded}\x1b[0m`;
        } else if (i === selected) {
          label = `\x1b[36m${padded}\x1b[0m`;
        }
        return `  ${pointer} ${label}`;
      });
      return lines.join('\n');
    };

    out.write(render() + '\n');

    const redraw = (): void => {
      readline.moveCursor(out, 0, -items.length);
      readline.cursorTo(out, 0);
      readline.clearScreenDown(out);
      out.write(render() + '\n');
    };

    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw === true;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'down') {
        selected = nextIndex(selected, key.name, items.map(it => ({ disabled: it.disabled })));
        redraw();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (items[selected]?.disabled) return;
        cleanup();
        resolve(items[selected] ?? null);
        return;
      }
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        out.write('\n');
        resolve(null);
        return;
      }
    };

    stdin.on('keypress', onKey);
  });
}

