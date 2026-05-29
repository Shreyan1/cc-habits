# Privacy

cc-habits is a local-first tool. It is designed so that **you** are the only data controller for everything it captures.

## What is stored, where

Everything lives under `~/.cc-habits/` (override with `CC_HABITS_DIR`). All files are written owner-only (`0600`) via symlink-guarded atomic writes.

| Artifact | Path | Contents |
|---|---|---|
| Habits file | `~/.cc-habits/habits.md` | Learned coding habits (markdown) |
| Memories file | `~/.cc-habits/memories.md` | Repeated-mistake memories (only when `CC_HABITS_MEMORIES` is enabled) |
| Signal log | `~/.cc-habits/log.jsonl` | Append-only redacted diffs of edits you make |
| Snapshot | `~/.cc-habits/.snapshot.json` | Last-written habits state, used to detect manual deletes |
| Tombstones | `~/.cc-habits/.tombstones.json` | Rules you (or the system) marked never-relearn |
| Memory tombstones | `~/.cc-habits/.memory-tombstones.json` | Memories marked never-relearn |
| Pending | `~/.cc-habits/.pending.json` | Staged habit updates awaiting your review |
| History / provenance | `~/.cc-habits/.history.jsonl`, `.provenance.json` | Past session snapshots and which signals produced each habit |
| Error log | `~/.cc-habits/error.log` | Hook errors that never crash your tool |
| Config | `~/.cc-habits/config.yml` | Your provider choice and API key, if you provided one during `init` |

All files live on **your** machine. None of them are synced or uploaded by cc-habits.

> Older versions stored data under `~/.claude/habits/`. `cc-habits` migrates this automatically to `~/.cc-habits/` on first run, and `cch migrate` does it on demand.

## What leaves the machine

cc-habits makes outbound calls only to the **AI provider you configured**, using **your** API key, governed by **your** agreement with that provider:

- **Ollama (local):** nothing leaves your machine. Fully air-gapped.
- **Anthropic / OpenAI / Groq (cloud):** a redacted batch of session signals is sent for habit extraction (and, if `CC_HABITS_MEMORIES` is enabled, a second pass for mistake patterns). The call goes directly to that provider over HTTPS.

cc-habits does not operate a server. There is no telemetry, no analytics, and no error-reporting endpoint. The `UserPromptSubmit` and `SessionStart` injection paths, the `git-capture` path, and `cch sync` are all fully local and make no network calls.

## Redaction before any outbound call

Before signals reach a cloud provider, the following patterns are replaced with sentinel tokens:

| Pattern | Replacement |
|---|---|
| Email addresses (RFC 5322 basic) | `<REDACTED:email>` |
| Indian PAN (5 letters + 4 digits + 1 letter) | `<REDACTED:pan>` |
| Credit card numbers (12–19 digits passing Luhn) | `<REDACTED:card>` |

This is **best-effort, not exhaustive.** It does not catch every secret, internal hostname, or proprietary identifier. If you handle other sensitive data, audit `log.jsonl` periodically with `cch log` and consider stricter retention. The extractor prompt also instructs the model never to output `<REDACTED:...>` content.

In addition, the extracted rules themselves are sanitized before being written to `habits.md`, injected into any agent's context, imported, or synced. The sanitizer strips control characters, URLs, prompt-injection keywords (`SYSTEM:`, ChatML and Llama role tokens), zero-width splitting, Unicode homoglyphs (NFKC-folded), and any `<tag>` token (including `</coding-habits>`) so a compromised signal cannot poison your context. Length is bounded before regex evaluation to prevent ReDoS.

## You are the data controller

Because everything lives in your home directory and the only outbound call uses your own API key, **you are the data controller and data processor under GDPR, DPDP, CCPA, and similar regimes**. cc-habits has no privileged access to your data.

If you are operating in a regulated environment:

- Prefer the **Ollama** provider so no code or diffs leave the machine.
- Treat `~/.cc-habits/` as you would any folder containing source-code diffs.
- Set your provider key (for example `ANTHROPIC_API_KEY`) via your secrets manager rather than storing it in `config.yml`.
- Periodically run `cch reset --yes` to clear local history (tombstones survive).
- Do not enable `CC_HABITS_AUTO` in untrusted repositories. It auto-applies learned habits without your review, removing the human check against a hostile repo planting a misleading habit. cc-habits warns whenever auto-apply runs.

## Recommended hygiene

- **Do not sync `~/.cc-habits/`** via Dropbox, iCloud, Syncthing, or similar. Diffs of your code travelling between machines materially expands the data-loss surface. Add it to your sync tool's ignore list.
- **Move your API key to a secrets manager.** Storing it in `config.yml` is convenient but co-resident processes can read it. Setting the key via your shell profile plus a secrets agent is stronger. cc-habits writes `config.yml` as `0600` and refuses to follow a symlink at that path, but environment-based keys are still safer.
- **Audit `log.jsonl` if you handle sensitive data.** It contains your recent code diffs. Automatic rotation keeps the file below 2 MB (≤ 5,000 most-recent signals); older signals are trimmed. Run `cch log` to inspect or `cch reset --yes` to erase everything.

## What cc-habits will never do

- It will not phone home. There is no cc-habits server, and Ollama mode makes no network calls at all.
- It will not modify code in your repositories. It writes only under `~/.cc-habits/`, the tool settings files you approve during `init`, and the rules files you target with `cch sync`.
- It will not register itself with any tool without `cch init` running explicitly.
- It will not fail a coding session. Every hook is wrapped in `try/catch` and exits 0 on error.
- It will not execute repository content. `git-capture` runs git via argument arrays, never a shell, so a hostile file name cannot run code.

## Reporting a privacy concern

If you believe cc-habits has leaked data or has a vulnerability with privacy impact, please report it via a GitHub security advisory rather than a public issue: <https://github.com/Shreyan1/cc-habits/security/advisories/new>.
