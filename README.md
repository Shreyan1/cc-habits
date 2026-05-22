# cc-habits

**Claude Code learns your coding habits, automatically.**

> *Your habits, in Claude Code. Your AI agent, personalized.*

---

Claude Code is great. But out of the box it doesn't know your style. Every developer has years of accumulated micro-decisions (naming conventions, error handling patterns, preferred abstractions) that the model cannot see. These days you generate a `CLAUDE.md` from a quick discussion and move on. But that's a snapshot of what you said you wanted on one afternoon. It never sees the corrections you make for weeks after, and you never reopen it to update it.

`cc-habits` fills the gap. It watches your edits, infers patterns, and quietly updates a `habits.md` file that Claude Code reads on every session, using the same `@import` mechanism you already know. A re-injection hook re-asserts your habits on every prompt so they survive context compaction.

**No new concepts. No vendor lock-in. Just a TypeScript package that makes the Claude Code you already paid for, genuinely yours.**

---

## What if it learns the wrong thing?

cc-habits is opinionated about *not* poisoning your Claude Code context. Five guardrails:

1. **New habits don't activate until they've appeared in two distinct sessions.** A bad afternoon of deadline edits cannot graduate into your Claude context. Single-session habits live in a `## Learning (not yet active)` section, visible for review but explicitly marked for Claude to ignore.
2. **New habits are queued for your review.** At the end of each session, proposed new habits are added to a pending queue. The session recap tells you: "2 new habits proposed — run `cch pending` to review." You can `--discard` any you don't want before they graduate.
3. **Manual deletes are remembered.** If you delete a rule from `habits.md`, it gets added to `.tombstones.json` and is never re-learned. Your judgment overrides the system.
4. **Confidence decays over time.** A habit you stopped following loses 0.05/week of confidence after a week of inactivity. Stale rules get pruned automatically.
5. **You can opt out of capture entirely.** Add a `.cc-habits-ignore` file to any repository and cc-habits will not capture signals or run extraction there. Useful for work code or private projects.

If a habit looks wrong, the recipes are:

```bash
cc-habits view                       # see everything, including learning section
cc-habits log                        # see what was captured and sent (audit trail)
cc-habits pending                    # review proposed new habits
cc-habits pending --discard          # reject all pending proposals
cc-habits tombstone "<rule text>"    # block a rule permanently
cc-habits reset --yes                # nuclear option: wipe everything (tombstones survive)
```

You can also just open `~/.claude/habits/habits.md` in your editor and delete any rule. The next session will tombstone it automatically.

---

## Install

```bash
npm install -g cc-habits
cc-habits init        # cch init works too
```

> `cch` is a short alias for `cc-habits`. All commands work with either (`cch init`, `cch view`, `cch pending`, etc.).

During init, if cc-habits finds past Claude Code sessions for this project, it offers to **bootstrap**, learning habits from your existing work instantly:

```
  Found 4 Claude Code sessions for this project.
  Bootstrap habits from past sessions? [y/N] y

  Extracting patterns...
  ✓ Learned 7 habits across 4 categories from 42 edits
```

You can also run this any time with `cc-habits bootstrap`.

**Requirements:**
- Node.js 20+ (already installed if you use Claude Code)
- Claude Code installed
- An AI provider (see below)

> **One-off install (no global install):** `npx cc-habits@latest init` runs just the init step. You will still need `npm install -g cc-habits` to use `cc-habits view`, `cch view`, and `cc-habits reset`.

### Choosing a provider

`cc-habits init` walks you through provider setup interactively. Pick whichever fits:

