// ============================================================
// sections.jsx
// ============================================================

function useCopy() {
  return COPY;
}

function TheProblem() {
  const copy = useCopy();
  return (
    <section id="why" className="problem section--dark">
      <div className="container">
        <div className="problem__grid">
          <div>
            <p className="t-caption ink-dim">{copy.problemCaption}</p>
            <h2 className="problem__pull" style={{ marginTop: "1.25rem" }}>
              {copy.problemPull}
            </h2>
          </div>

          <div className="problem__body">
            {copy.problemBody.map((para, i) =>
              <p key={i} className="t-body">
                {para}
              </p>
            )}
          </div>
        </div>

        <div className="problem__contrast">
          <TerminalPanel header={copy.problemContrastLeft}>
            <div style={{ color: "var(--ink-muted-on-dark)", marginBottom: "0.5rem" }}>users/auth.py</div>
            <div>def get_user(id):</div>
            <div>{"    return db.query(id)"}</div>
            <div style={{ marginTop: "0.75rem" }}>msg = 'Hello ' + name</div>
            <div>print(msg)</div>
          </TerminalPanel>

          <TerminalPanel header={copy.problemContrastRight}>
            <div style={{ color: "var(--ink-muted-on-dark)", marginBottom: "0.5rem" }}>users/auth.py</div>
            <div>def get_user(id: int) -&gt; dict:</div>
            <div>{"    return db.query(id)"}</div>
            <div style={{ marginTop: "0.75rem" }}>msg = f'Hello {"{name}"}'</div>
            <div>print(msg)</div>
            <div style={{ marginTop: "1rem", color: "var(--accent)", fontSize: "0.8125rem" }}>
              → type hints &nbsp; → f-strings
            </div>
          </TerminalPanel>
        </div>
      </div>
    </section>
  );
}

function WhatItLearns() {
  const copy = useCopy();
  return (
    <section id="what-it-learns" className="section section--dark">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.learnsCaption}</p>
          <h2 className="t-display-2">{copy.learnsTitle}</h2>
        </div>

        <div className="habits-grid">
          <HabitCard
            header="## Python"
            rule="Add type hints to all function parameters and return types."
            pos={7}
            neg={0}
            since="2026-02-12"
            confidence={0.75} />
          
          <HabitCard
            header="## Error Handling"
            rule="Wrap external I/O in try/except and re-raise as RuntimeError."
            pos={4}
            neg={1}
            since="2026-03-04"
            confidence={0.55} />
          
          <HabitCard
            header="## Naming"
            rule="snake_case for module-level functions, PascalCase for types."
            pos={6}
            neg={0}
            since="2026-01-28"
            confidence={0.65} />
        </div>

        <p
          className="t-body mt-8"
          style={{ maxWidth: "62ch", color: "var(--ink-muted-on-dark)" }}>
          {copy.learnsBody}
        </p>

        <div className="mt-4">
          <ButtonGhost
            as="a"
            href="docs.html#spec"
            target="_blank"
            rel="noreferrer">
            View the spec <span className="arr" aria-hidden="true">→</span>
          </ButtonGhost>
        </div>
      </div>
    </section>
  );
}

function MemoryCard({ header, when, caution, correction }) {
  return (
    <TerminalPanel header={header}>
      <div className="memory">
        <p className="memory__when">when {when}</p>
        <p className="memory__caution">{caution}</p>
        {correction ? <p className="memory__fix">→ {correction}</p> : null}
      </div>
    </TerminalPanel>
  );
}

function Memories() {
  const copy = useCopy();
  return (
    <section id="memories" className="section">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.memoriesCaption}</p>
          <h2 className="t-display-2">{copy.memoriesTitle}</h2>
        </div>

        <div className="habits-grid">
          <MemoryCard
            header="## Async"
            when="calling an async function"
            caution="Used the promise as a value, forgot to await."
            correction="await the call, or return the promise." />

          <MemoryCard
            header="## SQL"
            when="building a query from input"
            caution="Interpolated a variable straight into the SQL string."
            correction="use a parameterized query." />

          <MemoryCard
            header="## Resources"
            when="opening a file or socket"
            caution="Left the handle open on the error path."
            correction="close it in finally, or use a context manager." />
        </div>

        <p
          className="t-body mt-8"
          style={{ maxWidth: "64ch", color: "var(--ink-muted)" }}>
          {copy.memoriesBody}
        </p>

        <div className="mt-4">
          <ButtonGhost
            as="a"
            href="docs.html#memories"
            target="_blank"
            rel="noreferrer">
            How memories work <span className="arr" aria-hidden="true">→</span>
          </ButtonGhost>
        </div>
      </div>
    </section>
  );
}

