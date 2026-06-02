// PII / secret redaction for code diffs (T2-redact).
//
// Called on every diff before it is stored in log.jsonl or sent to an LLM
// provider. Runs AFTER the diff is capped at MAX_DIFF_BYTES (4 KB) so every
// regex here operates on a bounded input — ReDoS risk is contained.
//
// Design rules:
//   1. Only add patterns with a UNIQUE prefix or tightly-constrained structure.
//      Generic heuristics (entropy, "password =") have >50% false-positive rates
//      on real code and would corrupt legitimate pattern extraction.
//   2. Add a word-boundary or structural anchor on every pattern. A pattern that
//      matches inside a longer token is a false positive.
//   3. Never redact if unsure — a missed secret is worse than a logged token only
//      from cc-habits' threat model (no server, attacker needs LLM-provider MITM).
//   4. Keep the redact() call cheap: no async, no network, no state.
//   5. Document the false-positive class for each pattern so future editors
//      understand the trade-off.
//
// PRIVACY.md "best-effort, not exhaustive" applies here. Developers should
// audit log.jsonl with `cch log` when handling particularly sensitive data.

// ── Existing patterns (retained from original hook.ts) ────────────────────

// RFC 5322 basic. FP class: none significant in code diffs.
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Indian PAN: 5 letters, 4 digits, 1 letter. Case-insensitive since devs
// sometimes normalise to lowercase. FP class: strings that look like a PAN
// but are not (very rare in code given the exact 10-char format).
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi;

// Credit card candidates fed through the Luhn check. FP class: version
// numbers, timestamps, UUIDs that happen to pass Luhn (extremely rare).
const CARD_CANDIDATE_RE = /\b(?:\d[\s\-]?){12,19}\b/g;

function luhnCheck(s: string): boolean {
  const digits = s.replace(/[\s\-]/g, '');
  if (!/^\d+$/.test(digits) || digits.length < 12) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = parseInt(digits[digits.length - 1 - i], 10);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    total += n;
  }
  return total % 10 === 0;
}

// ── New patterns ───────────────────────────────────────────────────────────

// PEM private key blocks. FP class: none — the header is unmistakably a key.
// Matches the full single-line or multi-line block and replaces it entirely.
const PEM_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// AWS long-term IAM access key IDs. Format: AKIA + 16 uppercase alphanumeric
// (technically Base32: A-Z + 2-7, but regex for A-Z0-9 is safe and complete).
// FP class: none in practice given the AKIA prefix + exact 16-char suffix.
// Also catches ASIA (temporary STS credentials, same risk profile).
// Source: https://awsteele.com/blog/2020/09/26/aws-access-key-format.html
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

// Known LLM / developer platform API key prefixes.
// Only patterns with a unique, documented prefix are included. Requiring a
// minimum suffix length (20+) avoids matching short placeholder values in
// documentation or test code.
// FP class: placeholder strings like "sk-ant-REPLACE_ME" may be redacted
//   — that is acceptable, they should not be sent to an LLM anyway.
const API_KEY_PREFIXES_RE = new RegExp(
  '(?:' + [
    'sk-ant-[a-zA-Z0-9_-]{20,}',    // Anthropic (sk-ant-api03-...)
    'sk-proj-[a-zA-Z0-9_-]{20,}',   // OpenAI project key
    'sk-[a-zA-Z0-9]{48}',            // OpenAI legacy (exact 48 chars)
    'gsk_[a-zA-Z0-9]{40,}',          // Groq
    'ghp_[A-Za-z0-9]{36,}',          // GitHub personal access token
    'ghs_[A-Za-z0-9]{16,}',          // GitHub server token
    'github_pat_[A-Za-z0-9_]{20,}',  // GitHub fine-grained PAT
    'xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+', // Slack bot token
    'xoxp-[0-9]+-[0-9]+-[0-9]+-[a-f0-9]+', // Slack user token
  ].join('|') + ')',
  'g',
);

// JWT tokens. Structure: base64url.base64url.base64url where the first chunk
// always decodes to a JSON header starting with {"  (eyJ in base64).
// FP class: any three base64url segments separated by dots, but the eyJ
// prefix makes this essentially unique to JWTs.
const JWT_RE = /eyJ[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}/g;

// Database connection strings with embedded credentials.
// Pattern: scheme://[user:password@]host  (only matches when password is present).
// Minimum 6 chars for the password to avoid matching http://user:80@host style
// port numbers as passwords.
// FP class: URLs with short passwords / port numbers — mitigated by min length.
const DB_CONN_RE = /[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^:@/\s]{1,64}:[^@\s]{6,}@[^\s"'`]{4,}/g;

// Indian Aadhaar card number — spaced or hyphenated 4-4-4 format only.
// Without separators, 12-digit numbers are too common in code (IDs, timestamps).
// First digit must be 2-9 (0 and 1 are not valid Aadhaar first digits).
// Source: https://www.geeksforgeeks.org/how-to-check-aadhar-number-is-valid-or-not-using-regular-expression/
// FP class: any 12-digit number in 4-4-4 spaced format where first digit is 2-9.
const AADHAAR_RE = /\b[2-9][0-9]{3}[\s\-][0-9]{4}[\s\-][0-9]{4}\b/g;

// US Social Security Number in the canonical XXX-XX-XXXX format.
// FP class: version strings, phone extensions with similar digit patterns.
// Anchored with word boundaries to avoid matching inside larger numbers.
const SSN_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// ── Main export ────────────────────────────────────────────────────────────

// redact() applies all patterns in a single deterministic pass. The order is:
//   1. Structural / whole-block patterns (PEM keys) first, so inner content
//      is not partially matched by other patterns.
//   2. High-entropy fixed-prefix patterns (API keys, AWS).
//   3. Structural patterns (JWT, DB URL, Aadhaar, SSN).
//   4. Legacy patterns (email, PAN, card).
//
// Returns a new string — never mutates the input.
export function redact(text: string): string {
  text = text.replace(PEM_KEY_RE, '<REDACTED:private-key>');
  text = text.replace(AWS_KEY_RE, '<REDACTED:aws-key>');
  text = text.replace(API_KEY_PREFIXES_RE, '<REDACTED:api-key>');
  text = text.replace(JWT_RE, '<REDACTED:jwt>');
  text = text.replace(DB_CONN_RE, '<REDACTED:db-url>');
  text = text.replace(AADHAAR_RE, '<REDACTED:aadhaar>');
  text = text.replace(SSN_RE, '<REDACTED:ssn>');
  text = text.replace(EMAIL_RE, '<REDACTED:email>');
  text = text.replace(PAN_RE, '<REDACTED:pan>');
  text = text.replace(CARD_CANDIDATE_RE, m => (luhnCheck(m) ? '<REDACTED:card>' : m));
  return text;
}
