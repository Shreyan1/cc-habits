# Privacy

cc-habits is a local-first tool. It is designed so that **you** are the only data controller for everything it captures.

---

## What is stored, where

Everything lives under `~/.cc-habits/` (override with `CC_HABITS_DIR`). Private files there are written owner-only (`0600`) via symlink-guarded atomic writes, and cc-habits tightens any file an older version may have left more permissive on startup. (The portable files cc-habits writes into your repositories, such as `AGENTS.md`, follow your normal file permissions so your tools and teammates can read them.)

| Artifact | Path | Contents |
|---|---|---|
| Habits file | `~/.cc-habits/habits.md` | Learned coding habits (markdown). Owned by you. |
| Memories file | `~/.cc-habits/memories.md` | Repeated-mistake memories (only when `CC_HABITS_MEMORIES` is enabled). Owned by you. |
| Signal log | `~/.cc-habits/log.jsonl` | Append-only redacted diffs of edits you make. Rotated at 2 MB / 5,000 signals. |
| Snapshot | `~/.cc-habits/.snapshot.json` | Last-written habits state, used to detect manual deletes. |
| Tombstones | `~/.cc-habits/.tombstones.json` | Rules you (or the system) marked never-relearn. |
| Memory tombstones | `~/.cc-habits/.memory-tombstones.json` | Memories marked never-relearn. |
| Pending | `~/.cc-habits/.pending.json` | Staged habit updates awaiting your review. |
| History / provenance | `~/.cc-habits/.history.jsonl`, `.provenance.json` | Past session snapshots and which signals produced each habit. |
| Error log | `~/.cc-habits/error.log` | Hook errors. Never crashes your tool. Rotated at 1,000 lines. |
| Config | `~/.cc-habits/config.yml` | Your provider choice, API key (if provided at `init`), and consent timestamp. |
| Update-check cache | `~/.cc-habits/.update-check.json` | Timestamp and latest npm version, checked at most once per day. No personal data. |

All files live on **your** machine. None of them are synced or uploaded by cc-habits.

> Older versions stored data under `~/.claude/habits/`. `cc-habits` migrates this automatically to `~/.cc-habits/` on first run, and `cch migrate` does it on demand.

---

## Consent at install

When you run `cc-habits init` for the first time, cc-habits shows you a plain-language notice describing:

- what data is processed (code diffs from coding sessions, and sampled repository files/agent instructions during repository scans),
- what leaves your machine (redacted diffs and redacted repository file/doc samples sent to your chosen LLM provider),
- what stays local (habits.md, log.jsonl, and all other files listed above), and
- that cc-habits operates no servers and collects no telemetry.

You must press `Y` (or `Enter`) to proceed. Pressing `N` exits immediately with no changes made.

On consent, a timestamp is written to `~/.cc-habits/config.yml` as `consent_given: <ISO-8601 timestamp>`. This records when you acknowledged the notice. Re-running `cch init` on the same machine does not re-ask once consent is recorded.

If you want to revoke consent and remove all data, run `cch reset --yes`. This deletes habits.md, log.jsonl, and all sidecar files. Tombstones survive by design so rejected rules are not re-proposed.

---

## What leaves the machine

cc-habits makes outbound calls only to the **AI provider you configured**, using **your** API key, governed by **your** agreement with that provider:

- **Ollama (local):** nothing leaves your machine. Fully air-gapped.
- **Anthropic / OpenAI / Groq (cloud):**
  - **During sessions:** a redacted batch of session signals (code diffs) is sent for habit extraction (and, if `CC_HABITS_MEMORIES` is enabled, a second pass for mistake patterns).
  - **During repository scans:** a representative, redacted sample of source files (max 40 files, capped at 2,000 bytes each) and agent-instruction docs (such as `CLAUDE.md`, `AGENTS.md`) is sent for cold-scan habit and memory extraction.
  The call goes directly to that provider over HTTPS.

cc-habits does not operate a server. There is no telemetry, no analytics, and no error-reporting endpoint. The `UserPromptSubmit` and `SessionStart` injection paths, the `git-capture` path, and `cch sync` are all fully local and make no network calls.

The npm latest-version check (new in v0.5.0) queries `registry.npmjs.org/cc-habits/latest` at most once every 24 hours. It sends no personal data, only an HTTPS GET to the public npm registry. You can disable it entirely by setting `CC_HABITS_NO_UPDATE_CHECK=1` in your shell.