const GUARDRAILS = [
  {
    n: "01",
    title: "Two-session promotion.",
    body: "A new habit lives in ## Learning and is invisible to Claude until you reinforce it in a second distinct session."
  },
  {
    n: "02",
    title: "Tombstones are forever.",
    body: "Delete a rule by hand and .tombstones.json makes sure it never comes back."
  },
  {
    n: "03",
    title: "Confidence decays.",
    body: "A habit you've stopped following loses 0.05 per week after a 7-day grace period, then gets pruned below 0.30."
  },
  {
    n: "04",
    title: "Preview before apply.",
    body: "cch pending shows queued updates; --approve or --discard is yours to call."
  }
];

function Guardrails() {
  const copy = useCopy();
  return (
    <section id="guardrails" className="section section--lime">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.guardCaption}</p>
          <h2 className="t-display-2">{copy.guardTitle}</h2>
        </div>

        <ul className="guardrails">
          {GUARDRAILS.map((g) =>
            <li key={g.n} className="guardrail">
              <span className="t-caption guardrail__num">{g.n}</span>
              <p className="guardrail__title">{g.title}</p>
              <p className="t-body guardrail__body">{g.body}</p>
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

/* ============================================================
   04 - Performance (measured, not claimed)
   ============================================================ */
const PERF_ROWS = [
  ["Node startup", "interpreter boot, not our code", "~40 ms"],
  ["Module load", "cc-habits bundle evaluates", "~27 ms"],
  ["Capture work", "parse, redact, append signal", "~5 ms"],
  ["Full hook", "end to end, per edit", "~72 ms"]
];

const PERF_NETWORK = [
  ["PostToolUse", "every edit", "no network"],
  ["UserPromptSubmit", "every prompt", "no network"],
  ["Stop", "once / session", "1 small-model call"]
];

function Performance() {
  const copy = useCopy();
  const rowStyle = {
    display: "flex", justifyContent: "space-between", alignItems: "baseline",
    flexWrap: "wrap", gap: "0.25rem 1rem", padding: "0.625rem 0",
    borderBottom: "0.5px solid rgba(255,255,255,.14)",
    fontSize: "0.875rem", fontFamily: "var(--font-mono)"
  };
  return (
    <section id="performance" className="section section--dark">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.perfCaption}</p>
          <h2 className="t-display-2">{copy.perfTitle}</h2>
        </div>

        <div className="portable__grid">
          <div className="portable__copy">
            <p className="t-body">{copy.perfBody}</p>

            <div style={{ marginTop: "1.5rem", borderTop: "0.5px solid rgba(255,255,255,.14)" }}>
              {PERF_ROWS.map((r, i) =>
                <div key={i} style={rowStyle}>
                  <span style={{ flex: "1 1 7rem" }}>{r[0]}</span>
                  <span style={{ color: "var(--ink-muted-on-dark)", flex: "2 1 10rem" }}>{r[1]}</span>
                  <span style={{ color: "var(--accent)" }}>{r[2]}</span>
                </div>
              )}
            </div>

            <p className="t-caption ink-dim" style={{ marginTop: "1rem" }}>
              Measured on the real hook binary. Node 26, Apple Silicon, n=60 per event, isolated store. p99 ~92 ms.
            </p>
          </div>

          <TerminalPanel header="network calls per session">
            {PERF_NETWORK.map((r, i) =>
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem 1rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
                <span>{r[0]}</span>
                <span style={{ color: "var(--ink-muted-on-dark)" }}>{r[1]}</span>
                <span style={{ color: r[2] === "no network" ? "var(--accent)" : "inherit" }}>{r[2]}</span>
              </div>
            )}
            <div style={{ marginTop: "0.75rem", color: "var(--ink-muted-on-dark)", fontSize: "0.8125rem" }}>
              Signals capped at 50 + 180 KB to bound that one call.
            </div>
          </TerminalPanel>
        </div>
      </div>
    </section>
  );
}

function UseAnywhere() {
  const copy = useCopy();
  return (
    <section id="portable" className="section section--dark">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.portableCaption}</p>
          <h2 className="t-display-2">{copy.portableTitle}</h2>
        </div>

        <div className="portable__grid">
          <div className="portable__copy">
            {copy.portableBody.map((para, i) =>
              <p key={i} className="t-body">{para}</p>
            )}
            <div className="directory-tree">
              <div className="tree-line">
                <span className="root">your-project/</span>
              </div>
              <div className="tree-line">
                <span>├──</span> <span className="file">AGENTS.md</span>
                <span className="comment"># cross-tool standard - read by Codex, Amp, Aider</span>
              </div>
              <div className="tree-line">
                <span>├──</span> <span className="file">.clinerules</span>
                <span className="comment"># Cline's project rules</span>
              </div>
              <div className="tree-line">
                <span>└──</span> <span className="folder">.cursor/</span>
              </div>
              <div className="tree-line indent">
                <span>└──</span> <span className="folder">rules/</span>
                <span className="comment"># Cursor's rule directory</span>
              </div>
            </div>
          </div>

          <TerminalPanel header="AGENTS.md  ·  generated by cch sync">
            <div style={{ color: "var(--ink-muted-on-dark)" }}>{"<!-- BEGIN cc-habits -->"}</div>
            <div style={{ marginTop: "0.5rem" }}># Coding habits</div>
            <div style={{ marginTop: "0.75rem" }}>## Python</div>
            <div style={{ marginTop: "0.25rem" }}>- Add type hints to all function</div>
            <div>{"  parameters and return types."}</div>
            <div style={{ marginTop: "0.5rem" }}>- Use f-strings instead of</div>
            <div>{"  .format() or concatenation."}</div>
            <div style={{ marginTop: "0.75rem" }}>## Error Handling</div>
            <div style={{ marginTop: "0.25rem" }}>- Wrap external I/O in try/except</div>
            <div>{"  and re-raise as RuntimeError."}</div>
            <div style={{ marginTop: "0.75rem", color: "var(--ink-muted-on-dark)" }}>{"<!-- END cc-habits -->"}</div>
          </TerminalPanel>
        </div>
      </div>
    </section>
  );
}

function Install() {
  const copy = useCopy();
  return (
    <section id="install" className="section section--lime">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.installCaption}</p>
          <h2 className="t-display-2">{copy.installTitle}</h2>
        </div>

        <div className="install-stack">
          <TerminalPanel header="terminal">
            <div style={{ color: "var(--ink-dim)" }}>$ npm install -g cc-habits@latest</div>
            <div style={{ color: "var(--ink-dim)", marginTop: "0.25rem" }}>$ cch init</div>
            <div style={{ marginTop: "0.75rem", color: "var(--ink-muted)", fontSize: "0.8125rem" }}>
              {"> picked anthropic/haiku as extractor"}
            </div>
            <div style={{ color: "var(--ink-muted)", fontSize: "0.8125rem" }}>
              {"> wrote ~/.claude/settings.json"}
            </div>
            <div style={{ color: "var(--ink-muted)", fontSize: "0.8125rem" }}>
              {"> imported 4 past sessions"}
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <span style={{ color: "var(--accent)" }}>ready.</span>
            </div>
          </TerminalPanel>

          <div>
            <p className="t-body" style={{ maxWidth: "48ch", color: "var(--ink-muted)" }}>
              {copy.installBody}
            </p>

            <div style={{ marginTop: "1.5rem", borderTop: "0.5px solid var(--rule)" }}>
              {[
                ["Anthropic Haiku", "~$0.09 / month"],
                ["Ollama (local)", "$0"],
                ["OpenAI / Groq", "your key"]
              ].map(([k, v], i) =>
              <div key={i} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                flexWrap: "wrap",
                gap: "0.5rem 1rem",
                padding: "0.625rem 0",
                borderBottom: "0.5px solid var(--rule)",
                fontSize: "0.875rem",
                  fontFamily: "var(--font-mono)"
                }}>
                  <span style={{ color: "var(--ink)" }}>{k}</span>
                  <span style={{ color: "var(--ink-muted)" }}>{v}</span>
                </div>
              )}
            </div>

            <div className="mt-4" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <CopyCTA label="npm install -g cc-habits@latest" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const FAQ_GROUPS = [
  {
    group: "using it",
    items: [
      {
        q: "Does this work across all my projects?",
        a: <span>Yes. Hooks live in each tool's settings (for example <code>~/.claude/settings.json</code> or <code>~/.gemini/settings.json</code>) and your habits in <code>~/.cc-habits/</code>, all user-level. Everything is global by default, with no per-project setup.</span>
      },
      {
        q: "I already auto-generate a CLAUDE.md. Does this replace it?",
        a: <span>No. It fills the gap. <strong><em>cch init</em></strong> adds a single <code>@import</code> line to your existing <code>~/.claude/CLAUDE.md</code> and overwrites nothing. Your generated file stays; cc-habits keeps it current with what you actually do.</span>
      },
      {
        q: "Will it slow down or break my coding sessions?",
        a: "No. The capture and inject hooks run locally with no network call, and the capture work itself takes a few milliseconds. Every hook is wrapped in try/catch and exits 0 on error, so cc-habits can never fail or block a session."
      },
      {
        q: "What if it learns the wrong thing?",
        a: <span>A new habit sits in <code>## Learning</code>, invisible to your agent, until you repeat it in a second distinct session. Delete a rule and a tombstone blocks it forever; unused habits decay and get pruned. Run <strong><em>cch pending</em></strong> to approve or discard before anything applies.</span>
      },
      {
        q: "Do I need a separate API key on top of my coding-tool plan?",
        a: "They're separate purchases. If you only have a tool subscription, run with Ollama: free and fully local, no key required. Anthropic Haiku (~$0.09/mo), OpenAI, and Groq are also supported."
      }
    ]
  },
  {
    group: "privacy & data",
    items: [
      {
        q: "What actually leaves my machine?",
        a: "Exactly one call per session: the Stop hook sends a redacted batch of signals to your chosen provider, using your own key. Emails, Indian PAN numbers, and Luhn-valid credit-card numbers are stripped before anything leaves."
      },
      {
        q: "Does cc-habits phone home?",
        a: "Never. There's no cc-habits server, no telemetry, no analytics, no error-reporting endpoint. The only outbound call is the extractor call to the provider you pick."
      },
      {
        q: "Am I the data controller? (GDPR / DPDP / CCPA)",
        a: <span>Yes. Everything lives in your home directory and the only outbound call uses your own key, so you are both controller and processor. In regulated setups, set your provider key via a secrets manager and don't sync <code>~/.cc-habits/</code> across machines.</span>
      },
      {
        q: "Can I run it offline, and how do I wipe everything?",
        a: <span>Signal capture works offline; if extraction can't reach the API the Stop hook logs the error and exits 0, no signals lost. To clear everything, run <strong><em>cch reset --yes</em></strong> (tombstones survive, so deleted rules never return).</span>
      }
    ]
  }
];

