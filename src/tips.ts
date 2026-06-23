/**
 * Tips shown during the genuine LLM wait while cc-habits learns. They fill real
 * dead time (the provider round-trip), never padded time, and are purely
 * educational: how to use each command better, with a dry aside. Kept here so the
 * copy is easy to edit and unit-test in isolation from the rendering loop.
 */

// Dry, light, one line each. Useful first, the joke second. No em-dashes.
export const TIPS: readonly string[] = [
  // Setup
  'cch init wires hooks into every editor it finds. Set it once, forget it (cch will not).',
  'No API key? cch init --provider ollama runs fully local. Free as in beer and privacy.',
  'cch tools shows which editors cch already speaks to. Fluent in 6+, eavesdropping politely.',
  'Add cch shell-init to your shell to see last session habits before launching claude.',
  'Moved your storage? cch migrate brings the habits along. They are attached to you, not the folder.',
  'cch uninstall removes everything cleanly. No leftover files, no hard feelings.',
  // Learning
  'New here? cch bootstrap mines your past Claude sessions. Instant deja vu, zero waiting.',
  'Habits graduate only after 2 sessions. cch does not believe in one-night patterns.',
  'cch learn --repo reads your code and CLAUDE.md to seed habits without waiting for sessions.',
  'No hooks set up? cch git-capture learns from commits. Turns out your git log was a diary.',
  'cch off pauses learning without uninstalling. For when you write code you are not proud of.',
  // Seeing what it knows
  'cch view shows what cch thinks of your style. Brace yourself.',
  'cch view prefs opens the exact file your agents read. The single source of truth.',
  'Surprised by a habit? cch explain "<rule>" shows the edits that taught it. Receipts.',
  'cch diff shows what changed between the last two learns. Version control for your habits.',
  'cch log lists everything captured and sent. Nothing leaves without a receipt.',
  'cch lint <file> checks a file against your habits before the agent does. Pre-emptive nagging.',
  // Sharing and memory
  'cch sync copies habits into AGENTS.md, Cursor, Cline. One brain, every editor.',
  'cch export bundles your taste into a file. New laptop? cch import and you are you again.',
  'Turn on cch memories to capture the corrections you keep making. It learns so you stop repeating.',
  'Deleted a habit? cch tombstone keeps it gone for good. cch holds the grudge so you do not have to.',
  'Stuck? cch faq "<question>" searches answers, or opens a GitHub issue if you are truly cursed.',
  // Brand facts
  'cch never phones home. The only thing that leaves is a redacted diff to your chosen LLM.',
  'cch redacts emails, cards, and keys before anything is sent. Paranoid so you do not have to be.',
];

// Markers rotate alongside tips for a little variety in the dead-time line.
export const TIP_MARKERS: readonly string[] = ['psst', 'tip', 'fyi', 'btw'];

/**
 * Fisher-Yates shuffle returning a new array, so a single run cycles through
 * tips without repeats. Pure: never mutates TIPS, never touches global RNG state
 * beyond Math.random.
 */
export function shuffledTips(source: readonly string[] = TIPS): string[] {
  const out = source.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