---

## Redaction before any outbound call

Before signals reach a cloud provider, the following patterns are replaced with sentinel tokens. The logic lives in `src/redact.ts` and is exercised by a dedicated test suite.

| Pattern | Replacement | Notes |
|---|---|---|
| Email addresses (RFC 5322 basic) | `<REDACTED:email>` | |
| Indian PAN (5 letters + 4 digits + 1 letter) | `<REDACTED:pan>` | Case-insensitive |
| Credit card numbers (12–19 digits passing Luhn) | `<REDACTED:card>` | |
| PEM private key blocks (`BEGIN ... PRIVATE KEY`) | `<REDACTED:private-key>` | RSA, EC, PKCS8 |
| AWS IAM access key IDs (`AKIA...`, `ASIA...`) | `<REDACTED:aws-key>` | Exact 20-char format |
| Known API key prefixes (Anthropic `sk-ant-`, OpenAI `sk-proj-`, Groq `gsk_`, GitHub `ghp_`/`ghs_`/`github_pat_`, Slack `xoxb-`/`xoxp-`) | `<REDACTED:api-key>` | Minimum suffix length to avoid placeholder false positives |
| JWT tokens (`eyJ...header.payload.signature`) | `<REDACTED:jwt>` | Three base64url segments |
| Database connection strings with embedded passwords (`scheme://user:pass@host`) | `<REDACTED:db-url>` | Requires user:pass@ form |
| Indian Aadhaar numbers (spaced/hyphenated `XXXX XXXX XXXX` format, first digit 2–9) | `<REDACTED:aadhaar>` | Compact 12-digit form not redacted (too high false-positive rate) |
| US Social Security Numbers (`XXX-XX-XXXX` canonical form) | `<REDACTED:ssn>` | Invalid ranges (000, 666, 9xx, 00, 0000) excluded |
| UK NHS numbers | `<REDACTED:nhs>` | Gated by the Modulus-11 check digit (near-zero false positives) |
| UK National Insurance numbers (`AB123456C`) | `<REDACTED:uk-ni>` | Invalid prefixes (D/F/I/Q/U/V, BG/GB/NK/KN/TN/NT/ZZ) excluded |
| IBAN bank account numbers | `<REDACTED:iban>` | Gated by the Mod-97 checksum |
| US phone numbers (canonical separated / `+1` forms) | `<REDACTED:phone>` | Bare 10-digit numbers not redacted (too high FP) |
| Sensitive keyed values (`patient_name`, `dob`, `diagnosis`, `mrn`, `address`, `religion`, `ethnicity`, `salary`, `password`, ~50 keys) | `<REDACTED:pii>` | Redacts the value when its key is a known sensitive field, covers HIPAA / GDPR Article 9 categories in `key = value` code |

This is **best-effort, not exhaustive.** See [RESPONSIBLE_AI.md](RESPONSIBLE_AI.md) for the full covered / not-covered matrix, the HIPAA / GDPR / UK posture, and the deployment modes (Ollama is the regulated-data option). It does not catch every secret, internal hostname, or proprietary identifier. If you handle other sensitive data, audit `log.jsonl` periodically with `cch log` and consider stricter retention. The extractor prompt also instructs the model never to output `<REDACTED:...>` content.

In addition, the extracted rules themselves are sanitized before being written to `habits.md`, injected into any agent's context, imported, or synced. The sanitizer strips control characters, URLs, prompt-injection keywords (`SYSTEM:`, ChatML and Llama role tokens), zero-width splitting, Unicode homoglyphs (NFKC-folded), and any `<tag>` token (including `</coding-habits>`) so a compromised signal cannot poison your context. Length is bounded before regex evaluation to prevent ReDoS.

---

## User data ownership

Your `habits.md` and `memories.md` files are **yours**. cc-habits makes no claim on the coding patterns, preferences, or mistake records they contain.

- cc-habits does not aggregate, analyse, or transmit your habits data to any cc-habits-operated endpoint (there is none).
- cc-habits does not use your habits data to train any model.
- You may export, edit, delete, or share your habits.md freely. `cch export` writes a clean copy; `cch reset --yes` deletes everything.
- Any rule you delete from habits.md is automatically tombstoned and never proposed again.

