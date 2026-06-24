# Security audit, June 2026

Scope: a focused cybersecurity pass on `cc-habits` covering the terminal-output
surface, the LLM extraction/injection surface, broken-path / fail-open behaviour,
and the per-repo store work on `feat/per-repo-cch-store`. Threat model: an
attacker who can influence a captured diff, a scanned repo file, a stored data
file, or a provider response, and whose goal is to spoof the terminal, poison
another agent's context, or crash the user's coding session.

The codebase already had a strong, layered defence (NFKC normalization, homoglyph
folding, bidi stripping, fixed-point re-sanitization, injection-keyword and tag
denylists, symlink and traversal guards). This pass found one real vulnerability
class plus a few defence-in-depth gaps. All are fixed; 945 tests pass (269 in the
security suites), including a new regression suite for the issue below.

## Research basis

Two current attack classes from the literature guided the probing:

- Terminal escape / ANSI injection. Untrusted text printed to a terminal can
  carry escape sequences that rewrite the title bar, write the system clipboard
  (OSC 52), or move the cursor to hide and spoof output. Recent instances:
  CVE-2025-55193 (Rails Active Record logging), CVE-2025-55754 (Apache Tomcat),
  the tracing-subscriber advisory GHSA-xwfj-jgwm-7wp5, and Trail of Bits'
  "Deceiving users with ANSI terminal codes in MCP" (Apr 2025). The consistent
  fix is to escape/strip control characters at the output boundary, not only at
  input.
- Second-order prompt injection. Content written into markdown files that other
  LLM agents read (here `preferences.md`, and the `AGENTS.md` / `GEMINI.md` merge
  blocks) becomes instructions in a downstream model's context (OWASP LLM01).

## Findings and fixes

### F1, C1 control characters survive sanitization (medium)

The control-character strippers across the codebase matched only C0 + DEL
(`\x00-\x1f`, `\x7f`) and missed the C1 range (`\x80-\x9f`). C1 carries the
8-bit forms of CSI (`\x9b`) and OSC (`\x9d`); terminals that honor 8-bit
controls treat them as live escapes. A poisoned habit, category, memory, or file
path could therefore smuggle a clipboard-write or title-spoof escape into
`cch view` / `cch status` output and into the files other agents read.

Confirmed by direct probe: `sanitizeRule`, `sanitizeCategory`, and
`sanitizeFilePath` all passed `\x9b` / `\x9d` through unchanged, while the 7-bit
ESC form was correctly stripped.

Fixed at every untrusted write surface by extending the set to
`\x00-\x1f\x7f-\x9f`:
- `src/confidence.ts`, `CONTROL_CHARS` (rule and category sanitization).
- `src/storage.ts`, new shared `STORAGE_CONTROL_CHARS`, applied to
  `sanitizeFilePath`, the `session_id` scrub in `appendSignal`, and the stored
  memory fields (see F2).
- `src/extractor.ts`, the file-path scrub embedded in the lint prompt.

### F2, stored memories were not control-char scrubbed (medium)

`applyMemoryUpdates` wrote `text` / `trigger` / `correction` to `memories.md`
with no control-character stripping (only a trailing-period trim). Memories are
sanitized at injection time (`buildMemoryInjectionContext` calls `sanitizeRule`),
so the second-order LLM-injection path was already covered, but the stored file
and the `cch memories` terminal view rendered raw bytes. The `portable.ts`
import path makes this reachable from another machine's memory file.

Fixed: `applyMemoryUpdates` now scrubs `STORAGE_CONTROL_CHARS` from every stored
memory field at write time, matching how habits are sanitized.

### F3, provider/error text printed to the terminal without scrubbing (low)

Several paths print raw `String(e)` or provider-error text straight to the
terminal. A hostile or MITM'd provider response (in scope: diffs are sent to a
user-chosen provider) could embed escapes. Fixed by routing the exposed sinks
through the existing `term()` output-boundary scrub: the three `Ollama error:`
prints and `providerHint()` (which interpolates an attacker-influenceable model
name).

### F4, `cch status` liveness row file name not scrubbed (low)

Every other file display already used `term()`, but the two top-of-status
"live · ... · file · N sigs" rows printed `path.basename(fired.file)` raw. New
captures are clean via the F1 `sanitizeFilePath` fix, but a hand-edited or
pre-fix `log.jsonl` would reach this row unscrubbed. Fixed by wrapping both in
`term()`.

## Verified already-safe (no change needed)

- Habit and memory terminal rendering: `renderHabitLine` / `renderMemoryLine`
  already wrap untrusted text in `term()`, so the display boundary holds even for
  a poisoned stored file. Confirmed end-to-end: zero C1 codepoints reach stdout
  from a `habits.md` seeded with an 8-bit OSC-52 escape.
- Second-order prompt injection: container-escape tags (`</coding-habits>`),
  role tokens, ChatML / Llama2 markers, HTML comments, URLs, and shell
  substitutions are stripped by the fixed-point `sanitizeRule`; newlines are
  collapsed, so markdown-structure and merge-block breakout do not survive.
- Fail-open behaviour: invalid JSON, empty stdin, null/wrong-typed fields,
  embedded nulls, missing/unknown hook events, and shell-metachar session ids all
  exit 0 without writing damage. Bad CLI commands and conflicting view flags
  degrade gracefully.
- Path traversal and symlink guards (RT-2/3/7) and 0600 file permissions (RT-5)
  remain green.

## Residual notes (accepted, not fixed)

- `cch view --repo --global` resolves to repo scope silently rather than warning
  on the conflict. Benign; cosmetic only.
- `install.ts` TOML quoting uses a C0-only check; the value is a locally resolved
  hook-binary path, not attacker-controlled, so it is left as-is.

## Tests

New suite `tests-ts/security-terminal-escape.test.ts` (12 cases) locks down F1,
F2, F3, F4: C1/ESC/OSC vectors through `sanitizeRule`, `sanitizeCategory`,
`sanitizeFilePath`, `term()`, and the memory store path, plus the `term()`
newline-preservation contract.

Sources:
- https://organicdarius.com/blog/exploring-the-ansi-escape-injection-in-active-record-logging-cve-2025-55193/
- https://github.com/tokio-rs/tracing/security/advisories/GHSA-xwfj-jgwm-7wp5
- https://blog.trailofbits.com/2025/04/29/deceiving-users-with-ansi-terminal-codes-in-mcp/
- https://www.sentinelone.com/vulnerability-database/cve-2025-55754/
- https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- https://genai.owasp.org/llmrisk/llm01-prompt-injection/
