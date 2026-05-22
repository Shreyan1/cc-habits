# Privacy

cc-habits is a local-first tool. It is designed so that **you** are the only data controller for everything it captures.

## What is stored, where

| Artifact | Path | Contents | Permissions |
|---|---|---|---|
| Habits file | `~/.claude/habits/habits.md` | Learned coding habits (markdown) | `0600` |
| Signal log | `~/.claude/habits/log.jsonl` | Append-only redacted diffs of edits you make to AI-generated code | `0600` |
| Snapshot | `~/.claude/habits/.snapshot.json` | Last-written habits state, used to detect manual deletes | `0600` |
| Tombstones | `~/.claude/habits/.tombstones.json` | Rules you (or the system) marked never-relearn | `0600` |
| Pending | `~/.claude/habits/.pending.json` | Staged updates awaiting your approval (when review mode is enabled) | `0600` |
| Error log | `~/.claude/habits/error.log` | Hook errors that never crash Claude Code | `0600` |
| Config | `~/.claude/habits/config.yml` | Your Anthropic API key, if you provided one during `init` | `0600` |

All files live on **your** machine. None of them are synced or uploaded by cc-habits.

## What leaves the machine

Exactly one outbound call per Claude Code session: the **Stop hook** sends a redacted batch of session signals to the Anthropic API for habit extraction. This call uses **your** API key, hits Anthropic directly, and is governed by **your** Anthropic terms of service.

cc-habits does not operate a server. There is no telemetry, no analytics, no error reporting endpoint.

## Redaction before any outbound call

Before signals reach the Anthropic API, the following patterns are replaced with sentinel tokens:

| Pattern | Replacement |
|---|---|
| Email addresses (RFC 5322 basic) | `<REDACTED:email>` |
| Indian PAN (5 letters + 4 digits + 1 letter, case-insensitive) | `<REDACTED:pan>` |
| Credit card numbers (12–19 digits passing Luhn) | `<REDACTED:card>` |

The extractor prompt explicitly instructs the model: *"Never output content marked `<REDACTED:...>`."* If you process other categories of sensitive data (non-Latin PII, custom tokens, healthcare identifiers), audit `log.jsonl` periodically and consider stricter retention.

In addition, the extracted rules themselves are sanitized before being written into `habits.md`: control characters, URLs, and prompt-injection keywords (e.g. "IGNORE PREVIOUS", `SYSTEM:`) are stripped to prevent a compromised signal from poisoning your CLAUDE.md context.

## You are the data controller

Because everything lives in your home directory and the only outbound call uses your own API key, **you are the data controller and data processor under GDPR, DPDP, CCPA, and similar regimes**. cc-habits has no privileged access to your data.

If you are operating in a regulated environment:

- Treat `~/.claude/habits/` as you would any folder containing source-code diffs.
- Set `ANTHROPIC_API_KEY` via your secrets manager rather than storing it in `config.yml`.
- Periodically run `cc-habits reset --yes` (or `cch reset --yes`) to clear local history (tombstones survive).
- For air-gapped contexts, do not run `cc-habits init`. Without an API key, the Stop hook fails closed.

## Recommended hygiene

- **Do not sync `~/.claude/habits/`** via Dropbox, iCloud, Syncthing, or similar. Diffs of your code travelling between machines materially expands the data-loss surface. Add it to your sync tool's ignore list.
- **Move your API key to a secrets manager.** Storing it in `config.yml` is convenient but co-resident processes can read it. Setting `ANTHROPIC_API_KEY` via your shell profile + a secrets agent is stronger.
- **Audit `log.jsonl` if you handle sensitive data.** It contains your recent code diffs. Automatic rotation keeps the file below 2 MB (≤ 5,000 most-recent signals); older signals are trimmed. Run `cc-habits log` to inspect or `cc-habits reset --yes` to erase everything.

## What cc-habits will never do

- It will not phone home. There is no cc-habits server.
- It will not modify code in your repositories. It only writes to `~/.claude/`.
- It will not register itself with Claude Code without `cc-habits init` (or `cch init`) running explicitly.
- It will not fail a Claude Code session. Every hook is wrapped in `try/catch` and exits 0 on error.

## Reporting a privacy concern

If you believe cc-habits has leaked data or has a vulnerability with privacy impact, please report it via a GitHub security advisory rather than a public issue: <https://github.com/Shreyan1/cc-habits/security/advisories/new>.