---

## Your rights and applicable regulations

Because everything lives in your home directory and the only outbound call uses your own API key, **you are the data controller and data processor** under applicable privacy law. cc-habits has no privileged access to your data.

### India, DPDP Act 2023

Under the Digital Personal Data Protection Act 2023:

- cc-habits acts as a **data processor** only to the extent diffs or repository files/docs are sent to a cloud LLM provider (Anthropic, OpenAI, or Groq) under your own API key. cc-habits itself is not a "data fiduciary" in the statutory sense because it holds no data on its own infrastructure.
- The consent notice shown at `cch init` satisfies the Act's requirement for a clear, plain-language notice before processing personal data.
- If your code diffs contain personal data of other individuals (for example, user records in test fixtures), you are the data fiduciary for that data. Use Ollama to keep all processing local, or audit `log.jsonl` regularly.
- The `cch reset --yes` command is your erasure mechanism.

### EU/UK, GDPR / UK GDPR

- cc-habits processes no personal data on its own infrastructure. The only processing is the API call to the provider you chose, under your agreement with that provider.
- If you send diffs to a cloud provider, the standard contractual clauses and data-processing agreements of that provider (Anthropic, OpenAI, Groq) govern the transfer.
- For strictly GDPR-compliant operation, use the Ollama provider so no data leaves your machine.

### US, CCPA / CPRA

- cc-habits does not sell personal information. It has no server infrastructure and no business relationship with your data.
- If you are a California resident and use a cloud provider, the CCPA obligations fall on that provider under your agreement with them.

### Regulated environments (HIPAA, PDPA, or similar)

- Prefer the **Ollama** provider so no code, diffs, or repository files leave the machine.
- Treat `~/.cc-habits/` as you would any folder containing source-code diffs.
- Store your provider API key via your secrets manager rather than in `config.yml`.
- Periodically run `cch reset --yes` to clear local history.
- Habits learned from a repository auto-apply to your Learning section. In untrusted repositories, add a `.cc-habits-ignore` file (or set `CC_HABITS_DISABLE=1`) to stop capture, and review what was learned with `cch view`. Set `CC_HABITS_AUTO=1` to print an explicit warning each time new habits are auto-applied.

---

## Recommended hygiene

- **Do not sync `~/.cc-habits/`** via Dropbox, iCloud, Syncthing, or similar. Diffs of your code travelling between machines materially expands the data-loss surface. Add it to your sync tool's ignore list.
- **Move your API key to a secrets manager.** Storing it in `config.yml` is convenient but co-resident processes can read it. Setting the key via your shell profile plus a secrets agent is stronger. cc-habits writes `config.yml` as `0600` and refuses to follow a symlink at that path, but environment-based keys are still safer.
- **Audit `log.jsonl` if you handle sensitive data.** It contains your recent code diffs. Automatic rotation keeps the file below 2 MB (5,000 most-recent signals); older signals are trimmed. Run `cch log` to inspect or `cch reset --yes` to erase everything.
- **Use `.cc-habits-ignore`.** Drop a `.cc-habits-ignore` file in any repository to stop cc-habits from capturing or sending anything from that tree. Useful for employer code, regulated projects, or client work.

---

## What cc-habits will never do

- **Phone home.** There is no cc-habits server. Ollama mode makes no network calls at all.
- **Modify your code.** It writes only under `~/.cc-habits/`, the tool settings files you approve at `init`, and the rules files you target with `cch sync`.
- **Register itself without your explicit consent.** `cch init` requires your acknowledgment before touching anything.
- **Fail a coding session.** Every hook is wrapped in `try/catch` and exits 0 on error.
- **Execute repository content.** `git-capture` runs git via argument arrays, never a shell, so a hostile file name cannot run code.
- **Re-propose a rule you rejected.** Tombstones persist across resets and survive `cch reset --yes`.
- **Use your habits data for training or analytics.** There is no mechanism to do so.

---

## Reporting a privacy concern

If you believe cc-habits has leaked data or has a vulnerability with privacy impact, please report it via a GitHub security advisory rather than a public issue:
<https://github.com/Shreyan1/cc-habits/security/advisories/new>

---

*Last updated: v0.7.6, 2026-06-11.*
