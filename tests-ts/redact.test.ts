import { describe, it, expect } from 'vitest';
import { redact } from '../src/redact';

// ── helpers ──────────────────────────────────────────────────────────────────

const contains = (result: string, token: string): boolean => result.includes(token);

// ── existing patterns (regression) ───────────────────────────────────────────

describe('existing patterns (regression)', () => {
  it('redacts email addresses', () => {
    expect(redact('contact: admin@example.com')).toContain('<REDACTED:email>');
    expect(redact('contact: admin@example.com')).not.toContain('admin@example.com');
  });

  it('redacts Indian PAN', () => {
    expect(redact('pan: ABCDE1234F')).toContain('<REDACTED:pan>');
    expect(redact('pan: abcde1234f')).toContain('<REDACTED:pan>');
  });

  it('redacts Luhn-valid credit card numbers', () => {
    // 4111111111111111 is the canonical test Visa number — Luhn-valid
    expect(redact('card = "4111111111111111"')).toContain('<REDACTED:card>');
    expect(redact('card = "4111111111111111"')).not.toContain('4111111111111111');
  });

  it('does not redact a number that fails Luhn', () => {
    expect(redact('id = "1234567890123456"')).not.toContain('<REDACTED:card>');
  });
});

// ── PEM private keys ─────────────────────────────────────────────────────────

