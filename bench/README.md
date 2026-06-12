# bench

Reproducible performance benchmarks for cc-habits. This is the "measured, not
claimed" backing for the numbers in the root README's **Performance** section
and the website's **the proof** section.

```bash
npm run bench
```

That builds `dist/` and runs `bench/run.mjs`, which exercises the real hook
binary (`dist/hook-entry.js`) and the real `redact()` function in a throwaway
store (it never touches your `~/.cc-habits`).

## What it measures

| Measurement | What it proves |
|---|---|
| Node startup baseline vs full hook | Most of a hook's wall time is Node booting, not our code |
| In-process capture work | The capture path (normalize + redact + append) is sub-5ms |
| Network behavior per event | Capture and inject make no network call; only Stop reaches the provider |
| Redaction latency (typical + adversarial, 4 KB and 64 KB) | Linear time, sub-millisecond under the 4 KB cap, no ReDoS |

Absolute numbers vary by hardware and Node version; the **shape** is the claim.

## Files

- `run.mjs`: the benchmark runner.
- `capture-entry.ts`: thin entry exposing one capture call over the real hook
  path, bundled on demand so the in-process timing excludes Node startup.
