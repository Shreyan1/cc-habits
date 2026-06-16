// PII / secret redaction for code diffs (T2-redact).
//
// Called on every diff before it is stored in log.jsonl or sent to an LLM
// provider. Runs AFTER the diff is capped at MAX_DIFF_BYTES (4 KB) so every
// regex here operates on a bounded input, ReDoS risk is contained.
//
// Architecture: HYBRID, the industry standard (see OpenPipe pii-redaction,
// PredictionGuard, GitGuardian). Deterministic regex + checksums for STRUCTURED
// PII (fast, auditable, zero dependency), plus context-gated keyed-value
// redaction for the common "key = value" case that covers unstructured
// categories (names, medical, address) when they appear in code. Free-floating
// prose PII (a name in a comment sentence) needs an ML model and is documented
// as the optional local-Ollama path in RESPONSIBLE_AI.md.
//
// Design rules:
//   1. Structured patterns: only add with a UNIQUE prefix, fixed structure, or a
//      checksum. Checksums (Luhn, NHS Mod-11, IBAN Mod-97) keep false positives
//      near zero on otherwise-ambiguous digit strings.
//   2. Context-gated patterns: redact a value only when its KEY is in a curated
//      sensitive-key denylist. Over-redaction here is SAFE, cc-habits learns
//      code STYLE, not values, so blanking a value barely affects extraction.
//   3. Never let a pattern match inside an already-redacted token (idempotency).
//   4. Cheap and synchronous: no async, no network, no state.
//
// Coverage maps to HIPAA Safe Harbor (18 identifiers), GDPR / UK GDPR, and the
// OpenPipe 20-category taxonomy where deterministic detection is reliable. See
// RESPONSIBLE_AI.md for the honest covered / not-covered matrix.

// ── Existing structured patterns ─────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi;
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

// PEM private key blocks. FP class: none.
const PEM_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// AWS long-term/temporary access key IDs. FP class: none (AKIA/ASIA + exact 16).
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

// Known LLM / developer-platform API key prefixes. FP class: short placeholders.
const API_KEY_PREFIXES_RE = new RegExp(
  '(?:' + [
    'sk-ant-[a-zA-Z0-9_-]{20,}',
    'sk-proj-[a-zA-Z0-9_-]{20,}',
    'sk-[a-zA-Z0-9]{48}',
    'gsk_[a-zA-Z0-9]{40,}',
    'ghp_[A-Za-z0-9]{36,}',
    'gho_[A-Za-z0-9]{36,}',
    'ghu_[A-Za-z0-9]{36,}',
    'ghs_[A-Za-z0-9]{16,}',
    'ghr_[A-Za-z0-9]{36,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+',
    'xoxp-[0-9]+-[0-9]+-[0-9]+-[a-f0-9]+',
    'xapp-[A-Za-z0-9-]{20,}',
    'sk_live_[A-Za-z0-9]{20,}',
    'rk_live_[A-Za-z0-9]{20,}',
    'AIza[0-9A-Za-z\\-_]{20,}',
  ].join('|') + ')',
  'g',
);

// JWT. FP class: none (eyJ header prefix is unique).
const JWT_RE = /eyJ[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}/g;

