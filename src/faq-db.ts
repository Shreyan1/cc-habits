export interface FAQEntry {
  id: string
  category: string
  question: string
  keywords: string[]
  answer: string
}

export const FAQ_DATABASE: FAQEntry[] = [

  // ── Getting Started ────────────────────────────────────────────────────────

  {
    id: 'stuck-or-confused',
    category: 'Getting Started',
    question: 'I am lost, what am I supposed to do here?',
    keywords: ['lost', 'help', 'broken', 'stuck', 'what', 'do', 'now', 'noob', 'beginner', 'clueless', 'confused', 'where'],
    answer: 'No worries! cc-habits is designed to run automatically in the background. Here is a simple 3-step start guide:\n1. Run `cch init` in your terminal to set up a provider.\n2. Keep coding normally using Claude Code (or another supported assistant).\n3. Run `cch view` later to see the habits cc-habits has observed and learned from your edits!'
  },
  {
    id: 'how-to-run-use',
    category: 'Getting Started',
    question: 'How do I run, execute, or use this tool?',
    keywords: ['how', 'use', 'run', 'start', 'work', 'play', 'execute', 'begin', 'open'],
    answer: 'You don\'t need to run it manually while coding! cc-habits works automatically via background hooks. Just code normally in Claude Code or other supported editors, and it will capture your edits. If you want to check your progress or view learned habits, run `cch view`.'
  },
  {
    id: 'is-it-working',
    category: 'Getting Started',
    question: 'Is this thing working or is it broken?',
    keywords: ['broken', 'working', 'test', 'check', 'status', 'active', 'dead', 'alive'],
    answer: 'You can check if cc-habits is active by running `cch`. You will see the status in the main menu (e.g. "Active" or "Disabled"). To see if it has captured your edits, run `cch log` to view the capture log.'
  },
  {
    id: 'what-is-cc-habits',
    category: 'Getting Started',
    question: 'What is cc-habits and what does it do?',
    keywords: ['what', 'purpose', 'overview', 'intro', 'about', 'explain', 'info', 'definition', 'details', 'concept', 'meaning'],
    answer: 'cc-habits is a tool-agnostic coding memory layer. It watches the edits Claude Code makes in your sessions, learns your personal coding style (e.g. "prefer ternary over if/else"), and injects those habits back into future sessions via CLAUDE.md. It runs entirely on your machine, never uploading your code. Use `cch --help` to see all commands.'
  },
  {
    id: 'install-and-setup',
    category: 'Getting Started',
    question: 'How do I install and set up cc-habits for the first time?',
    keywords: ['install', 'setup', 'start', 'begin', 'first', 'new', 'npm', 'initialize', 'init', 'configure', 'configuration', 'installing', 'setting'],
    answer: '1. Install globally: `npm install -g cc-habits`\n2. Run `cch init` inside your project directory. This installs Claude Code hooks, creates habits.md, and walks you through picking a provider (Anthropic, OpenAI, Groq, or Ollama).\n3. Start a Claude Code session, habits will be captured automatically.'
  },
  {
    id: 'what-is-cch-alias',
    category: 'Getting Started',
    question: 'What is "cch"? Is it different from "cc-habits"?',
    keywords: ['cch', 'alias', 'shorthand', 'command', 'name', 'short', 'abbreviation', 'call', 'difference'],
    answer: '`cch` is the short alias for `cc-habits`. They run the exact same binary. Use whichever you prefer, all examples in the docs work with either.'
  },
  {
    id: 'supported-tools',
    category: 'Getting Started',
    question: 'Which coding tools and editors does cc-habits support?',
    keywords: ['tools', 'supported', 'cursor', 'cline', 'gemini', 'codex', 'kimi', 'editor', 'ide', 'roocode', 'aider', 'windsurf', 'continue', 'jetbrains', 'copilot'],
    answer: 'Run `cch tools` to see every supported tool and which ones are detected in your current project. As of v0.5, supported tools include Claude Code, Cursor, Cline, Gemini CLI, Codex, Kimi, and Aider. Learning happens via hooks in each tool.'
  },
  {
    id: 'where-is-habits-file',
    category: 'Getting Started',
    question: 'Where are my habits stored?',
    keywords: ['habits', 'file', 'location', 'path', 'stored', 'where', 'habits.md', 'directory', 'folder', 'find', 'saved'],
    answer: 'By default, habits are stored in `~/.cc-habits/habits.md`. The full storage directory is `~/.cc-habits/`. You can override the location by setting the `CC_HABITS_DIR` environment variable. Use `cch view` to see your current habits.'
  },
  {
    id: 'how-to-search-faq',
    category: 'Getting Started',
    question: 'How do I search the FAQ or ask questions?',
    keywords: ['faq', 'search', 'query', 'question', 'ask', 'issue', 'github', 'help', 'find', 'lookup', 'support', 'asking'],
    answer: 'Run `cch faq` to search. If you do not specify a query on the command line, it will prompt you interactively with `What\'s your query?`. You can also enter a query directly: `cch faq <query>`. If your question is not answered, it will offer to open a pre-filled GitHub issue.'
  },

  // ── Providers ──────────────────────────────────────────────────────────────

  {
    id: 'provider-overview',
    category: 'Providers',
    question: 'Which LLM providers does cc-habits support for habit extraction?',
    keywords: ['provider', 'llm', 'anthropic', 'openai', 'groq', 'ollama', 'model', 'providers', 'llms', 'models', 'supported'],
    answer: 'cc-habits supports four providers for habit extraction:\n- Anthropic (default, claude-haiku-3-5)\n- OpenAI (gpt-4o-mini by default)\n- Groq (llama-3.3-70b-versatile by default, free tier available)\n- Ollama (local, free, no data leaves your machine)\nRun `cch init` to configure, or set `CC_HABITS_PROVIDER` to switch without re-running init.'
  },
  {
    id: 'ollama-offline',
    category: 'Providers',
    question: 'Ollama connection timeout or model not found error',
    keywords: ['ollama', 'timeout', 'offline', '11434', 'connection', 'gemma', 'llama', 'refused', 'error', 'not found', 'failed', 'connect', 'start'],
    answer: '1. Ensure Ollama is running: `ollama serve`\n2. Verify the model is downloaded: `ollama pull llama3.2`\n3. Check your config points to the right URL, default is `http://localhost:11434`\n4. Run `cch init --provider ollama` to reconfigure if the URL changed.'
  },
  {
    id: 'api-key-not-found',
    category: 'Providers',
    question: 'Error: ANTHROPIC_API_KEY not set / API key not found',
    keywords: ['api', 'key', 'anthropic', 'not set', 'missing', 'error', 'openai', 'groq', 'export', 'variable', 'environment', 'auth', 'token'],
    answer: 'cc-habits needs an API key to extract habits. Three ways to provide it:\n1. Run `cch init`, it will prompt you to paste the key and saves it to `~/.cc-habits/config.yml` (mode 0600).\n2. Export it in your shell: `export ANTHROPIC_API_KEY=sk-ant-...`\n3. Add the export to `~/.zshrc` or `~/.bashrc` for persistence.'
  },
  {
    id: 'switch-provider',
    category: 'Providers',
    question: 'How do I switch from one provider to another?',
    keywords: ['switch', 'change', 'provider', 'anthropic', 'openai', 'groq', 'ollama', 'select', 'toggle', 'reconfigure', 'choose'],
    answer: 'Run `cch init` and choose a different provider when prompted. For a one-session override without changing config, export `CC_HABITS_PROVIDER=ollama` (or `groq`, `openai`, `anthropic`) in your shell before running `cch learn`.'
  },
  {
    id: 'rate-limit-429',
    category: 'Providers',
    question: 'Provider rate-limited (HTTP 429), habits not updating',
    keywords: ['rate', 'limit', '429', 'error', 'retry', 'throttle', 'too many', 'requests', 'blocked', 'limit-reached', 'slow'],
    answer: 'cc-habits hit the provider\'s rate limit. Nothing was changed. Options:\n1. Wait 60 seconds and retry the command that triggered learning.\n2. Switch to Ollama (`CC_HABITS_PROVIDER=ollama`) which has no rate limit.\n3. Switch to Groq which has a generous free tier.\ncc-habits automatically retries on transient 429s before giving up.'
  },
  {
    id: 'payload-too-large-413',
    category: 'Providers',
    question: 'Provider payload too large (HTTP 413), extraction batch rejected',
    keywords: ['413', 'payload', 'too large', 'batch', 'size', 'limit', 'error', 'rejected', 'failed', 'huge', 'diff'],
    answer: 'The signal batch was too large for your provider (common with Groq\'s 200 KB limit). cc-habits caps batches at 50 signals and ~180 KB, but large diffs can still exceed limits. Fix:\n1. Switch to Anthropic or OpenAI which accept larger payloads.\n2. Or run `cch reset --yes` to clear the signal backlog, then continue capturing fresh signals.'
  },
  {
    id: 'groq-free-tier',
    category: 'Providers',
    question: 'Can I use cc-habits for free without an API key?',
    keywords: ['free', 'cost', 'price', 'groq', 'ollama', 'no key', 'free-tier', 'cheap', 'payment', 'charge'],
    answer: 'Yes. Two free options:\n1. **Ollama**, fully local, no key needed: `cch init --provider ollama` (requires Ollama installed and a model pulled).\n2. **Groq**, free API tier, very fast: sign up at console.groq.com for a free key, then `cch init --provider groq`.'
  },

  // ── Hooks & Capture ────────────────────────────────────────────────────────

  {
    id: 'hooks-not-firing',
    category: 'Hooks & Capture',
    question: 'Hooks are not firing, no signals being captured',
    keywords: ['hook', 'capture', 'signal', 'not working', 'missing', 'fire', 'trigger', 'detect', 'fail', 'passive', 'not learning'],
    answer: 'Common causes:\n1. You did not run `cch init` in this project, hooks are registered per project in `~/.claude/settings.json`.\n2. The hook binary path changed (e.g. after a Node version switch or nvm change). Run `cch init` again to re-register with the current absolute path.\n3. Check the hook is present: `cat ~/.claude/settings.json | grep cc-habits`\n4. Check for errors: `cch log --limit 5`'
  },
  {
    id: 'nvm-hook-path',
    category: 'Hooks & Capture',
    question: 'Hooks stopped working after switching Node or nvm versions',
    keywords: ['nvm', 'node', 'version', 'hook', 'path', 'binary', 'not found', 'nvm-switch', 'update', 'broken', 'hooks'],
    answer: 'cc-habits stores the absolute path to `cc-habits-hook` at init time. When you switch Node versions via nvm, the binary moves to a different path. Fix: run `cch init` again after switching Node versions. The new absolute path will be written to `~/.claude/settings.json`.'
  },
  {
    id: 'what-signals-captured',
    category: 'Hooks & Capture',
    question: 'What data is captured and stored in the signal log?',
    keywords: ['capture', 'signal', 'log', 'data', 'diff', 'privacy', 'stored', 'what', 'content', 'confidential', 'files', 'safety'],
    answer: 'Each signal records: timestamp, session ID, file path, source tool, language, and a 4 KB diff snippet. PII and secrets are redacted before storage (emails, API keys, card numbers, AWS keys, PEM blocks, etc.). The full list of redacted patterns is in RESPONSIBLE_AI.md. Nothing is uploaded, signals stay in `~/.cc-habits/log.jsonl`.'
  },
  {
    id: 'log-size',
    category: 'Hooks & Capture',
    question: 'The log.jsonl file is getting very large',
    keywords: ['log', 'size', 'disk', 'large', 'rotate', 'jsonl', 'grow', 'space', 'storage', 'cleanup', 'delete', 'clean'],
    answer: 'cc-habits automatically rotates `log.jsonl` when it exceeds 2 MB, keeping the most recent 5,000 signals. If you want to clear the log manually, run `cch reset --yes` (this also clears habits and pending, so export first: `cch export ~/habits-backup.md`). The error log at `~/.cc-habits/error.log` is separate and not auto-rotated.'
  },
  {
    id: 'git-capture',
    category: 'Hooks & Capture',
    question: 'How do I capture habits from git commits instead of live sessions?',
    keywords: ['git', 'commit', 'capture', 'history', 'past', 'git-capture', 'commits', 'repository', 'historical', 'import'],
    answer: 'Run `cch git-capture` to capture signals from your recent git commits (defaults to HEAD~1..HEAD). For a broader range: `cch git-capture --range HEAD~20..HEAD`. After capturing, run `cch learn` to process the signals into habits. This is useful for bootstrapping habits from an existing project history.'
  },
  {
    id: 'capture-ignore',
    category: 'Hooks & Capture',
    question: 'How do I stop cc-habits from capturing signals in a specific directory?',
    keywords: ['ignore', 'exclude', 'disable', 'directory', 'skip', 'stop', '.cc-habits-ignore', 'ignore-file', 'filter', 'skip-files', 'black-list'],
    answer: 'Create a `.cc-habits-ignore` file in the directory you want to exclude. cc-habits will skip capture for any file in that directory or below. This is useful for vendor directories, generated code, or confidential subdirectories.'
  },

  // ── Learning & Habits ──────────────────────────────────────────────────────

  {
    id: 'when-does-learning-happen',
    category: 'Learning & Habits',
    question: 'When does cc-habits actually learn and update my habits?',
    keywords: ['learn', 'when', 'trigger', 'update', 'session', 'stop', 'automatic', 'end', 'extract', 'automatically'],
    answer: 'Learning happens when a Claude Code session ends (the Stop hook fires). cc-habits collects all edit signals from the session and sends them to your LLM provider to extract style patterns. New habits go to `pending` first (review with `cch pending`). If you want to trigger learning manually, run `cch learn`.'
  },
  {
    id: 'pending-what-is',
    category: 'Learning & Habits',
    question: 'What is "pending" and why do new habits need review?',
    keywords: ['pending', 'review', 'approve', 'queue', 'new', 'habit', 'suggestions', 'proposals', 'apply', 'accept', 'discard'],
    answer: '`pending` is a review queue for newly proposed habits. Instead of auto-writing habits to CLAUDE.md (which could introduce bad rules), cc-habits puts new `create` decisions in pending so you can review them. Run `cch pending` to see them, `cch pending --approve` to accept, or `cch pending --discard` to drop them.'
  },
  {
    id: 'not-enough-signals',
    category: 'Learning & Habits',
    question: '"Not enough signals to learn", learning does nothing',
    keywords: ['signals', 'not enough', 'learn', 'minimum', '3', 'few', 'empty', 'failed', 'insufficient'],
    answer: 'cc-habits needs at least 3 signals per session to run extraction (to avoid learning from noise). If you see this:\n1. Make sure hooks are firing, run a session with several file edits.\n2. Use `cch log` to verify signals are being captured.\n3. You can also run `cch bootstrap` to learn from past Claude Code session transcripts.'
  },
  {
    id: 'confidence-explained',
    category: 'Learning & Habits',
    question: 'What does the confidence score on each habit mean?',
    keywords: ['confidence', 'score', 'number', 'percentage', 'what', 'mean', 'value', 'percent', 'formula', 'weight'],
    answer: 'Confidence is a 0–0.95 score representing how consistently you apply a habit:\n- Starts at 0.50 when first created.\n- Goes up by 0.05 each time the pattern is reinforced.\n- Goes down by 0.10 each time it is contradicted.\n- Habits below 0.30 are pruned automatically.\nView confidence with `cch view` or `cch explain "<rule>"`.'
  },
  {
    id: 'habit-decay',
    category: 'Learning & Habits',
    question: 'Why do some habits disappear over time?',
    keywords: ['decay', 'disappear', 'delete', 'gone', 'stale', 'prune', 'remove', 'time', 'week', 'pruned', 'disappearing'],
    answer: 'Habits decay by 0.05 confidence per week if not seen in a session. Once a habit falls below 0.30 confidence it is pruned. This keeps your habits.md reflecting current patterns rather than old ones. To prevent a habit from decaying, keep coding in that style so it gets reinforced. To permanently keep a rule, add it manually to habits.md.'
  },
  {
    id: 'bootstrap-command',
    category: 'Learning & Habits',
    question: 'How do I learn habits from past Claude Code sessions?',
    keywords: ['bootstrap', 'past', 'history', 'sessions', 'transcripts', 'existing', 'old', 'populate', 'historical', 'learn-past'],
    answer: 'Run `cch bootstrap` inside your project directory. It scans past Claude Code session transcripts stored in your project and extracts habits from them. This is the fastest way to populate habits on an existing project without waiting for new sessions.'
  },
  {
    id: 'tombstone-rule',
    category: 'Learning & Habits',
    question: 'How do I permanently prevent a habit from being re-learned?',
    keywords: ['tombstone', 'delete', 'prevent', 'block', 'never', 'permanent', 'remove', 'tombstones', 'blacklist', 'ban', 'block-rule'],
    answer: 'Use `cch tombstone "<rule text>"` (or `cch tombstone "<substring>"`). A tombstoned rule is recorded in `.tombstones.json` and will never be re-created even if the LLM proposes it again. View tombstoned rules with `cch tombstones`. To un-tombstone a rule, you\'ll need to edit `.tombstones.json` directly.'
  },
  {
    id: 'explain-habit',
    category: 'Learning & Habits',
    question: 'How do I see which code changes contributed to a specific habit?',
    keywords: ['explain', 'provenance', 'source', 'where', 'signal', 'history', 'contribute', 'audit', 'why', 'reason', 'diffs'],
    answer: 'Run `cch explain "<rule text>"` with any substring of the rule. It shows the confidence score, how many sessions reinforced vs. contradicted it, and the specific file diffs that contributed. This is useful for auditing why a habit exists or deciding whether to tombstone it.'
  },
  {
    id: 'auto-apply',
    category: 'Learning & Habits',
    question: 'How do I skip the pending review and apply habits automatically?',
    keywords: ['auto', 'automatic', 'skip', 'pending', 'review', 'CC_HABITS_AUTO', 'auto-approve', 'bypass'],
    answer: 'Set `CC_HABITS_AUTO=1` in your shell or in your `.bashrc`/`.zshrc`. With this flag, newly proposed habits are applied directly to habits.md without going through the pending queue. Use with caution, you lose the review step that prevents bad rules from accumulating.'
  },

  // ── Viewing & Diffing ──────────────────────────────────────────────────────

  {
    id: 'view-habits',
    category: 'Viewing & Diffing',
    question: 'How do I see all my current habits?',
    keywords: ['view', 'see', 'list', 'show', 'habits', 'current', 'all', 'display', 'check'],
    answer: 'Run `cch view`. It prints all your habits grouped by category, with confidence scores, and shows the most recent signals. You can also open `~/.cc-habits/habits.md` directly in any editor.'
  },
  {
    id: 'diff-command',
    category: 'Viewing & Diffing',
    question: 'How do I see what changed in my habits between sessions?',
    keywords: ['diff', 'change', 'between', 'compare', 'before', 'after', 'delta', 'changes', 'history'],
    answer: 'Run `cch diff` to see what was added, removed, or changed confidence-wise since the last write. Use `cch diff --since 3` to compare against 3 writes ago. Green = added, red = removed, arrows = confidence change.'
  },
  {
    id: 'log-command',
    category: 'Viewing & Diffing',
    question: 'How do I audit what signals were captured?',
    keywords: ['log', 'audit', 'capture', 'history', 'signal', 'what was sent', 'signals', 'view-log'],
    answer: 'Run `cch log` to see the capture log. By default it shows the most recent entries. Use `--limit N` to control how many are shown. Each entry shows the timestamp, source tool, file, and a snippet of the diff that was captured.'
  },

  // ── Memories ───────────────────────────────────────────────────────────────

  {
    id: 'what-are-memories',
    category: 'Memories',
    question: 'What are "memories" and how are they different from habits?',
    keywords: ['memories', 'memory', 'difference', 'habit', 'what', 'habits-vs-memories', 'concept'],
    answer: 'Habits are style rules extracted from code edits (e.g. "use ternary operators"). Memories are higher-level observations extracted from session patterns (e.g. "user often works in monorepos with shared types"). Memories are opt-in, enable them with `cch memories --enable` or `CC_HABITS_MEMORIES=1`.'
  },
  {
    id: 'enable-memories',
    category: 'Memories',
    question: 'How do I enable or disable memory learning?',
    keywords: ['enable', 'disable', 'memories', 'memory', 'turn on', 'turn off', 'opt in', 'memories-toggle', 'activate'],
    answer: 'Enable permanently: `cch memories --enable` (saves to config.yml)\nDisable permanently: `cch memories --disable`\nEnable for the current shell only: `export CC_HABITS_MEMORIES=1`\nView current status and stored memories: `cch memories`'
  },
  {
    id: 'delete-memory',
    category: 'Memories',
    question: 'How do I delete a specific memory?',
    keywords: ['delete', 'remove', 'memory', 'specific', 'unwanted', 'forget', 'erase'],
    answer: 'Run `cch memories --delete "<text>"` with any substring of the memory you want to remove. The memory is tombstoned so it will not be re-learned. View all tombstoned memories with `cch memories --tombstones`.'
  },

  // ── Sync & Portability ─────────────────────────────────────────────────────

  {
    id: 'sync-to-other-tools',
    category: 'Sync & Portability',
    question: 'How do I share my habits with Cursor, Cline, or other tools?',
    keywords: ['sync', 'cursor', 'cline', 'share', 'export', 'agents', 'AGENTS.md', 'other tools', 'integrate', 'syncing', 'share-habits'],
    answer: 'Run `cch sync`. By default it writes to `AGENTS.md` in your current directory. To sync to specific targets: `cch sync cursor cline agents`. Only habits with confidence >= 0.30 and seen in at least 2 sessions are exported. The exported block is marked with cc-habits markers so it can be updated cleanly without touching your own content.'
  },
  {
    id: 'sync-confidence-threshold',
    category: 'Sync & Portability',
    question: 'Not all my habits appear in the synced AGENTS.md file',
    keywords: ['sync', 'missing', 'AGENTS.md', 'confidence', 'threshold', 'sessions', 'sync-filter', 'not-syncing'],
    answer: 'Sync only exports "trusted" habits: confidence >= 0.30 AND seen in at least 2 sessions. Brand-new habits (1 session, confidence 0.50) are not exported yet. This prevents noisy first-impression rules from polluting your other tools. View which habits qualify with `cch view`.'
  },
  {
    id: 'export-import',
    category: 'Sync & Portability',
    question: 'How do I move my habits to a new machine?',
    keywords: ['export', 'import', 'move', 'new machine', 'transfer', 'backup', 'copy', 'backup-habits', 'restore', 'migrate-machine'],
    answer: '1. On the old machine: `cch export ~/habits-backup.md`\n2. Transfer the file to the new machine.\n3. On the new machine (after running `cch init`): `cch import ~/habits-backup.md`\n\nImport merges by taking the maximum confidence for duplicate rules, so it is safe to re-import on a machine that already has some habits.'
  },

  // ── Shell Integration ──────────────────────────────────────────────────────

  {
    id: 'shell-init',
    category: 'Shell Integration',
    question: 'What does "cch shell-init" do and do I need it?',
    keywords: ['shell', 'shell-init', 'wrapper', 'banner', 'zsh', 'bash', 'eval', 'alias', 'terminal', 'integration'],
    answer: '`cch shell-init` prints a shell wrapper that wraps the `claude` and `gemini` commands to show a session banner (pending habit count, etc.) when you start a session. Add it to your shell profile:\n\n```\neval "$(cch shell-init)"\n```\n\nIt is optional but useful for staying aware of pending habit reviews.'
  },

  // ── Configuration ──────────────────────────────────────────────────────────

  {
    id: 'config-file-location',
    category: 'Configuration',
    question: 'Where is the config.yml file and what can I put in it?',
    keywords: ['config', 'yml', 'yaml', 'location', 'path', 'settings', 'file', 'config-path', 'config.yml', 'edit-config'],
    answer: 'Config lives at `~/.cc-habits/config.yml` (or `$CC_HABITS_DIR/config.yml`). It stores:\n- `provider`: anthropic | openai | groq | ollama\n- `anthropic_api_key`, `openai_api_key`, `groq_api_key`\n- `ollama_url`, `ollama_model`\n- `memories_enabled`: true | false\n- `consent_given`: timestamp (set at init)\nEdit directly or use `cch init` to re-configure interactively.'
  },
  {
    id: 'cc-habits-dir',
    category: 'Configuration',
    question: 'How do I use a different storage directory (e.g. per-project habits)?',
    keywords: ['CC_HABITS_DIR', 'directory', 'override', 'per project', 'custom', 'storage', 'custom-dir', 'paths'],
    answer: 'Set `CC_HABITS_DIR=/path/to/your/dir` before running any `cch` command. This moves all storage (habits.md, log.jsonl, config.yml, etc.) to that directory. Useful for having separate habits per project. Set it in your shell profile or in a per-project `.env` file.'
  },
  {
    id: 'env-var-override',
    category: 'Configuration',
    question: 'How do I override the provider for a single run without changing config?',
    keywords: ['override', 'env', 'environment', 'variable', 'one time', 'temporary', 'provider', 'temporary-provider'],
    answer: 'Prefix the command with the env var:\n```\nCC_HABITS_PROVIDER=groq cch learn\n```\nOr export it for the current shell session:\n```\nexport CC_HABITS_PROVIDER=ollama\ncch learn\n```\nThe env var takes precedence over config.yml for that invocation.'
  },

  // ── Lint ───────────────────────────────────────────────────────────────────

  {
    id: 'lint-command',
    category: 'Lint',
    question: 'How do I check whether a file follows my coding habits?',
    keywords: ['lint', 'check', 'file', 'review', 'habits', 'comply', 'follow', 'linter', 'validate', 'compliance'],
    answer: 'Run `cch lint <file>`. It sends the file content and your habits to the LLM provider and returns a list of violations. Use `--json` to get machine-readable output. This uses your configured provider and counts against your API quota.'
  },

  // ── Security & Privacy ─────────────────────────────────────────────────────

  {
    id: 'data-leaves-machine',
    category: 'Security & Privacy',
    question: 'Does cc-habits send my code to the cloud?',
    keywords: ['cloud', 'upload', 'send', 'privacy', 'data', 'code', 'remote', 'network', 'internet', 'leak', 'safe', 'security', 'external'],
    answer: 'Only diff snippets (up to 4 KB each) are sent to your LLM provider for habit extraction. Nothing else leaves your machine. If you use Ollama, nothing leaves your machine at all. PII and secrets are redacted from diffs before any storage or transmission. Full details in RESPONSIBLE_AI.md.'
  },
  {
    id: 'is-data-leaked',
    category: 'Security & Privacy',
    question: 'Is my data leaked or sent to external servers?',
    keywords: ['leak', 'leaked', 'privacy', 'security', 'upload', 'server', 'internet', 'safe', 'external', 'safety', 'protection', 'leakage', 'compromised', 'exfiltrate', 'collect', 'leaks'],
    answer: 'No. cc-habits runs entirely on your local machine and has no servers. Your habits, memories, logs, and configurations remain local. Code diffs are only sent to the specific LLM provider you configure (Anthropic, OpenAI, Groq, or Ollama) for pattern extraction, and are redacted beforehand for sensitive PII (emails, card numbers, API keys). If you choose Ollama (local), absolutely no data leaves your machine.'
  },
  {
    id: 'pii-redaction',
    category: 'Security & Privacy',
    question: 'What PII and secrets does cc-habits redact from diffs?',
    keywords: ['pii', 'redact', 'secret', 'email', 'api key', 'credit card', 'aws', 'pem', 'token', 'redacted', 'sanitize', 'password', 'key-redaction'],
    answer: 'cc-habits redacts before storage and before sending to any provider:\n- Email addresses\n- API keys (Anthropic, OpenAI, Groq, GitHub tokens, etc.)\n- AWS access key IDs\n- PEM private key blocks\n- Credit/debit card numbers (Luhn-validated)\n- Indian PAN numbers\n- National ID / SSN patterns\n- IBAN numbers\n- Common environment variable secrets (DATABASE_URL, PASSWORD=, SECRET=, etc.)\nSee RESPONSIBLE_AI.md for the full coverage matrix.'
  },
  {
    id: 'config-file-permissions',
    category: 'Security & Privacy',
    question: 'Are API keys stored securely?',
    keywords: ['api key', 'secure', 'permissions', 'mode', '0600', 'config', 'safe', 'file-safety', 'protection'],
    answer: 'Yes. `config.yml` is written with mode 0600 (readable only by your user). cc-habits also guards against symlink attacks when writing the config file. For maximum security, use environment variables instead of storing keys in config.yml.'
  },
  {
    id: 'injection-protection',
    category: 'Security & Privacy',
    question: 'Can a malicious habit rule inject instructions into Claude?',
    keywords: ['injection', 'prompt injection', 'malicious', 'attack', 'security', 'sanitize', 'rule', 'jailbreak', 'prompt-safety'],
    answer: 'cc-habits sanitizes habit rules at two points: at write time when saving to habits.md, and at injection time when the rule is re-inserted into Claude\'s context. Known LLM meta-formats (OpenAI system tags, ChatML, Llama2 instruction tokens, jailbreak phrases) and URLs are stripped from rule text. Defence-in-depth: even if one layer is bypassed, the other still applies.'
  },

  // ── Migrations & Resets ────────────────────────────────────────────────────

  {
    id: 'migrate-command',
    category: 'Migrations & Resets',
    question: 'I upgraded from an older version and habits are not loading',
    keywords: ['migrate', 'upgrade', 'old', 'version', 'not loading', 'missing', 'path', 'old-habits', 'migration'],
    answer: 'Run `cch migrate`. If you used cc-habits before v0.4, storage was at `~/.claude/habits/`. The migrate command copies files to the new location `~/.cc-habits/` and updates the `@import` line in CLAUDE.md. Run with `--force` to re-run even if the destination already has files.'
  },
  {
    id: 'reset-command',
    category: 'Migrations & Resets',
    question: 'How do I start fresh and clear all habits?',
    keywords: ['reset', 'clear', 'fresh', 'start over', 'delete', 'wipe', 'all', 'wipe-all', 'factory-reset', 'delete-habits'],
    answer: '`cch reset --yes` deletes: habits.md, log.jsonl, pending, and snapshot files. Hooks and tombstones are preserved. Export first if you want a backup: `cch export ~/habits-backup.md`. There is no undo.'
  },

  // ── Troubleshooting ────────────────────────────────────────────────────────

  {
    id: 'habits-not-injected',
    category: 'Troubleshooting',
    question: 'My habits are not being injected into Claude Code sessions',
    keywords: ['inject', 'context', 'session', 'not working', 'not showing', 'claude', 'CLAUDE.md', 'import', 'injection-failed', 'missing-habits'],
    answer: 'Habits are injected via an `@import ~/.cc-habits/habits.md` line in `~/.claude/CLAUDE.md`. Check:\n1. Run `cat ~/.claude/CLAUDE.md | grep cc-habits`, the import line must be there.\n2. If missing, run `cch init` to re-register.\n3. Run `cch view` to confirm habits.md has content.\n4. Habits only appear after the first successful `cch learn` run.'
  },
  {
    id: 'git-not-found',
    category: 'Troubleshooting',
    question: 'Git repository not detected or git-capture fails',
    keywords: ['git', 'repo', 'repository', 'commit', 'detect', 'missing', 'git-capture', 'git-missing', 'no-git'],
    answer: 'Ensure you are inside a directory initialized with `git` (run `git status` to verify). For `cch git-capture`, you also need at least one commit. If it still fails, check that `git` is on your PATH: `which git`.'
  },
  {
    id: 'command-not-found',
    category: 'Troubleshooting',
    question: '"cch: command not found" after installing',
    keywords: ['command not found', 'cch', 'not found', 'install', 'path', 'npm', 'cch-missing', 'not-working'],
    answer: 'The npm global bin directory is not on your PATH. Fix:\n1. Find where npm installs globals: `npm config get prefix`\n2. Add `<prefix>/bin` to your PATH in `~/.zshrc` or `~/.bashrc`.\n3. Reload: `source ~/.zshrc` then retry `cch --version`.\nAlternatively install with `npx cc-habits` to run without a global install.'
  },
  {
    id: 'settings-json-corrupt',
    category: 'Troubleshooting',
    question: 'cch init fails with a JSON parse error on settings.json',
    keywords: ['settings', 'json', 'parse', 'error', 'corrupt', 'invalid', 'comments', 'JSON5', 'json-parse-failed', 'settings.json-broken'],
    answer: 'Claude Code\'s `settings.json` may have JSON5 comments or trailing commas that are not valid JSON. cc-habits warns and starts with an empty config rather than crashing. To fix permanently: open `~/.claude/settings.json` and remove any `//` or `/* */` comments, then run `cch init` again.'
  },
  {
    id: 'pending-on-startup',
    category: 'Troubleshooting',
    question: 'I see a "pending habit suggestion" banner at the start of every session',
    keywords: ['banner', 'pending', 'session', 'start', 'notification', 'every time', 'disable-banner', 'stop-banner'],
    answer: 'That is the SessionStart hook surfacing un-reviewed pending habits. It will keep appearing until you review them:\n- `cch pending`, view what is pending\n- `cch pending --approve`, accept and apply to habits.md\n- `cch pending --discard`, drop without applying'
  },

  // ── Advanced ───────────────────────────────────────────────────────────────

  {
    id: 'multiple-projects',
    category: 'Advanced',
    question: 'How do I maintain separate habits for different projects?',
    keywords: ['multiple', 'projects', 'separate', 'different', 'per project', 'workspace', 'monorepo', 'multi-project'],
    answer: 'Use `CC_HABITS_DIR` to point to a different storage directory per project. Add it to your project\'s `.envrc` (direnv) or equivalent:\n```\nexport CC_HABITS_DIR=$PWD/.cc-habits\n```\nThen run `cch init` inside the project to register hooks with that path. Each project gets its own habits.md, log.jsonl, and config.yml.'
  },
  {
    id: 'signal-cap',
    category: 'Advanced',
    question: 'Why does cc-habits cap signals at 50 per batch?',
    keywords: ['cap', '50', 'signals', 'batch', 'limit', 'why', 'max', 'fifty', 'cap-limit'],
    answer: 'The 50-signal cap and 180 KB byte cap prevent provider API errors (HTTP 413) on providers like Groq that have request-size limits. Sending more signals than a provider can handle silently wastes the call. The cap also prevents very long sessions from producing extraction prompts that exceed model context windows.'
  },
  {
    id: 'confidence-math',
    category: 'Advanced',
    question: 'What are the exact confidence math values?',
    keywords: ['confidence', 'math', 'delta', 'initial', 'cap', 'floor', 'prune', 'values', 'numbers', 'algorithm', 'formula'],
    answer: 'Initial confidence: 0.50\nReinforce delta: +0.05 per session\nContradict delta: -0.10 per session\nContradiction burst (3+ contradictions in one batch): delta is doubled\nConfidence cap: 0.95\nPrune threshold: 0.30 (habits below this are removed)\nDecay: -0.05 per week for habits not seen in a session'
  },
  {
    id: 'learn-session-flag',
    category: 'Advanced',
    question: 'How do I learn habits from a specific session ID only?',
    keywords: ['session', 'id', 'specific', 'learn', '--session', 'filter', 'session-filter', 'single-session'],
    answer: 'Run `cch learn --session <session_id>`. Session IDs appear in the capture log (`cch log`). This limits extraction to signals from that exact session, useful for debugging why a session produced unexpected habits or for re-running extraction on a specific session.'
  },
  {
    id: 'cli-capture-adapter',
    category: 'Advanced',
    question: 'How do I integrate cc-habits with a tool that is not natively supported?',
    keywords: ['capture', 'adapter', 'custom', 'integrate', 'tool', 'unsupported', 'cli', '--file', '--diff', 'custom-tool', 'api-capture'],
    answer: 'Use the capture adapter: `cch capture --file <path> --diff <diff_text>`. This directly appends a signal to log.jsonl as if it came from a hook. Build a thin wrapper in your tool that calls this command with the file path and the diff on each edit. The `--source` flag lets you tag signals with your tool name.'
  },
  {
    id: 'provenance-tracking',
    category: 'Advanced',
    question: 'How do I trace exactly which signals created a specific habit?',
    keywords: ['provenance', 'trace', 'origin', 'signal', 'which', 'explain', 'source', 'history-tracking'],
    answer: 'Run `cch explain "<rule text>"`. It shows the contributing signal records: file, timestamp, decision, and the 4-line diff snippet. Provenance is stored in `.provenance.json` and is available for all habits learned after cc-habits v0.2.'
  },
  {
    id: 'update-check',
    category: 'Advanced',
    question: 'How does the version update notice work?',
    keywords: ['update', 'version', 'notice', 'check', 'npm', 'registry', 'latest', 'newer-version', 'upgrade-notice'],
    answer: 'cc-habits checks npm for the latest version at most once per TTL window (cached in `.update-check.json`). If a newer version exists, it prints a one-line notice at the end of command output. It does not auto-update. To update: `npm install -g cc-habits`.'
  }
]