describe('PEM private keys', () => {
  const PRIV = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const EC    = '-----BEGIN EC PRIVATE KEY-----\nbase64here\n-----END EC PRIVATE KEY-----';
  const PKCS8 = '-----BEGIN PRIVATE KEY-----\nmore\n-----END PRIVATE KEY-----';

  it('redacts RSA private key block', () => {
    expect(redact(PRIV)).toContain('<REDACTED:private-key>');
    expect(redact(PRIV)).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('redacts EC private key block', () => {
    expect(redact(EC)).toContain('<REDACTED:private-key>');
  });

  it('redacts PKCS8 private key block', () => {
    expect(redact(PKCS8)).toContain('<REDACTED:private-key>');
  });

  it('does not redact a PUBLIC key block', () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg==\n-----END PUBLIC KEY-----';
    const result = redact(pub);
    expect(contains(result, '<REDACTED:private-key>')).toBe(false);
    expect(result).toContain('PUBLIC KEY');
  });
});

// ── AWS access keys ───────────────────────────────────────────────────────────

describe('AWS access keys', () => {
  it('redacts a long-term IAM key (AKIA prefix)', () => {
    const r = redact('const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(r).toContain('<REDACTED:aws-key>');
    expect(r).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a temporary STS key (ASIA prefix)', () => {
    // ASIA + exactly 16 uppercase alphanumeric chars
    const r = redact('key = ASIAIOSFODNN7EXAMPLE');
    expect(r).toContain('<REDACTED:aws-key>');
  });

  it('does not redact a short AKIA string (not a full key)', () => {
    // less than 16 chars after prefix
    expect(redact('AKIATOOSHOT')).not.toContain('<REDACTED:aws-key>');
  });
});

// ── known API key prefixes ────────────────────────────────────────────────────

describe('known API key prefixes', () => {
  it('redacts Anthropic API key', () => {
    const r = redact('const k = "sk-ant-api03-xyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789abc";');
    expect(r).toContain('<REDACTED:api-key>');
    expect(r).not.toContain('sk-ant-api03-');
  });

  it('redacts Groq API key', () => {
    const r = redact('GROQ_KEY="gsk_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ"');
    expect(r).toContain('<REDACTED:api-key>');
  });

  it('redacts GitHub personal access token', () => {
    // GitHub PATs are 40 chars after ghp_
    const r = redact('token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234"');
    expect(r).toContain('<REDACTED:api-key>');
  });

  it('redacts OpenAI project key', () => {
    const r = redact('OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz1234"');
    expect(r).toContain('<REDACTED:api-key>');
  });

  it('redacts Slack bot token (xoxb- prefix)', () => {
    // Construct the value at runtime so GitHub Secret Scanning does not flag
    // the test file itself as containing a real token.
    const slackToken = ['xoxb', 'AAAAAAAAAAA', 'BBBBBBBBBBB', 'cccccccccccccccccccccccc'].join('-');
    const r = redact(`token = "${slackToken}"`);
    expect(r).toContain('<REDACTED:api-key>');
  });

  it('does not redact a short placeholder like sk-ant-REPLACE', () => {
    // Under 20 chars after prefix, not a real key
    expect(redact('"sk-ant-REPLACE"')).not.toContain('<REDACTED:api-key>');
  });
});

// ── JWT tokens ────────────────────────────────────────────────────────────────

describe('JWT tokens', () => {
  // A real-looking (but fake) JWT: header.payload.signature all in base64url
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  it('redacts a valid JWT', () => {
    const r = redact(`Authorization: Bearer ${JWT}`);
    expect(r).toContain('<REDACTED:jwt>');
    expect(r).not.toContain('eyJhbGci');
  });

  it('redacts a JWT assigned to a variable', () => {
    const r = redact(`const token = "${JWT}";`);
    expect(r).toContain('<REDACTED:jwt>');
  });

  it('does not redact a short eyJ fragment that is not a full JWT', () => {
    // Only 2 parts, not 3 — not a JWT
    expect(redact('eyJhbGci.eyJzdWIi')).not.toContain('<REDACTED:jwt>');
  });
});

// ── database connection strings ───────────────────────────────────────────────

describe('database connection strings with credentials', () => {
  it('redacts a PostgreSQL connection string with password', () => {
    const r = redact('const db = "postgresql://admin:s3cr3tPass@db.prod.internal:5432/myapp";');
    expect(r).toContain('<REDACTED:db-url>');
    expect(r).not.toContain('s3cr3tPass');
  });

  it('redacts a MongoDB Atlas connection string', () => {
    const r = redact('mongodb+srv://user:password123@cluster0.example.mongodb.net/prod');
    expect(r).toContain('<REDACTED:db-url>');
  });

  it('redacts a MySQL connection string', () => {
    const r = redact('mysql://root:topsecret@localhost:3306/appdb');
    expect(r).toContain('<REDACTED:db-url>');
  });

  it('does not redact a URL without credentials (no user:pass@)', () => {
    expect(redact('https://api.example.com/v1/users')).not.toContain('<REDACTED:db-url>');
  });

  it('does not redact a URL with only a port number after colon (no @ present)', () => {
    expect(redact('http://localhost:8080/api')).not.toContain('<REDACTED:db-url>');
  });
});

// ── Aadhaar numbers ───────────────────────────────────────────────────────────

describe('Aadhaar numbers (spaced / hyphenated 4-4-4 format only)', () => {
  it('redacts a spaced Aadhaar number', () => {
    const r = redact('aadhaar = "2345 6789 1234"');
    expect(r).toContain('<REDACTED:aadhaar>');
    expect(r).not.toContain('2345 6789 1234');
  });

  it('redacts a hyphenated Aadhaar number', () => {
    const r = redact('id: 3456-7890-1234');
    expect(r).toContain('<REDACTED:aadhaar>');
  });

  it('does not redact a 12-digit number without separators (too high FP)', () => {
    // Compact 12-digit numbers are very common in code (unix ms timestamps, etc.)
    expect(redact('timestamp = 234567891234')).not.toContain('<REDACTED:aadhaar>');
  });

  it('does not redact a spaced number starting with 0 or 1 (invalid Aadhaar first digit)', () => {
    expect(redact('1234 5678 9012')).not.toContain('<REDACTED:aadhaar>');
    expect(redact('0234 5678 9012')).not.toContain('<REDACTED:aadhaar>');
  });
});

// ── US SSN ────────────────────────────────────────────────────────────────────

describe('US Social Security Numbers', () => {
  it('redacts a canonical SSN', () => {
    const r = redact('ssn = "123-45-6789"');
    expect(r).toContain('<REDACTED:ssn>');
    expect(r).not.toContain('123-45-6789');
  });

  it('does not redact an SSN-like number starting with 000 (invalid)', () => {
    expect(redact('000-45-6789')).not.toContain('<REDACTED:ssn>');
  });

  it('does not redact an SSN-like number starting with 666 (invalid)', () => {
    expect(redact('666-45-6789')).not.toContain('<REDACTED:ssn>');
  });

  it('does not redact an SSN with 0000 in the last group (invalid)', () => {
    expect(redact('123-45-0000')).not.toContain('<REDACTED:ssn>');
  });

  it('does not redact a version string like 1.23-45.6789', () => {
    expect(redact('v1.23-45.6789')).not.toContain('<REDACTED:ssn>');
  });
});

// ── combined / real-world diff shape ─────────────────────────────────────────

describe('combined redaction in a realistic diff', () => {
  const DIFF = `
--- src/config.ts
+const API_KEY = "sk-ant-api03-SUPERSECRETKEY1234567890ABCDEFGHIJ";
+const DB_URL  = "postgresql://app:db_password_123@prod.internal:5432/users";
+const JWT_TOK = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3IifQ.abc-sig-here-xyz";
+// owner email: developer@company.com
+// Aadhaar: 2345 6789 0123
`;

  it('strips all PII types from a real-looking diff in one pass', () => {
    const r = redact(DIFF);
    expect(r).toContain('<REDACTED:api-key>');
    expect(r).toContain('<REDACTED:db-url>');
    expect(r).toContain('<REDACTED:jwt>');
    expect(r).toContain('<REDACTED:email>');
    expect(r).toContain('<REDACTED:aadhaar>');
    // None of the originals should survive
    expect(r).not.toContain('sk-ant-api03');
    expect(r).not.toContain('db_password_123');
    expect(r).not.toContain('eyJhbGci');
    expect(r).not.toContain('developer@company.com');
    expect(r).not.toContain('2345 6789 0123');
  });

  it('is idempotent: redacting twice produces the same result', () => {
    const once = redact(DIFF);
    const twice = redact(once);
    expect(twice).toBe(once);
  });
});

// ── performance (ReDoS bounds) ────────────────────────────────────────────────

describe('performance (bounded by 4 KB diff cap — no ReDoS risk)', () => {
  it('DB_CONN_RE finishes in <100ms on 4 KB of colons and slashes', () => {
    const adversarial = ('a://b:' + 'x'.repeat(400) + '@' + 'y'.repeat(400) + '/').repeat(3);
    const start = Date.now();
    redact(adversarial.slice(0, 4096));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('JWT_RE finishes in <100ms on 4 KB of base64url dots', () => {
    const adversarial = ('eyJ' + 'a'.repeat(300) + '.' + 'b'.repeat(300) + '.').repeat(5);
    const start = Date.now();
    redact(adversarial.slice(0, 4096));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('API_KEY_PREFIXES_RE finishes in <100ms on 4 KB of sk- patterns', () => {
    const adversarial = ('sk-' + 'a'.repeat(100)).repeat(30);
    const start = Date.now();
    redact(adversarial.slice(0, 4096));
    expect(Date.now() - start).toBeLessThan(100);
  });
});