// DB connection strings with embedded credentials.
const DB_CONN_RE = /[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^:@/\s]{1,64}:[^@\s]{6,}@[^\s"'`]{4,}/g;

// Indian Aadhaar, spaced/hyphenated 4-4-4 only, first digit 2-9.
const AADHAAR_RE = /\b[2-9][0-9]{3}[\s\-][0-9]{4}[\s\-][0-9]{4}\b/g;

// US SSN, canonical XXX-XX-XXXX with invalid-range exclusions.
const SSN_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

// ── New structured patterns (HIPAA / UK / EU / financial) ────────────────────

// UK NHS number: 10 digits in 3-3-4 spaced, hyphenated, or compact form, gated
// by the Modulus-11 check digit so random 10-digit numbers do not match.
// Source: https://en.wikipedia.org/wiki/NHS_number
const NHS_CANDIDATE_RE = /\b\d{3}[\s\-]?\d{3}[\s\-]?\d{4}\b/g;

function nhsCheck(s: string): boolean {
  const d = s.replace(/[\s\-]/g, '');
  if (!/^\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * (10 - i);
  const remainder = sum % 11;
  let check = 11 - remainder;
  if (check === 11) check = 0;
  if (check === 10) return false; // invalid NHS number
  return check === parseInt(d[9], 10);
}

// UK National Insurance number. Prefix excludes D,F,I,Q,U,V (first/second) and O
// (second), plus disallowed pairs. Suffix A-D. Optionally spaced.
// Source: https://www.gov.uk/hmrc-internal-manuals/national-insurance-manual/nim39110
const UK_NI_RE = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g;

// IBAN, gated by the Mod-97 checksum (valid when the rearranged number mod 97 == 1).
// Covers EU/intl bank accounts (OpenPipe "banking_number"). FP class: near zero
// thanks to the checksum.
const IBAN_CANDIDATE_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

function ibanCheck(s: string): boolean {
  const v = s.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = /[0-9]/.test(ch) ? ch : (ch.charCodeAt(0) - 55).toString();
    for (const digit of code) remainder = (remainder * 10 + parseInt(digit, 10)) % 97;
  }
  return remainder === 1;
}

// US phone numbers in canonical separated forms. Requires separators or a +1
// prefix to avoid matching bare 10-digit identifiers. FP class: low.
const US_PHONE_RE = /(?:\+?1[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]\d{3}[\s.\-]\d{4}\b/g;

// ── Context-gated keyed-value redaction ──────────────────────────────────────
//
// Redacts the value in `key = value` / `key: value` when the key is a known
// sensitive field. Covers names, DOB, medical, address, government IDs, GDPR
// Article 9 special categories, financial fields, and generic secrets that the
// structured patterns above do not catch. Curated to avoid generic keys (no
// bare `name`/`id`) that would over-trigger on ordinary code.
const SENSITIVE_KEYS = [
  // Names (compounds only, never bare "name")
  'first_?name', 'last_?name', 'full_?name', 'middle_?name', 'maiden_?name',
  'patient_?name', 'customer_?name', 'sur_?name', 'given_?name', 'legal_?name',
  // Date of birth
  'date_?of_?birth', 'dob', 'birth_?date', 'birthday', 'birthdate',
  // Medical (HIPAA)
  'diagnosis', 'medical_?record', 'mrn', 'patient_?id', 'icd_?10', 'icd_?code',
  'health_?condition', 'medical_?condition', 'medication', 'prescription', 'npi',
  // Government / national IDs
  'ssn', 'social_?security', 'aadhaar', 'pan_?number', 'passport', 'passport_?no',
  'national_?insurance', 'nino', 'nhs_?number', 'drivers?_?licen[cs]e',
  'licen[cs]e_?number', 'tax_?id', 'tin', 'voter_?id',
  // Contact / location
  'phone', 'phone_?number', 'mobile', 'telephone', 'home_?address',
  'street_?address', 'address_?line', 'postal_?code', 'zip_?code', 'zipcode',
  // GDPR Article 9 special categories
  'religion', 'religious_?affiliation', 'ethnicity', 'race', 'nationality',
  'sexual_?orientation', 'political_?affiliation', 'biometric',
  // Financial
  'account_?number', 'routing_?number', 'iban', 'swift', 'bank_?account',
  'salary', 'income', 'credit_?score',
  // Generic secrets (structured patterns catch known prefixes; this catches the rest)
  'password', 'passwd', 'pwd', 'secret', 'api_?key', 'apikey', 'access_?token',
  'refresh_?token', 'private_?key', 'client_?secret', 'auth_?token',
];

const KEYED_VALUE_RE = new RegExp(
  '\\b(' + SENSITIVE_KEYS.join('|') + ')\\b(\\s*[:=]\\s*)' +
  '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`|[^\\s,;)\\]}]+)',
  'gi',
);

// Replace the value while preserving the key, separator, and quote style. Skips
// values that are already redacted so the pass is idempotent and never clobbers
// an earlier structured replacement (e.g. card="<REDACTED:card>").
function redactKeyedValues(text: string): string {
  return text.replace(KEYED_VALUE_RE, (_m, key: string, sep: string, value: string) => {
    if (value.includes('<REDACTED')) return `${key}${sep}${value}`;
    const q = value[0];
    const wrap = (q === '"' || q === "'" || q === '`') ? q : '';
    return `${key}${sep}${wrap}<REDACTED:pii>${wrap}`;
  });
}

// ── Main export ──────────────────────────────────────────────────────────────

// redact() applies every pattern in a single deterministic pass. Order:
//   1. Whole-block secrets (PEM) so inner content is not partially matched.
//   2. Fixed-prefix high-entropy secrets (API keys, AWS).
//   3. Structured identifiers (JWT, DB URL, NHS, NI, IBAN, Aadhaar, SSN, phone).
//   4. Legacy patterns (email, PAN, card).
//   5. Context-gated keyed values LAST (it skips already-redacted values).
// Returns a new string, never mutates the input, idempotent.
export function redact(text: string): string {
  text = text.replace(PEM_KEY_RE, '<REDACTED:private-key>');
  text = text.replace(AWS_KEY_RE, '<REDACTED:aws-key>');
  text = text.replace(API_KEY_PREFIXES_RE, '<REDACTED:api-key>');
  text = text.replace(JWT_RE, '<REDACTED:jwt>');
  text = text.replace(DB_CONN_RE, '<REDACTED:db-url>');
  text = text.replace(NHS_CANDIDATE_RE, m => (nhsCheck(m) ? '<REDACTED:nhs>' : m));
  text = text.replace(UK_NI_RE, '<REDACTED:uk-ni>');
  text = text.replace(IBAN_CANDIDATE_RE, m => (ibanCheck(m) ? '<REDACTED:iban>' : m));
  text = text.replace(AADHAAR_RE, '<REDACTED:aadhaar>');
  text = text.replace(SSN_RE, '<REDACTED:ssn>');
  text = text.replace(US_PHONE_RE, '<REDACTED:phone>');
  text = text.replace(EMAIL_RE, '<REDACTED:email>');
  text = text.replace(PAN_RE, '<REDACTED:pan>');
  text = text.replace(CARD_CANDIDATE_RE, m => (luhnCheck(m) ? '<REDACTED:card>' : m));
  text = redactKeyedValues(text);
  return text;
}