| Provider | Cost | Setup |
|---|---|---|
| **Anthropic API** | ~$0.09/month (light) | [console.anthropic.com](https://console.anthropic.com) |
| **Ollama** (free, local) | $0 | [ollama.com/download](https://ollama.com/download) |
| **OpenAI API** | your key | [platform.openai.com](https://platform.openai.com) |
| **Groq API** | free tier | [console.groq.com](https://console.groq.com) |

> **No API key?** A Claude Code subscription and an Anthropic API key are separate purchases. If you only have a Claude Code plan, Ollama is the recommended free alternative: it runs locally, no API key needed.
>
> ```bash
> # Quickest path with no API key:
> brew install ollama          # or download from ollama.com
> ollama pull llama3.2
> ollama serve &
> cc-habits init --provider ollama
> ```

---

## How it works

Three Claude Code hooks are installed into your global `~/.claude/settings.json`:

```
PostToolUse (Write|Edit|MultiEdit)
  → captures the diff, appends to ~/.claude/habits/log.jsonl
  → on your session's first edit: prints "cc-habits: N habits active this session"
  → exits in <50ms, never blocks a session

Stop (session end)
  → reads session signals from log.jsonl
  → makes one Haiku call to extract patterns
  → reinforcements / contradictions applied immediately
  → new habits: written to Learning section + queued in pending for review
  → prints session recap: proposed habits, reinforced, guidance to run `cch pending`

UserPromptSubmit (every prompt)
  → injects your strongest active habits into context
  → survives context compaction; "laws, not requests"
  → set CC_HABITS_INJECT=0 to disable
```

`habits.md` is also auto-imported into every Claude Code session via:

```
@import /Users/you/.claude/habits/habits.md    ← added to ~/.claude/CLAUDE.md
```

The `@import` gives Claude the full picture at session start; the **UserPromptSubmit** hook re-asserts the top habits on every turn, so they don't get summarized away when the context compacts mid-session.

No configuration. No project setup. Works globally across every repository you open.

---

## Use your habits in any agent

Your habits aren't locked to Claude Code. `cc-habits sync` writes them into the portable files other coding agents already read:

```bash
cc-habits sync              # writes ./AGENTS.md (the cross-tool standard)
cc-habits sync all          # also writes .cursor/rules/cc-habits.mdc and .clinerules
cc-habits sync cursor       # just Cursor
```

It merges a marked block into existing files, so your hand-written `AGENTS.md` content is preserved. Only **active** habits are emitted: the `## Learning` section never leaks out. The same habits you learned in Claude Code now travel to Codex, Cursor, Cline, Amp, and anything else that reads `AGENTS.md`.

> **Note:** Synced files contain inferences derived from your code. Review them before sharing, especially in team or open-source repos. Best-effort redaction applies to signals, but rule text may reflect patterns from proprietary code.

---

## What it learns

After a few sessions of Claude Code, your `habits.md` might look like this:

```markdown
# Coding habits

Auto-generated by cc-habits. Do not edit manually; changes will be overwritten.

## Python

- Add type hints to all function parameters and return types. Confidence: 0.75
  - Signal: 7 reinforcing, 0 contradicting
  - First learned: 2026-05-18
  - Last updated: 2026-05-20

- Use f-strings instead of .format() or string concatenation. Confidence: 0.65
  - Signal: 4 reinforcing, 1 contradicting
  - First learned: 2026-05-18
  - Last updated: 2026-05-19

## Error Handling

- Wrap external I/O in try/except and re-raise as RuntimeError. Confidence: 0.55
  - Signal: 2 reinforcing, 0 contradicting
  - First learned: 2026-05-19
  - Last updated: 2026-05-19
```

Claude Code reads this file at the start of every session. When it generates code, it already knows your preferences.

---

## View your habits

```bash
cc-habits view
```

```
  cc-habits · your coding habits

  3 habits across 2 categories  ·  12 signals processed

  ── Python ──────────────────────────────────────────

  Add type hints to all function parameters and return types
  [███████████████░░░░░░░] 75%  ↑7  ↓0  · since 2026-05-18

  Use f-strings instead of .format() or string concatenation
  [█████████████░░░░░░░░░] 65%  ↑4  ↓1  · since 2026-05-18

  ── Error Handling ──────────────────────────────────

  Wrap external I/O in try/except and re-raise as RuntimeError
  [███████████░░░░░░░░░░░] 55%  ↑2  ↓0  · since 2026-05-19

  ── Recent signals ───────────────────────

  2026-05-20  models.py
    - def get_user(id):
    + def get_user(id: int) -> dict:

  2026-05-20  utils.py
    - msg = 'Hello ' + name
    + msg = f'Hello {name}'
```

---

## The confidence math

Habits are weighted by how consistently you apply them.

| Event | Delta |
|-------|-------|
| New habit created | 0.50 (in `## Learning`, not yet active) |
| Pattern reinforced in a new session | +0.05 (cap 0.95), graduates to active at 2 sessions |
| Pattern contradicted | −0.10 (−0.20 in a burst of 3+) |
| Habit unused for >7 days | −0.05/week (decay) |
| Confidence below 0.30 | pruned |

Intentionally simple. Symbolic Bayesian-ish updates with session gating, contradiction velocity, and staleness decay. Honest about the math.

---

## Privacy and data

### What gets captured

Each `Write` / `Edit` / `MultiEdit` during a Claude Code session produces a diff signal. Before the signal is stored locally or sent to the AI provider, three patterns are redacted:

| Pattern | Replacement |
|---------|-------------|
| Email addresses | `<REDACTED:email>` |
| Indian PAN numbers | `<REDACTED:pan>` |
| Credit card numbers (Luhn-validated) | `<REDACTED:card>` |

**This is best-effort, not exhaustive.** Redaction targets common PII types. It does not catch all secrets, internal hostnames, or proprietary identifiers. Review your captures with `cc-habits log` before sending to a cloud provider.

### Opting out

| Scope | How |
|---|---|
| A single repository | Add `.cc-habits-ignore` to the repo root |
| System-wide, temporarily | Set `CC_HABITS_DISABLE=1` in your shell |
| Audit what was captured | `cc-habits log [--limit N]` |
| Erase all captures | `cc-habits reset --yes` |

### Consent at init

`cc-habits init` shows a plain-language data-flow summary before asking you to configure a cloud provider. You can choose Ollama (fully local, nothing leaves your machine) or skip provider setup entirely.

### API key storage

Your key is stored in `~/.claude/habits/config.yml` (mode `0600`, not readable by other users). cc-habits passes it directly to the provider SDK — it is never logged, cached, or transmitted anywhere else.

---

## Cost

One small model call per session. That's it.

**With Ollama (recommended if you don't have an API key):** $0/month, runs entirely on your machine.

**With Anthropic Haiku (if you have an API key):**

| Usage | Cost/month |
|-------|------------|
| Light (1 session/day) | ~$0.09 |
| Medium (3 sessions/day) | ~$0.27 |
| Heavy (5+ sessions/day) | ~$0.60 |

You provide your own key. cc-habits does not collect or proxy keys.

---

## Commands

`cch` is a short alias for `cc-habits`; all commands below work with either.

```bash
npm install -g cc-habits              # install globally (once)
# cch is a short alias; all commands below work with either
cc-habits init                        # install hooks, create habits.md, choose a provider
cc-habits bootstrap                   # learn habits from past Claude Code sessions in this project
cc-habits view                        # show current habits + recent signals
cc-habits log [--limit N]             # show capture log — audit trail of what was sent
cc-habits diff [--since N]            # changes since the last write (or N writes ago)
cc-habits explain "<rule>"            # show the signals that produced a habit
cc-habits lint <file> [--json]        # check a source file against your habits
cc-habits export [path]               # print habits.md (or write to path)
cc-habits import <file>               # merge a portable habits file
cc-habits sync [targets] [--dir P]    # write habits to AGENTS.md / Cursor / Cline (default: agents)
cc-habits pending                     # review proposed new habits
cc-habits pending --discard           # reject all pending proposals
cc-habits tombstone "<rule>"          # block a rule from ever being re-learned
cc-habits tombstones                  # list tombstoned rules
cc-habits reset --yes                 # delete habits.md, log.jsonl, pending, snapshot
cc-habits --version                   # print installed version
```

**Environment variables:**

| Var | Default | Purpose |
|---|---|---|
| `CC_HABITS_DIR` | `~/.claude/habits` | Override the storage location entirely. |
| `CC_HABITS_PROVIDER` | `anthropic` | Switch extractor backend: `anthropic`, `openai`, `groq`, `ollama`. |
| `CC_HABITS_INJECT` | `1` (on) | Set to `0`/`false`/`off` to disable prompt-time habit injection. |
| `CC_HABITS_MARKER` | `1` (on) | Set to `0`/`false`/`off` to silence the session-start "N habits active" banner. |
| `CC_HABITS_AUTO` | `0` (off) | Set to `1` to skip the pending review queue and auto-apply new habits silently. |
| `CC_HABITS_DISABLE` | `0` (off) | Set to `1` to disable all capture and extraction for this shell session. |
| `ANTHROPIC_API_KEY` | (from config.yml) | Bypass `config.yml` storage. |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | (from config.yml) | Required when using those providers. |

---

## Safety guarantees

1. **Never fails a Claude Code session.** Every hook is wrapped in `try/catch`. On error: logs to `~/.claude/habits/error.log`, exits 0. The `|| true` in the hook command is an extra layer.
2. **No data leaves your machine** except the AI provider call you configured. No telemetry, no analytics, no Anthropic-operated server beyond the API itself.
3. **Explicit consent for cloud providers.** `cc-habits init` shows a plain-language data-flow summary before asking you to configure any cloud provider. Ollama skips this — nothing leaves your machine.
4. **Injection-hardened rules.** Because a learned habit is injected into every future session, untrusted code is a prompt-injection channel. Rules and category labels are sanitized at every boundary — write to habits.md, injection into Claude context, `cch import`, and `cch sync`. The sanitizer defends against: role-marker injection (`SYSTEM:`, ChatML, Llama tokens), **zero-width-character splitting** (`SYS​TEM:`), **Unicode homoglyphs** (NFKC folds fullwidth `ＳＹＳＴＥＭ` to ASCII before matching), **container escape** (any `<tag>` token — including `</coding-habits>` — is stripped so a rule cannot break out of the injection wrapper), URLs, and control characters. Length is bounded *before* regex evaluation to prevent ReDoS. Synced files (AGENTS.md, Cursor, Cline) get the same treatment and are safe to commit.
5. **Imported habits are sanitized.** `cch import` passes all incoming rule text through the same sanitizer, so a malicious shared habits file cannot embed instructions into your context.
6. **habits.md is human-readable.** You can read, edit, or delete it at any time. `cc-habits reset --yes` gives you a clean slate.
7. **Bounded log with automatic rotation.** `log.jsonl` is append-only and trimmed automatically when it exceeds 2 MB — keeping the 5,000 most-recent signals. `.history.jsonl` keeps the last 100 session snapshots; `error.log` keeps the last 1,000 lines. Your disk is never silently filled. Inspect at any time with `cc-habits log`; erase with `cc-habits reset`.
8. **Per-repo opt-out.** Add `.cc-habits-ignore` to any repository to stop capture entirely in that directory tree.
9. **Terminal-safe output.** `cc-habits log` / `view` / `explain` / `pending` strip ANSI and control sequences from captured content before display, so a malicious diff cannot spoof or manipulate your terminal.
10. **Validated provider responses.** The extractor never trusts the LLM's JSON blindly — each rule object is shape-validated and coerced to known fields, so a buggy or MITM'd provider endpoint cannot inject arbitrary structure.
11. **Symlink- and traversal-safe writes.** Every file write refuses to follow symlinks and sanitizes paths against `../` traversal and control characters. Storage files are written `0600` (owner-only).

---

## FAQ

**Does this work on all my projects?**
Yes. Hooks are registered in `~/.claude/settings.json` (user-level, not project-level). Habits are stored in `~/.claude/habits/`. Everything is global by default.

**I already auto-generate a CLAUDE.md. Does this replace it?**
No. It fills the gap. `cch init` adds a single `@import` line to your existing `~/.claude/CLAUDE.md` and overwrites nothing. Your generated file stays; cc-habits keeps it current with what you actually do.

**Will it slow down or break my Claude Code sessions?**
No. The capture and inject hooks run locally in under 50ms. Every hook is wrapped in try/catch and exits 0 on error, so cc-habits can never fail or block a session.

**What if the extractor makes a mistake?**
Habits accumulate confidence gradually. A single bad extraction won't stick: it needs reinforcing signals to grow above 0.50. You can also directly edit `habits.md` to remove any rule you don't agree with.

**Do I need an Anthropic API key on top of my Claude Code plan?**
They are separate purchases. If you only have a Claude Code plan, run with Ollama: free and fully local, no key required. Anthropic Haiku (~$0.09/mo), OpenAI, and Groq are also supported.

**Does cc-habits phone home?**
Never. There is no cc-habits server, no telemetry, no analytics, no error-reporting endpoint. The only outbound call is the extractor call to the provider you pick.

**Does this work offline?**
Signal capture (PostToolUse hook) works offline. Extraction (Stop hook) requires the API; if you are offline it logs the error and exits 0, no signals lost.

**Is the habits.md format stable?**
The v0.1 format (markdown, confidence scores, signal counts, dates) is documented. Future versions will migrate it forward. The format is intentionally human-readable so manual edits survive.

**What happens when two projects have conflicting styles?**
In v0.1, all signals go into one global pool. Contradicting signals lower a habit's confidence; if it drops below 0.30 it is pruned. Explicit per-project profiles are on the v0.2 roadmap.

---

## Architecture

```
~/.claude/habits/
├── habits.md      ← learned habits (auto-updated, auto-imported)
├── log.jsonl      ← signal log (append-only)
├── config.yml     ← API key (written by cc-habits init)
└── error.log      ← errors from hooks (never crashes Claude Code)

~/.claude/settings.json  ← PostToolUse + Stop hooks registered here
~/.claude/CLAUDE.md      ← @import line added here
```

Source: `src/` (TypeScript, fully typed, MIT licensed)

---

## Contributing

cc-habits is MIT-licensed. Before opening a PR:
- Check if the change belongs in the current release or v0.2+ (see [ROADMAP.md](ROADMAP.md))
- Add a test covering the new behaviour
- `npm run build` must pass (zero TypeScript errors)
- `npm test` must pass (all tests green)

---

## License

MIT. See [LICENSE](LICENSE).

---

*Built by [Shreyan Basu Ray](https://github.com/Shreyan1). Claude Code, more personalized.*
