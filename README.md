# cc-habits

[![npm version](https://img.shields.io/npm/v/cc-habits.svg)](https://www.npmjs.com/package/cc-habits)
[![tests](https://github.com/Shreyan1/cc-habits/actions/workflows/test.yml/badge.svg)](https://github.com/Shreyan1/cc-habits/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/npm/l/cc-habits.svg)](LICENSE)
[![node](https://img.shields.io/node/v/cc-habits.svg)](https://nodejs.org)

**cc-habits is the tool-agnostic memory layer for AI coding agents.** It passively learns your coding habits from your real edits and carries them across Claude Code, Cursor, Codex, Gemini, Cline, and any Git workflow, so every agent you use writes code in *your* style, with no rules files to maintain by hand.

Local-first and private: no telemetry, no server, no analytics. Your habits never leave your machine except the one small extraction call to the LLM provider you choose, or $0 and fully offline with Ollama.

```bash
npm install -g cc-habits && cc-habits init
```

> *Learn once. Personalized everywhere. One local profile shared across Claude Code, Cursor, Codex, Cline, Windsurf, Gemini, and Copilot.*

Read about what we believe and how we build: [PHILOSOPHY.md](PHILOSOPHY.md)

---

<details>
<summary><strong>Table of contents</strong></summary>

- [Why developers install cc-habits](#why-developers-install-cc-habits)
- [cc-habits vs Alternatives](#cc-habits-vs-alternatives)
  - [Understanding the Landscape: The Agent Personalization Dilemma](#understanding-the-landscape-the-agent-personalization-dilemma)
  - [Why cc-habits wins](#why-cc-habits-wins)
  - [Why not background memory daemons (e.g., AgentMemory)?](#why-not-background-memory-daemons-eg-agentmemory)
  - [SKILL.md: Complementary, not competitive](#skillmd-complementary-not-competitive)
  - [mem0: Built for products, not users](#mem0-built-for-products-not-users)
- [Works with your whole toolchain](#works-with-your-whole-toolchain)
- [What if it learns the wrong thing?](#what-if-it-learns-the-wrong-thing)
- [Install](#install)
  - [Platform support](#platform-support)
  - [Choosing a provider](#choosing-a-provider)
- [How it works](#how-it-works)
- [Carry your habits between tools](#carry-your-habits-between-tools)
  - [Mistake memory](#mistake-memory)
  - [VS Code, Cursor, and Antigravity IDE](#vs-code-cursor-and-antigravity-ide)
  - [What's next](#whats-next)
- [What it learns](#what-it-learns)
  - [Language-Specific Storing and Targeting](#language-specific-storing-and-targeting)
- [A typical week of learning](#a-typical-week-of-learning)
- [View your habits](#view-your-habits)
- [The confidence math](#the-confidence-math)
- [Privacy and data](#privacy-and-data)
  - [What gets captured](#what-gets-captured)
  - [Opting out](#opting-out)
  - [Consent at init](#consent-at-init)
  - [API key storage](#api-key-storage)
- [Cost](#cost)
- [Commands](#commands)
- [Safety guarantees](#safety-guarantees)
- [Security](#security)
- [FAQ](#faq)
- [Performance](#performance)
  - [Signal budgets](#signal-budgets)
  - [Test suite](#test-suite)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

</details>

---

Your AI coding agent is great, but out of the box it doesn't know *your* style. Every developer has years of accumulated micro-decisions: naming conventions, error-handling patterns, preferred abstractions, that the model cannot see. Today, you manually generate a `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` file for one repository and move on. But that is a static snapshot. It never sees the corrections you make weeks later, and it doesn't sync when you switch tools. Switch from Claude Code to Cursor, Windsurf, or Cline, and you start personalizing from zero all over again.

`cc-habits` is the neutral configuration standard that connects them. It automatically runs in the background of whatever tool you are using, learns your preferences from your edits, and maintains a single local `habits.md` profile. Any agent you open today instantly reads this shared memory layer.

**No new concepts. No vendor lock-in. Just a lightweight, local-first configuration profile that makes the agents you already paid for genuinely yours, no matter which one you open today.**

---

## Why developers install cc-habits

| Without cc-habits | With cc-habits |
| :--- | :--- |
| ❌ Repeat the same corrections across tools | ✅ **Learn once**: Your style is extracted automatically |
| ❌ Rewrite rules files manually | ✅ **Personalize everywhere**: Syncs to Cursor, Cline, Claude Code, and more |
| ❌ Lose preferences when switching agents | ✅ **Keep improving**: Self-corrects and adapts as your style evolves |

---

## cc-habits vs Alternatives

| | cc-habits | AgentMemory | SKILL.md | mem0 | Manual CLAUDE.md |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **What it captures** | Unified developer profile (coding style + mistake-prevention patterns) | Codebase architecture + decisions | Agent capabilities you define | User memory in AI apps you build | Guidelines you define once |
| **How it's populated** | Passive telemetry-free edit monitoring; auto-extracts patterns | Agent captures all actions silently | You define it | Your app calls the `add()` API | You write it by hand |
| **When it's loaded** | Every prompt, re-injected on compaction | Queried at runtime via MCP | On-demand when task triggers | Queried at runtime | Every session (always-on) |
| **Who it's for** | Developers using coding tools | Developers using coding tools | Developers using coding tools | Developers building AI products | Developers using coding tools |
| **Tool agnostic** | ✅ Input: hooks & Git integration; Output: writes to any agent's native rules format | ❌ MCP-only, agent must support MCP protocol | ⚠️ Open standard (Anthropic), but manually authored per skill | ❌ SDK integration per app | ❌ One file per tool, rewrite for each |
| **Privacy** | ✅ No telemetry, habits file stays on disk. One optional LLM call per session for pattern extraction (defaults to local Ollama). If configured with a cloud LLM, diffs/summaries are sent to that provider. | ⚠️ Local-first, but cloud LLM provider sees your code summaries during compression | ✅ 100% local | ❌ Cloud or self-hosted server | ✅ 100% local |
| **Telemetry** | ✅ Zero, never phones home, no analytics | ⚠️ Background telemetry varies by version; check their current docs | ✅ Zero | ⚠️ Cloud telemetry on paid tiers, check current policy | ✅ Zero |
| **LLM cost at runtime** | ✅ Zero during the session, matching and injection are pure local heuristics. One small extraction call at session end (provider-configurable, ~$0.001 on a cloud model) | ❌ Background LLM calls for memory compression, risk of token burn if misconfigured | ✅ Zero | ❌ Per-query LLM calls on cloud tier | ✅ Zero |
| **Runtime overhead** | ✅ No daemon, no server, no ports. Hooks run on demand and exit in <50ms | ❌ Persistent background daemon and local server process | ✅ Zero | ❌ Cloud or self-hosted server | ✅ Zero |
| **Context overhead** | <0.5% of a 100k window (~150-350 tokens) | Variable, depends on memory retrieval volume | Full skill loaded on activation | Variable, depends on query results | Entire file loaded every session |
| **Compaction safe** | ✅ Re-injects top habits on every prompt, survives mid-session context compaction | ❌ One-shot retrieval, lost on compaction | ❌ Loaded once, lost on compaction | ❌ One-shot retrieval | ❌ Loaded once at session start |
| **Guardrails** | ✅ 2-session graduation, Learning-section quarantine, permanent tombstones, confidence decay, `.cc-habits-ignore` per-repo opt-out | ⚠️ Manual governance delete + TTL expiry, no automated quality filtering | N/A, manually authored | N/A, app-controlled | N/A, manually authored |
| **Setup** | One command: `cch init` auto-detects tools, wires hooks, offers bootstrap | Install MCP server, configure `.mcp.json` per project, start daemon | Create skill directories and write YAML+Markdown files | Integrate SDK into your application code | Create and maintain files by hand |
| **Vendor lock-in** | ✅ Zero. Local open standard; developer owns their personalization data | Tied to MCP protocol + iii-engine runtime | ✅ Open standard, cross-platform | Tied to mem0 SDK/cloud | Tied to one tool's file format |
| **Cross-tool** | ✅ 9+ major platforms (Claude Code, Cursor, Windsurf, Copilot, etc.) kept in lockstep | 20+ agents via MCP | 27+ agents | Any LLM via SDK | One file per tool |
| **Cost** | Free open-source; sub-cent LLM extraction cost | Free but your LLM API bill pays for compression | Free | Free tier, then cloud pricing | Free |

> Comparisons reflect each project's publicly documented behavior at the time of writing and may change. Verify against their current docs before relying on a specific detail. Every claim cc-habits makes about itself is verifiable in this repository's source and test suite.

### Understanding the Landscape: The Agent Personalization Dilemma

Personalizing an AI coding agent currently forces developers to choose between three suboptimal paths:
1. **High-friction manual writing**: Manually maintaining rule files like `CLAUDE.md` or `.cursorrules` (which are written once, never updated, and must be rewritten for every new tool).
2. **Heavyweight runtime daemons**: Running background systems that capture all actions but introduce significant CPU overhead, API costs, and corporate security risks by sending code summaries to cloud LLMs.
3. **Application memory databases**: Complex cloud SaaS infrastructures designed for developers building AI products, not for developers using AI tools.

`cc-habits` defines a new category: **a neutral, local-first configuration and personalization layer**. It combines the zero-friction automation of a logger with the safety and zero-overhead performance of a local configuration file.

---

### Why cc-habits wins

**1. Enterprise-ready security with zero corporate liability.**
Large engineering organizations block background AI memory daemons because they capture code summaries and transmit them to cloud LLMs, violating intellectual property and security compliance. `cc-habits` never sends your code, diffs, or summaries to any external service. There is no telemetry, no analytics, and no tracking. Your habits profile is a plaintext Markdown file on your disk. With multiple automated guardrails (including `.cc-habits-ignore` per-repo opt-outs and a two-session graduation gate), it is safe to run in any enterprise environment.

**2. Near-zero marginal cost and infinite scalability.**
Other memory systems run expensive vector databases or execute background LLM consolidation runs during your session, leading to high API bills or risk of token burn. `cc-habits` shifts the complexity away from runtime: prompt-time matching uses local, high-speed heuristics running in <5ms with zero API cost. The only LLM call happens asynchronously once at session end to extract patterns (costing ~$0.001 per session on a cloud model, and $0 on local Ollama). This architecture ensures infinite scaling with zero runtime costs.

**3. The cross-tool personalization moat: learn once, personalizes everywhere.**
Personalization data should not be locked to a single tool's ecosystem. `cc-habits` captures your style in whichever tool you use today (Claude Code, Cursor, Windsurf, Gemini, etc.) and `cch sync` automatically writes your active profile to the rules files other agents already read (9+ platforms). This creates a zero-friction developer moat: as you switch between competing coding assistants, your custom style and mistake-prevention guidelines remain perfectly intact.

**4. Context-compaction safety.**
AI agents in long sessions summarize their context history to fit window limits, instantly forgetting static files like `CLAUDE.md`. Because `cc-habits` re-injects your top habits dynamically on every prompt via the `UserPromptSubmit` hook, your guidelines survive mid-session compactions and stay active for the entire duration of your session.

**5. Closed-loop, self-correcting feedback.**
Unlike static rules that go out of date immediately, `cc-habits` is self-correcting: unused habits decay automatically, deleted rules are permanently tombstoned, and new habits are quarantined in a visible `## Learning` section that never activates until the pattern recurs across two distinct sessions. You get the benefits of automation without losing governance over your environment.

---

### Why not background memory daemons (e.g., AgentMemory)?

Background memory daemons (such as AgentMemory) are built on different architectural assumptions. They make tradeoffs that matter if you prioritize privacy, cost, and machine performance:

1. **Summaries leave your machine**: They rely on cloud LLMs for background memory compression. If you use a cloud provider, summaries of your file edits, architectural decisions, and error logs can be transmitted externally. `cc-habits` keeps your entire profile local on your disk.
2. **Background runtime costs**: They run background loops (working, episodic, semantic, and procedural passes) that query your LLM provider. A misconfiguration here can lead to unexpected API usage. `cc-habits` has zero runtime LLM cost.
3. **Daemon overhead**: They run a persistent background process to serve memory queries. `cc-habits` has no background daemon and zero idle CPU usage; it executes as a hook in <50ms and exits.
4. **Silent telemetry**: Some register background telemetry hooks; the exact behavior varies by version, so verify against their current docs. `cc-habits` has zero telemetry of any kind, and you can confirm that in the source.
5. **No quality filters**: They capture memories immediately without graduation thresholds. If you write bad code during a late-night session, those mistakes pollute your active context. `cc-habits` requires habits to be verified across two distinct sessions before graduating them to active status.

---

### SKILL.md: Complementary, not competitive

`SKILL.md` is an open standard designed to package **task capabilities** (e.g., "how to run a security audit" or "how to deploy this specific project"). `cc-habits` tracks **developer style** (your personal naming, typing, and syntax preferences). 
* **SKILL.md** = *what* the agent can do (task-specific, manually written, loaded on demand).
* **cc-habits** = *how* the agent should do it (personal style, auto-learned, always-on).

The two protocols work in harmony: `SKILL.md` teaches your agent new workflows, and `cc-habits` ensures it executes them matching your style.

---

### mem0: Built for products, not users

`mem0` is an enterprise memory database designed for developers **building AI products** (such as a customer support chatbot that needs to remember user history). `cc-habits` is designed for developers **using AI tools**. If you are building an application that needs a memory graph, use `mem0`. If you are using Cursor, Claude Code, or Windsurf and want them to understand your coding habits, `cc-habits` is the correct solution.

---

## Works with your whole toolchain

cc-habits learns where it can hook in, and carries what it learned everywhere else:

| Tool | How it learns | How it applies your habits |
|---|---|---|
| **Claude Code** | PostToolUse / Stop / UserPromptSubmit / SessionStart hooks | `@import` + per-prompt injection |
| **Gemini CLI** | AfterTool / AfterAgent / BeforeAgent / SessionStart hooks in `~/.gemini/settings.json` | `GEMINI.md` @import |
| **Codex CLI** | hooks in `~/.codex/hooks.json` | `AGENTS.md` |
| **Kimi Code CLI** | `[[hooks]]` in `~/.kimi/config.toml` | `AGENTS.md` |
| **Cursor** | VS Code extension or Git commits | `cch sync cursor` → `.cursor/rules/` |
| **Cline / RooCode** | PostToolUse / Stop hooks | `cch sync cline` → `.clinerules` |
| **Windsurf** | Git commits | `cch sync windsurf` → `.windsurfrules` |
| **GitHub Copilot** | Git commits | `cch sync copilot` |
| **Any git repo** | `cch git-capture` (mines your commits) | via `cch sync` |
| **Any other agent** | `cch capture` (pipe in a diff) | via `cch sync` |

Learn your habits once in the tool you happen to be using today; `cch sync` writes them into the rules files every other agent already reads. Your style follows you, it doesn't stay behind.

---

## What if it learns the wrong thing?

cc-habits is opinionated about *not* poisoning your agent's context. Five guardrails:

1. **New habits don't activate until they've appeared in two distinct sessions.** A bad afternoon of deadline edits cannot graduate into your agent's context. Single-session habits live in a `## Learning (not yet active)` section, visible for review but explicitly marked to be ignored.
2. **Every session ends with a receipt.** Instead of a manual approval queue, the Stop hook prints one truthful line in your terminal, e.g. `cc-habits: 3 signals captured · 1 habit learning · cch view for details`. You see exactly what was learned, in the same terminal, with no second window and no make-work.
3. **Manual deletes are remembered.** If you delete a rule from `habits.md`, it gets added to `.tombstones.json` and is never re-learned. Your judgment overrides the system.
4. **Confidence decays over time.** A habit you stopped following loses 0.05/week of confidence after a week of inactivity. Stale rules get pruned automatically.
5. **You can opt out of capture entirely.** Add a `.cc-habits-ignore` file to any repository and cc-habits will not capture signals or run extraction there. Useful for work code or private projects.

If a habit looks wrong, the recipes are:

```bash
cc-habits view                       # see everything, including learning section
cc-habits status                     # health check: shows when each tool last *fired* the hook (proof it's running, not just registered)
cc-habits status --proof             # show the exact hook commands written to each tool's config
cc-habits log                        # see what was captured and sent (audit trail)
cc-habits tombstone "<rule text>"    # block a rule permanently
cc-habits reset --yes                # nuclear option: wipe everything (tombstones survive)
```

You can also just open `~/.cc-habits/habits.md` in your editor and delete any rule. The next session will tombstone it automatically.

---

## Install

```bash
npm install -g cc-habits
cc-habits init        # cch init works too
```

> `cch` is a short alias for `cc-habits`. All commands work with either (`cch init`, `cch view`, `cch status`, etc.).

`cc-habits init` detects which coding tools you already have installed and offers to wire each one up. For tools with hooks (Claude Code, Gemini CLI, Codex CLI) it registers capture hooks; for everything else it offers a Git post-commit hook so your habits still get learned from your commits. If it finds past sessions for this project, it offers to **bootstrap**, learning habits from your existing work instantly:

```
  Detected installed tools:
    • Claude Code
    • Gemini CLI

  Register hooks in Claude Code? [Y/n] y
    ✓ PostToolUse hook registered
    ✓ Stop hook registered
    ✓ UserPromptSubmit hook registered
    ✓ preferences.md import added to ~/.claude/CLAUDE.md

  Found 4 sessions for this project.
  Bootstrap habits from past sessions? [Y/n] y

  Extracting patterns...
  ✓ Learned 7 habits across 4 categories from 42 edits
```

You can also run bootstrap any time with `cc-habits bootstrap`.

**Requirements:**
- Node.js 20+
- At least one supported coding tool (Claude Code, Gemini CLI, Codex CLI, Kimi Code CLI, Cursor, Cline, Windsurf, …) **or** any Git workflow
- An AI provider (see below)

> **One-off install (no global install):** `npx cc-habits@latest init` runs just the init step. You will still need `npm install -g cc-habits` to use `cc-habits view`, `cch view`, and `cc-habits reset`.

> Run `cch tools` at any time to see the full list of supported tools and which ones are detected on your machine.

### Platform support

| Platform | Status |
|---|---|
| **macOS** | Fully supported (primary development platform) |
| **Linux** | Fully supported |
| **Windows (WSL2)** | Supported, recommended path on Windows |
| **Windows (Git Bash)** | Supported |
| **Windows (native PowerShell / cmd)** | Partial: the core CLI works, but Git hooks, the `|| true` hook wrappers, and `cch shell-init` assume a POSIX shell. Use WSL2 or Git Bash for full functionality. |

The core CLI is pure Node.js and runs anywhere Node 20+ runs. The pieces that need a POSIX shell are the optional Git post-commit hook, the tool hook commands, and the `cch shell-init` wrapper. CI runs the full test suite on Linux, macOS, and Windows.

### Choosing a provider

`cc-habits init` walks you through provider setup interactively. Pick whichever fits:

| Provider | Cost | Setup |
|---|---|---|
| **Anthropic API** | ~$0.09/month (light) | [console.anthropic.com](https://console.anthropic.com) |
| **Ollama** (free, local) | $0 | [ollama.com/download](https://ollama.com/download) |
| **OpenAI API** | your key | [platform.openai.com](https://platform.openai.com) |
| **Groq API** | free tier | [console.groq.com](https://console.groq.com) |
| **Claude CLI** (`claude-cli`) | $0 extra | WIP: use `cch init --provider claude-cli` |
| **Gemini CLI** (`gemini-cli`) | $0 extra | WIP: use `cch init --provider gemini-cli` |
| **Codex CLI** (`codex-cli`) | $0 extra | WIP: use `cch init --provider codex-cli` |

> **No API key?** Ollama is free, fully local, and needs no account:
>
> ```bash
> brew install ollama          # or download from ollama.com
> ollama pull llama3.2
> ollama serve &
> cch init --provider ollama
> ```

> [!IMPORTANT]
> **Model Capabilities & Extraction Quality:**
> Habit extraction, consolidation, and memory candidate classification require advanced multi-constraint and negative-constraint reasoning. We highly recommend using a top-tier frontier model such as **Anthropic API (Claude Haiku or Sonnet)** or **OpenAI API (GPT-4o / GPT-4o-mini)**.
> Less capable models (including smaller local LLMs or older open models) may drift on negative constraints, leading to duplicate/split rules (e.g. creating separate rules for parameter types and return types instead of consolidating them) or incorrectly extracting typical programming bug fixes (like null checks or resource releases) as general habits instead of concrete memories.

---

## How it works

For any tool that supports hooks (Claude Code, Gemini CLI, Codex CLI, Kimi Code CLI), `cc-habits init` installs its hooks into that tool's settings. Each tool uses its own event names and tool labels, so an `--adapter` flag (set automatically at install) normalizes every payload into the same shape before the engine sees it:

```
PostToolUse (Write|Edit|MultiEdit)
  → captures the diff, appends to ~/.cc-habits/log.jsonl
  → on your session's first edit: prints "cc-habits: N habits active this session"
  → exits in <50ms, never blocks a session

Stop (session end)
  → reads session signals from log.jsonl (capped at 50 most recent per session)
  → makes one small-model call to extract habit patterns
  → reinforcements / contradictions applied immediately
  → new habits: written to the `## Learning` section (activate after a 2nd session)
  → if CC_HABITS_MEMORIES=1: second pass extracts mistake patterns → memories.md
  → prints a session receipt: "N signals captured · M habits learning · cch view for details"

UserPromptSubmit (every prompt)
  → injects top-12 active habits by confidence (~150-350 tokens depending on habit count), dynamically filtered to match the programming languages of files edited in the current session
  → if CC_HABITS_MEMORIES=1: also injects top-3 trigger-matched memories (~40-90 tokens)
  → total injection overhead: < 0.5% of a typical 100k context window
  → set CC_HABITS_INJECT=0 to disable

SessionStart (session begins)
  → prints "cc-habits: N habits active this session" so you know it's live
  → stays silent when nothing is active; never re-injects active habits (no duplication)
```

Event names differ per tool (for example Gemini uses AfterTool / AfterAgent / BeforeAgent / SessionStart, Kimi uses a TOML `[[hooks]]` block), but the internal events above are the same. Run `cch tools` to see every supported tool and which are detected on your machine.

A clean, human-voice `preferences.md` is auto-imported into each hooked tool's session via its native mechanism:

```
@import /Users/you/.cc-habits/preferences.md    ← added to ~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, …
```

`preferences.md` holds only your active rules in plain language, no confidence scores or session counts, so the agent reads it as your own preferences rather than tool metadata. (`habits.md` stays as the internal store.) The `@import` gives the agent the full picture at session start; the **UserPromptSubmit** hook re-asserts the top habits on every turn, so they don't get summarized away when the context compacts mid-session.

For tools without a hook mechanism (Cursor, Windsurf, Copilot), there's nothing to install, you run `cch sync` and your habits land in their rules files. And for *any* workflow at all, `cch git-capture` mines your commit history for patterns; `cc-habits init` can install a Git post-commit hook (locally or as a global template for all future repos) so this happens automatically every time you commit.

No configuration. No project setup. Works globally across every repository you open.

> **Subagents:** Claude Code does not fire `PostToolUse` hooks for tool calls made *inside* a subagent (the Task/Agent tool), see [anthropics/claude-code#34692](https://github.com/anthropics/claude-code/issues/34692) (closed as not-planned). So edits a subagent makes are not captured live. They are still learned the moment you **commit** them, via the `cch git-capture` path, which is exactly Anthropic's own recommended workaround. If you lean heavily on subagents, install the Git post-commit hook during `cc-habits init` so nothing is missed.

---

## Carry your habits between tools

Your habits aren't locked to one tool. `cch sync` writes your active habits into the portable rules files other agents already read:

```bash
cch sync                    # writes ./AGENTS.md (the cross-tool standard)
cch sync all                # writes every supported target at once
cch sync cursor             # just Cursor (.cursor/rules/cc-habits.mdc)
cch sync gemini windsurf    # pick exactly the targets you want
```

Supported targets: `agents`, `cursor`, `copilot`, `gemini`, `cline`, `aider`, `continue`, `jetbrains`, `windsurf`.

| Target | File written |
|---|---|
| `agents` | `AGENTS.md` |
| `cursor` | `.cursor/rules/cc-habits.mdc` |
| `copilot` | `.github/copilot-instructions.md` |
| `gemini` | `GEMINI.md` |
| `cline` | `.clinerules` |
| `aider` | `AIDER.md` |
| `continue` | `.continuerules` |
| `jetbrains` | `.aiassistant/rules/cc-habits.md` |
| `windsurf` | `.windsurfrules` |

It merges a marked block into existing files, so your hand-written content is preserved. Only **active** habits are emitted: the `## Learning` section never leaks out. The same habits you learned in Claude Code now travel to Codex, Cursor, Cline, Windsurf, and anything else that reads these files.

> **Note:** Synced files contain inferences derived from your code. Review them before sharing, especially in team or open-source repos. Best-effort redaction applies to signals, but rule text may reflect patterns from proprietary code.

### Mistake memory

Set `CC_HABITS_MEMORIES=1` and cc-habits also learns what your agent gets **wrong**.

At the end of each session, a second extraction pass looks for mistake patterns, cases where you rewrote or reverted what the agent produced. Candidates are written to `memories.md` alongside your habits. Unlike habits (which are injected broadly), memories are retrieved selectively: only the memories whose trigger terms match your current prompt are injected, capped at 3.

```bash
cc-habits memories                        # view active memories + candidates
cc-habits memories --delete "<text>"      # tombstone a wrong memory permanently
```

```
~/.cc-habits/memories.md
```

```markdown
## Repeated mistakes

- When editing settings.json, do not overwrite existing hook arrays.
  - Trigger: settings.json, hooks, install
  - Correction: Merge new hooks with existing hooks
  - Confidence: 0.80   Seen: 3   Sessions: 2
```

Habits and memories live separately, inject separately, and are deleted separately. A bad memory never poisons your habits context.

### VS Code, Cursor, and Antigravity IDE

cc-habits ships a VS Code extension that shows your habits and memories directly in the IDE sidebar, no terminal needed. It also captures your edits live, so habits keep learning even in tools without shell hooks.

```bash
cd vscode-extension
npm install
npm run build
# Open the vscode-extension/ folder in VS Code / Cursor / Antigravity IDE and press F5
# Or package and install: npx vsce package → install the .vsix
```

The panel gives you:

- **Habits view**, all categories, confidence scores, learning/active status. Inline trash to tombstone any rule without leaving the IDE.
- **Memories view**, active and candidate memories. Inline delete/tombstone.
- **Sync button**, pushes active habits to `AGENTS.md` / Cursor rules / Cline rules instantly.
- **Auto-refresh**, the panel updates live whenever a session ends and writes new habits.

Works in any VS Code fork: VS Code, Cursor, and Antigravity IDE (Google's agent-first IDE launched November 2025). The extension lives in `vscode-extension/` in this repo and is built from source; it is not yet on the VS Code Marketplace.

### What's next

The direction is still local-first and still small:

- **More collectors:** deeper Codex hooks, richer per-IDE capture.
- **More emitters:** additional agent rule formats as they stabilise.

The goal is not to become another coding agent. The goal is a small, inspectable local memory layer that carries what your agents learn about you across every tool you use.

---

## What it learns

After a few coding sessions, your `habits.md` might look like this:

```markdown
# Coding habits

Auto-generated by cc-habits. Do not edit manually; changes will be overwritten.

## Python

- Add type hints to all function parameters and return types. Confidence: 0.75
  - Signal: 7 reinforcing, 0 contradicting
  - Languages: python
  - First learned: 2026-05-18
  - Last updated: 2026-05-20

- Use f-strings instead of .format() or string concatenation. Confidence: 0.65
  - Signal: 4 reinforcing, 1 contradicting
  - Languages: python
  - First learned: 2026-05-18
  - Last updated: 2026-05-19

## Error Handling

- Wrap external I/O in try/except and re-raise as RuntimeError. Confidence: 0.55
  - Signal: 2 reinforcing, 0 contradicting
  - First learned: 2026-05-19
  - Last updated: 2026-05-19
```

Your agent reads this file at the start of every session. When it generates code, it already knows your preferences.

### Language-Specific Storing and Targeting

During session-end habit extraction, the engine automatically detects which programming languages a habit applies to based on the modified files and details of the signals, storing them in the metadata list (e.g., `Languages: python` or `Languages: typescript`).

At runtime:
1. `cc-habits` monitors the files edited during the active session to build a list of active programming languages.
2. In the `UserPromptSubmit` prompt-injection hook, habits with language metadata are only injected if the corresponding language has been active in the current session.
3. Language-agnostic habits (with no `Languages` metadata field) are always candidate for injection.

This dynamic targeting keeps the prompt footprint minimal, preventing irrelevant habits from cluttering the agent's context.

---

## A typical week of learning

After 5 sessions (3 Python, 2 TypeScript):
- **Learned**: 6 active habits, 3 still learning (activate after 1 more session)
- **Memories (if enabled)**: 2 repeated-mistake patterns

---

## View your habits

```bash
cc-habits view
```

```
  ┌────────────────────────────────────────────┐
  │                                            │
  │                   ▄▄▄▄▄▄                  │
  │                  ██▀▀▀▀██                  │
  │           ▄▄▄▄▄▄▄██▄▄▄▄██▄▄▄▄▄▄▄           │
  │         ▄██▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀██▄         │
  │         ██    ▀▀▄▄              ██         │
  │         ██      ▄▄▀▀  ▄▄▄▄▄▄    ██         │
  │         ██    ▀▀      ▀▀▀▀▀▀    ██         │
  │         ██      ▄        ▄      ██         │
  │         ██      █▄▄▄▄▄▄▄▄█      ██         │
  │         ▀██▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄██▀         │
  │           ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀           │
  │                                            │
  │       cc-habits · your coding habits       │
  │  One tool-agnostic developer memory layer  │
  │         Active  ·  anthropic haiku         │
  └────────────────────────────────────────────┘

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

Each `Write` / `Edit` / `MultiEdit` during a coding session produces a diff signal (Git commits produce one per changed file). Before the signal is stored locally or sent to the AI provider, three patterns are redacted:

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
| System-wide, persistently | `cch off` (re-enable with `cch on`) |
| System-wide, temporarily | Set `CC_HABITS_DISABLE=1` in your shell |
| Audit what was captured | `cc-habits log [--limit N]` |
| Erase all captures | `cc-habits reset --yes` |

### Consent at init

`cc-habits init` shows a plain-language data-flow summary before asking you to configure a cloud provider. You can choose Ollama (fully local, nothing leaves your machine) or skip provider setup entirely.

### API key storage

Your key is stored in `~/.cc-habits/config.yml` (mode `0600`, not readable by other users). cc-habits passes it directly to the provider SDK, it is never logged, cached, or transmitted anywhere else.

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
cc-habits tools                       # list supported tools and which are detected on this machine
cc-habits init                        # detect tools, install hooks, create habits.md, choose a provider
cc-habits on                          # re-enable cc-habits after cch off
cc-habits off                         # disable all capture and injection persistently (survives restarts)
cc-habits bootstrap                   # learn habits from past sessions in this project
cc-habits view                        # show current habits + recent signals
cc-habits status [--proof]            # health check: hooks, provider, import, activity (alias: doctor). Shows when each tool last fired the hook (liveness proof); --proof prints the exact hook commands written to each tool's config
cc-habits memories                    # show coding memories (enable with CC_HABITS_MEMORIES=1)
cc-habits memories --delete "<text>"  # tombstone a memory so it is never re-learned
cc-habits memories --tombstones       # list tombstoned memories
cc-habits log [--limit N]             # show capture log, audit trail of what was sent
cc-habits diff [--since N]            # changes since the last write (or N writes ago)
cc-habits explain "<rule>"            # show the signals that produced a habit
cc-habits lint <file> [--json]        # check a source file against your habits
cc-habits export [path]               # print habits.md (or write to path)
cc-habits import <file>               # merge a portable habits file
cc-habits sync [targets] [--dir P]    # write habits to AGENTS.md / Cursor / Cline / … (default: agents)
cc-habits capture --file <p> --diff <d>  # append an edit signal from any tool (CLI capture adapter)
cc-habits git-capture [--range r]     # learn from Git commits (HEAD~1..HEAD by default)
cc-habits learn [--session id]        # learn habits from repository scan or signals
cc-habits migrate [--force]           # migrate storage from ~/.claude/habits/ to ~/.cc-habits/
cc-habits tombstone                   # list all tombstoned (permanently blocked) rules
cc-habits tombstone "<rule>"          # block a rule from ever being re-learned
cc-habits faq                         # print common questions and answers
cc-habits reset --yes                 # delete habits.md, preferences.md, memories.md, log.jsonl, snapshot
cc-habits uninstall [--yes]           # remove all hooks, imports, and local data, fully uninstall
cc-habits shell-init                  # print a claude/gemini shell wrapper, add via: eval "$(cc-habits shell-init)"
cc-habits help                        # interactive arrow-key menu (falls back to text when piped)
cc-habits --version                   # print installed version
```

**Environment variables:**

| Var | Default | Purpose |
|---|---|---|
| `CC_HABITS_DIR` | `~/.cc-habits` | Override the storage location entirely. |
| `CC_HABITS_PROVIDER` | `anthropic` | Switch extractor backend: `anthropic`, `openai`, `groq`, `ollama`, `claude-cli`, `gemini-cli`. |
| `CC_HABITS_INJECT` | `1` (on) | Set to `0`/`false`/`off` to disable prompt-time habit injection. |
| `CC_HABITS_MARKER` | `1` (on) | Set to `0`/`false`/`off` to silence the session-start "N habits active" banner. |
| `CC_HABITS_MEMORIES` | `0` (off) | Set to `1` to enable memory extraction. New candidates are written to `memories.md` at session end. |
| `CC_HABITS_DISABLE` | `0` (off) | Set to `1` to disable all capture and extraction for this shell session. |
| `ANTHROPIC_API_KEY` | (from config.yml) | Bypass `config.yml` storage. |
| `OPENAI_API_KEY` / `GROQ_API_KEY` | (from config.yml) | Required when using those providers. |

---

## Safety guarantees

1. **Never fails a coding session.** Every hook is wrapped in `try/catch`. On error: logs to `~/.cc-habits/error.log`, exits 0. The `|| true` in the hook command is an extra layer.
2. **No data leaves your machine** except the AI provider call you configured. No telemetry, no analytics, no operated server beyond the API itself.
3. **Explicit consent for cloud providers.** `cc-habits init` shows a plain-language data-flow summary before asking you to configure any cloud provider. Ollama skips this, nothing leaves your machine.
4. **Injection-hardened rules.** Because a learned habit is injected into every future session, untrusted code is a prompt-injection channel. Rules and category labels are sanitized at every boundary: write to habits.md, injection into agent context, `cch import`, and `cch sync`. The sanitizer defends against: role-marker injection (`SYSTEM:`, ChatML, Llama tokens), **zero-width-character splitting** (`SYS​TEM:`), **Unicode Tag block** (U+E0000-U+E007F invisible tag characters that render as keywords to LLMs), **Unicode homoglyphs** (NFKC folds fullwidth `ＳＹＳＴＥＭ` and Mathematical Alphanumeric Symbols to ASCII before matching), **Cyrillic/Greek homoglyphs** (`с`, `о`, `р` mapped to Latin equivalents), **container escape** (any `<tag>` token, including `</coding-habits>`, is stripped), URLs, and control characters. Length is bounded *before* regex evaluation to prevent ReDoS. Synced files (AGENTS.md, Cursor, Cline) get the same treatment.
5. **Imported habits are sanitized.** `cch import` passes all incoming rule text through the same sanitizer, so a malicious shared habits file cannot embed instructions into your context.
6. **habits.md is human-readable.** You can read, edit, or delete it at any time. `cc-habits reset --yes` gives you a clean slate.
7. **Bounded log with automatic rotation.** `log.jsonl` is append-only and trimmed automatically when it exceeds 2 MB, keeping the 5,000 most-recent signals. `.history.jsonl` keeps the last 100 session snapshots; `error.log` keeps the last 1,000 lines. Your disk is never silently filled. Inspect at any time with `cc-habits log`; erase with `cc-habits reset`.
8. **Per-repo opt-out.** Add `.cc-habits-ignore` to any repository to stop capture entirely in that directory tree.
9. **Terminal-safe output.** `cc-habits log` / `view` / `explain` strip ANSI and control sequences from captured content before display, so a malicious diff cannot spoof or manipulate your terminal.
10. **Validated provider responses.** The extractor never trusts the LLM's JSON blindly, each rule object is shape-validated and coerced to known fields, so a buggy or MITM'd provider endpoint cannot inject arbitrary structure.
11. **Symlink- and traversal-safe writes.** Every file write is protected against symlink attacks. The write path (`habits.md`, `preferences.md`, config) uses atomic `rename()` which does not follow symlinks on the destination. The append path (`log.jsonl`) opens with `O_NOFOLLOW` (POSIX), causing the kernel to reject the open atomically if the path is a symlink, with no TOCTOU race window. On Windows, a best-effort `lstat` guard is retained. Paths are sanitized against `../` traversal and control characters. Storage files are written `0600` (owner-only).
12. **Shell-free git capture.** `cch git-capture` (and the auto post-commit hook) run git via argument arrays, never a shell, and validate the commit range. A repository file with a hostile name cannot execute code during capture.
13. **Quarantined by default.** New habits land in a visible `## Learning (not yet active)` section and never enter your agent's context until the pattern recurs across two distinct sessions. A single hostile session cannot graduate a misleading rule.
14. **Process-aware concurrency lock.** All stop-hook extraction updates are wrapped in an atomic process-aware locking protocol (`habits.lock`) to prevent write-after-read race conditions during concurrent multi-window coding sessions.
15. **Repo scan prompt firewall.** When `cch learn --repo` sends CLAUDE.md, AGENTS.md, or other project docs to the LLM for memory extraction, each file's content is wrapped in `<file-content>...</file-content>` delimiters. This creates an unambiguous structural boundary that prevents a malicious repo doc from bleeding into the instruction context of the extraction prompt.

---

## Security

For the full attack-surface analysis, vulnerability research findings, and test suite coverage see [SECURITY.md](SECURITY.md).

cc-habits was subject to a dedicated security hardening sprint before its public launch, targeting the hardest-to-reach attack classes: TOCTOU symlink races, Unicode bypass of the injection sanitizer, indirect prompt injection via repo scan, ReDoS via trigger terms, and JSONL control-character injection. All five findings were fixed and have dedicated test coverage.

To report a vulnerability privately, use [GitHub security advisories](https://github.com/Shreyan1/cc-habits/security/advisories/new).

---

## FAQ

**Does this work across all my coding tools?**
Yes, that's the point. Habits are stored once in `~/.cc-habits/` and shared across every tool. Tools with hooks (Claude Code, Gemini CLI, Codex CLI) learn automatically; everything else learns from your Git commits or via `cch sync`. Hooks are registered at the user level, so they apply to every project you open.

**I already auto-generate a CLAUDE.md / AGENTS.md. Does this replace it?**
No. It fills the gap. `cch init` adds a single `@import` line to your existing rules file and overwrites nothing. Your generated file stays; cc-habits keeps it current with what you actually do.

**Will it slow down or break my sessions?**
No. The capture and inject hooks run locally in under 50ms. Every hook is wrapped in try/catch and exits 0 on error, so cc-habits can never fail or block a session.

**What if the extractor makes a mistake?**
Habits accumulate confidence gradually. A single bad extraction won't stick: it needs reinforcing signals across two sessions to grow above 0.50 and activate. You can also directly edit `habits.md` to remove any rule you don't agree with.

**Do I need an AI provider key on top of my coding-tool plan?**
They are separate purchases. If you only have a tool subscription, run with Ollama: free and fully local, no key required. Anthropic Haiku (~$0.09/mo), OpenAI, and Groq are also supported.

**Does cc-habits phone home?**
Never. There is no cc-habits server, no telemetry, no analytics, and no error-reporting endpoint. The only network call is the direct API request to the LLM provider you explicitly configure.

**Does this work offline?**
Signal capture works offline. Extraction requires the API; if you are offline it logs the error and exits 0, no signals lost.

**I used an older version that stored habits in `~/.claude/habits/`. What happens?**
cc-habits auto-migrates your old store to `~/.cc-habits/` on first run, and rewrites the `@import` path. You can also run `cc-habits migrate` manually.

**What happens when two projects have conflicting styles?**
All signals go into one global pool. Contradicting signals lower a habit's confidence; if it drops below 0.30 it is pruned. Explicit per-project profiles are on the roadmap.

**Won't Anthropic, Cursor, or OpenAI just build this themselves?**
They will, but only for their own silos. Anthropic will build Claude memory, and Cursor will build Cursor rules memory. None of them have the incentive, or the structural capability, to build a neutral, cross-platform layer, because doing so requires cooperating with direct competitors. 

For the developer, a single-vendor memory layer creates high platform lock-in. For the ecosystem, fragmentation is a permanent state. The value of a neutral personalization layer compounds as new AI coding assistants enter the market. By remaining tool-agnostic and protocol-independent, `cc-habits` is positioned to be the universal config layer of the AI-agent era, a utility that is structurally impossible for any single platform vendor to build.

---

## Performance

cc-habits is designed to never add perceptible latency to your coding sessions. Every number below is measurable today.

| Operation | Latency | Notes |
|---|---|---|
| **PostToolUse hook** (capture) | < 50ms | Synchronous path: diff extraction, PII redaction, append to log.jsonl |
| **UserPromptSubmit hook** (injection) | < 5ms | Reads habits.md, filters top 12 habits, writes to stdout |
| **SessionStart hook** (active-habits banner) | < 5ms | Reads habits.md, counts active habits, writes to stdout |
| **Stop hook** (extraction) | 1–4s | One LLM call per session; signal batch capped at 50 signals / 180 KB |
| **`cch view`** | < 100ms | Reads habits.md + log.jsonl, renders to terminal |
| **`cch sync`** | < 200ms | Writes one rules file per target; no LLM call |

### Signal budgets

| Limit | Value | Purpose |
|---|---|---|
| Max signals per extraction | 50 | Prevents provider 413 / context-length errors |
| Max diff bytes per batch | 180 KB | Well under Groq's 200 KB hard limit |
| Max diff bytes per signal | 4 KB | Signals above this are truncated |
| Max stdin bytes per hook | 4 MB | Anomalous payloads are discarded |
| Log rotation threshold | 2 MB | `log.jsonl` trimmed to 5,000 most-recent signals |
| History snapshots kept | 100 sessions | `.history.jsonl` trimmed automatically |
| Error log lines kept | 1,000 | `error.log` trimmed on rotation |

### Test suite

710 tests across 45 files, including 8 dedicated security suites (red-team, filesystem hardening, sanitizer fuzzing, adversarial corpus, LLM-specific prompt-injection and memory-poisoning). CI runs the full suite on Linux, macOS, and Windows. See [SECURITY.md](SECURITY.md) for the full breakdown of attack vectors tested.

```bash
npm test    # 710 tests, runs serially for isolation (~12s on macOS M-series)
```

---

## Architecture

```
~/.cc-habits/
├── habits.md              ← learned habits (internal store, auto-updated)
├── preferences.md         ← clean human-voice rules (auto-imported into your tools)
├── habits.lock            ← process-aware concurrency lock file
├── memories.md            ← agent mistake memory (CC_HABITS_MEMORIES=1)
├── log.jsonl              ← signal log (append-only)
├── config.yml             ← API key (written by cc-habits init)
├── .tombstones.json       ← permanently blocked habit rules
├── .memory-tombstones.json ← permanently blocked memories
└── error.log              ← errors from hooks (never crashes a session)

Per-tool wiring (each tool's own config dir):
~/.claude/settings.json    ← PostToolUse + Stop + UserPromptSubmit hooks (Claude Code)
~/.claude/CLAUDE.md        ← @import line added here
~/.gemini/settings.json    ← hooks for Gemini CLI
~/.codex/hooks.json        ← hooks for Codex CLI (JSON MatcherGroup format)
```

VS Code / Cursor / Antigravity IDE extension: `vscode-extension/` in this repo.

Source: `src/` (TypeScript, fully typed, MIT licensed). Tool payloads are normalized through `src/adapters/` so one engine serves every tool. Signal batch capping is centralized in `src/batch.ts` and shared by the Stop hook and CLI extraction paths.

---

## Contributing

cc-habits is MIT-licensed. Before opening a PR:
- Keep the scope small: a local, inspectable memory layer, not another agent.
- Add a test covering the new behaviour.
- `npm run build` must pass (zero TypeScript errors).
- `npm test` must pass (all tests green).

---

## Star this repo

If cc-habits saves you from re-explaining yourself to every new agent, a star is the single best way to help other developers find it. It is the honest truth that a star is the main signal that surfaces a project like this, and it costs you one click.

[⭐ Star cc-habits on GitHub](https://github.com/Shreyan1/cc-habits)

---

## License

MIT. See [LICENSE](LICENSE).

---

*Built by [Shreyan Basu Ray](https://github.com/Shreyan1). Your agents, more personalized.*
