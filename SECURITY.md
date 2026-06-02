# Security policy

## Supported versions

Security fixes are applied to the **latest published version** only.
Older versions are not backported.

| Version | Supported |
|---|---|
| Latest (npm `cc-habits@latest`) | Yes |
| Older releases | No |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Please report using [GitHub private security advisories](https://github.com/Shreyan1/cc-habits/security/advisories/new).
This keeps the disclosure confidential until a fix is published.

Include as much of the following as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce or a minimal proof-of-concept.
- The version of cc-habits affected.
- Any suggested mitigations if you have them.

You will receive an acknowledgment within **72 hours**. If the report is confirmed, a fix will be published as soon as possible (target: within 14 days for critical issues).

## Scope

The following are in scope:

- Command injection, path traversal, or privilege escalation via any CLI input.
- Data exfiltration beyond what PRIVACY.md documents (i.e., data sent somewhere other than the configured LLM provider under the user's own API key).
- Prompt-injection attacks that allow a malicious repository to plant habits that persist and affect future sessions.
- Symlink attacks on any file cc-habits writes.
- Supply-chain issues in the published npm package (`cc-habits`).

The following are out of scope:

- Vulnerabilities that require the attacker to already have write access to `~/.cc-habits/` or the user's home directory.
- Issues in the user's own configured LLM provider (Anthropic, OpenAI, Groq, Ollama).
- Social engineering.

## Security design notes

See [PRIVACY.md](PRIVACY.md) for a detailed description of what data cc-habits processes and the mitigations in place (PII redaction, symlink guards, atomic 0600 writes, prompt-injection sanitization, etc.).
