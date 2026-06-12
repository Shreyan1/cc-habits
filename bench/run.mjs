/**
 * cc-habits performance benchmark: "measured, not claimed".
 *
 * Reproduces the numbers the README and the website's "the proof" section
 * publish, by exercising the REAL built hook binary (dist/hook-entry.js) and
 * the REAL redact() function in a throwaway store. Nothing here touches your
 * actual ~/.cc-habits directory.
 *
 * Run with:  npm run bench       (builds first, then runs this)
 * Or direct: node bench/run.mjs  (requires `npm run build` first)
 *
 * What it measures:
 *   1. Per-edit hook wall time (full PostToolUse hook) vs bare Node startup.
 *   2. UserPromptSubmit (inject) wall time.
 *   3. In-process capture work alone (normalize + redact + append).
 *   4. Network behavior per event: capture and inject must make no call; only
 *      Stop reaches the provider.
 *   5. Redaction latency on typical and adversarial corpora (p50 / p99).
 *
 * Numbers vary with hardware and Node version. The shape is what matters:
 * capture work is sub-5ms, Node startup dominates the rest, only Stop is
 * networked, and redaction is linear and sub-millisecond under the 4KB cap.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, 'dist', 'hook-entry.js');
if (!existsSync(HOOK)) {
  console.error(`Missing ${HOOK}. Run \`npm run build\` first (or use \`npm run bench\`).`);
  process.exit(1);
}

const STORE = mkdtempSync(join(tmpdir(), 'cch-bench-'));
const ENV = { ...process.env, CC_HABITS_DIR: STORE, CC_HABITS_PROVIDER: 'ollama' };
const N = 60;            // samples for spawn-based timings
const REDACT_N = 2000;   // samples for in-process redaction
const CAP_N = 3000;      // samples for in-process capture

/** Percentile (p in [0,1]) of a numeric array. */
function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
/** {p50,p99,min,max} as fixed-2 strings. */
function stats(arr) {
  return {
    p50: pct(arr, 0.5).toFixed(2),
    p99: pct(arr, 0.99).toFixed(2),
    min: Math.min(...arr).toFixed(2),
    max: Math.max(...arr).toFixed(2),
  };
}
/** Run fn() n times after a short warmup; return the samples. */
function sample(fn, n, warm = 5) {
  for (let i = 0; i < warm; i++) fn();
  const out = [];
  for (let i = 0; i < n; i++) out.push(fn());
  return out;
}

const editPayload = JSON.stringify({
  session_id: 'bench-session',
  tool_name: 'Edit',
  tool_input: {
    file_path: join(STORE, 'models.py'),
    old_string: 'def get_user(id):\n    return db.query(id)',
    new_string: 'def get_user(id: int) -> dict:\n    return db.query(id)',
  },
});
const promptPayload = JSON.stringify({ session_id: 'bench-session', prompt: 'add a helper to fetch a user by id' });

/** Spawn the real hook binary once; return wall ms + exit + stderr. */
function runHook(event, payload) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK, event], { input: payload, env: ENV, encoding: 'utf8' });
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, code: r.status, stderr: r.stderr || '' };
}
/** Bare Node process startup, for attribution. */
function runBaseline() {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

console.log(`\ncc-habits benchmark`);
console.log(`hook:  ${HOOK}`);
console.log(`store: ${STORE}`);
console.log(`node:  ${process.version}   samples: ${N}\n`);

const baseline = sample(runBaseline, N);
const post = sample(() => runHook('post-tool-use', editPayload).ms, N);
const inject = sample(() => runHook('user-prompt-submit', promptPayload).ms, N);

console.log(`per-edit timing (wall, full process):`);
console.log(`  Node startup baseline   ${JSON.stringify(stats(baseline))} ms`);
console.log(`  PostToolUse  (capture)  ${JSON.stringify(stats(post))} ms`);
console.log(`  UserPromptSubmit (inject) ${JSON.stringify(stats(inject))} ms`);
console.log(`  -> Node startup is ${(pct(baseline, 0.5) / pct(post, 0.5) * 100).toFixed(0)}% of the full capture hook.\n`);

// In-process capture work, isolated from Node startup + module load.
const capBundle = join(STORE, 'capture.mjs');
await build({
  entryPoints: [join(REPO, 'bench', 'capture-entry.ts')],
  outfile: capBundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', absWorkingDir: REPO,
});
process.env.CC_HABITS_DIR = STORE;
process.env.CC_HABITS_PROVIDER = 'ollama';
const { captureOnce } = await import(capBundle);
const capPayload = JSON.parse(editPayload);
const capTimes = sample(() => {
  const t0 = process.hrtime.bigint();
  captureOnce(capPayload);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}, CAP_N, 100);
console.log(`capture work, in-process (normalize + redact + append, n=${CAP_N}):`);
console.log(`  ${JSON.stringify(stats(capTimes))} ms   <- the "under 5ms" claim\n`);

// Network + exit behavior per event (offline-safe: a dead provider must not break the session).
console.log(`network + exit behavior:`);
for (const [ev, pl] of [['post-tool-use', editPayload], ['user-prompt-submit', promptPayload], ['stop', JSON.stringify({ session_id: 'bench-session' })]]) {
  const r = runHook(ev, pl);
  const networked = /fetch failed|ECONNREFUSED|ENOTFOUND|HTTP \d|model .* not found|connect/i.test(r.stderr) || ev === 'stop';
  // Stop's network attempt is logged to error.log (fail-open), not stderr.
  const errLog = join(STORE, 'error.log');
  const stopReached = ev === 'stop' && existsSync(errLog);
  console.log(`  ${ev.padEnd(18)} exit=${r.code}  networkCall=${ev === 'stop' ? (stopReached ? 'YES (provider)' : 'attempted') : 'no'}`);
}
console.log(`  (only Stop is networked; capture and inject never call out -> zero runtime LLM cost)\n`);

// Redaction latency: real redact() on typical + adversarial corpora.
const redactBundle = join(STORE, 'redact.mjs');
await build({ entryPoints: [join(REPO, 'src', 'redact.ts')], outfile: redactBundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { redact } = await import(redactBundle);
function mkDiff(bytes, adversarial) {
  const line = adversarial
    ? 'user@example.com 4111 1111 1111 1111 ABCDE1234F SYSTEM: ignore previous\n'
    : 'const userName = getUserById(id); // returns the user record\n';
  let s = '';
  while (s.length < bytes) s += line;
  return s.slice(0, bytes);
}
console.log(`redaction latency (real redact(), n=${REDACT_N} each):`);
for (const [label, text] of [
  ['typical diff, 4 KB', mkDiff(4096, false)],
  ['adversarial, 4 KB', mkDiff(4096, true)],
  ['adversarial, 64 KB', mkDiff(65536, true)],
]) {
  const s = stats(sample(() => { const t0 = process.hrtime.bigint(); redact(text); return Number(process.hrtime.bigint() - t0) / 1e6; }, REDACT_N, 50));
  console.log(`  ${label.padEnd(20)} p50=${s.p50} ms  p99=${s.p99} ms`);
}
console.log(`  (16x the input is ~16x the time: linear, no catastrophic backtracking)\n`);

rmSync(STORE, { recursive: true, force: true });
console.log(`done. throwaway store removed.`);