function Faq() {
  const copy = useCopy();
  return (
    <section id="faq" className="section section--lime">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.faqCaption}</p>
          <h2 className="t-display-2">{copy.faqTitle}</h2>
        </div>

        <div className="faq">
          {FAQ_GROUPS.map((grp, gi) =>
            <div key={gi} className="faq__group">
              <p className="t-caption ink-dim faq__group-head">{grp.group}</p>
              {grp.items.map((f, i) =>
                <details key={i}>
                  <summary>{f.q}</summary>
                  <p className="faq__body">{f.a}</p>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  const copy = useCopy();
  return (
    <section id="cta" className="section section--dark">
      <div className="container">
        <div className="final-cta">
          <h2 className="t-display-1 final-cta__title">{copy.ctaTitle}</h2>
          <div className="final-cta__buttons">
            <CopyCTA label="npm install -g cc-habits@latest" />
            <ButtonGhost
              as="a"
              href="https://github.com/Shreyan1/cc-habits"
              target="_blank"
              rel="noreferrer">
              GitHub <span className="arr" aria-hidden="true">→</span>
            </ButtonGhost>
          </div>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, {
  TheProblem,
  WhatItLearns,
  Memories,
  Guardrails,
  Performance,
  UseAnywhere,
  Install,
  Faq,
  FinalCta
});
