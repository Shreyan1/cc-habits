/* global React, TerminalPanel */
const { useEffect, useRef, useState } = React;

/* ============================================================
   HowItWorks - static section, three panels side-by-side
   No sticky pin, no scroll-driven disintegration.
   Aligned with every other section's rhythm.
   ============================================================ */

const P1_TEXT =
`session 6f9a · users/auth.py

- def get_user(id):
+ def get_user(id: int) -> dict:

- msg = 'Hello ' + name
+ msg = f'Hello {name}'

written to log.jsonl
exits in <50ms`;

const P2_TEXT =
`$ claude session ended

cc-habits: analyzing 7 signals
cc-habits: extractor: haiku
cc-habits: learned 2, updated 3.

habits.md updated`;

function Panel3Body() {
  return (
    <div>
      <div style={{ marginBottom: "0.75rem", color: "var(--ink-dim)" }}>## Python</div>
      <div style={{ marginBottom: "0.25rem" }}>Add type hints to all function</div>
      <div style={{ marginBottom: "0.5rem" }}>parameters and return types.</div>
      <div style={{
        display: "flex", gap: "0.75rem", fontSize: "0.8125rem",
        marginBottom: "0.5rem", flexWrap: "wrap",
      }}>
        <span style={{ color: "var(--signal-pos)" }}>↑ 7 reinforcing</span>
        <span style={{ color: "var(--signal-neg)" }}>↓ 0 contradicting</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
        <div style={{ width: "100%", maxWidth: 180, height: 4, background: "color-mix(in oklab, var(--ink) 22%, transparent)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: "75%", background: "var(--ink)", borderRadius: 2 }} />
        </div>
        <span className="cbar__label">75%</span>
      </div>
      <div style={{ marginBottom: "0.5rem", color: "var(--learning)" }}>## Learning (not yet active)</div>
      <div style={{ marginBottom: "0.25rem" }}>[Naming] snake_case for</div>
      <div style={{ marginBottom: "0.5rem" }}>module-level functions.</div>
      <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.8125rem", marginBottom: "0.5rem" }}>
        <span style={{ color: "var(--signal-pos)" }}>↑ 1 reinforcing</span>
        <span style={{ color: "var(--signal-neg)" }}>↓ 0 contradicting</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <div style={{ width: "100%", maxWidth: 180, height: 4, background: "color-mix(in oklab, var(--ink) 22%, transparent)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: "50%", background: "var(--learning)", borderRadius: 2 }} />
        </div>
        <span className="cbar__label">50%</span>
      </div>
    </div>
  );
}

/* ============================================================
   LiveDemo - scroll-triggered two-panel session replay
   ============================================================ */
const LEFT_STEPS = [
  { text: "> src/api.ts", cls: "ldd-dim", t: 300 },
  { text: "", cls: "", t: 650 },
  { text: "- async function fetchUser(id) {", cls: "ldd-minus", t: 850 },
  { text: "+ async function fetchUser(id: string): Promise<User> {", cls: "ldd-plus", t: 1150 },
  { text: "", cls: "", t: 1450 },
  { text: "PostToolUse  ✓  signal captured", cls: "ldd-ok", t: 1650 },
  { text: "", cls: "", t: 2100 },
  { text: "> src/utils.ts", cls: "ldd-dim", t: 2300 },
  { text: "", cls: "", t: 2650 },
  { text: "- const data = fetch(url).then(r => r.json())", cls: "ldd-minus", t: 2850 },
  { text: "+ try {", cls: "ldd-plus", t: 3100 },
  { text: "+   const data = await fetch(url).then(r => r.json())", cls: "ldd-plus", t: 3250 },
  { text: "+ } catch(e) { throw new Error(`fetch: ${e.message}`) }", cls: "ldd-plus", t: 3400 },
  { text: "", cls: "", t: 3700 },
  { text: "PostToolUse  ✓  signal captured", cls: "ldd-ok", t: 3900 },
  { text: "", cls: "", t: 4350 },
  { text: "> src/auth.ts", cls: "ldd-dim", t: 4550 },
  { text: "", cls: "", t: 4900 },
  { text: "- function validate(token) {", cls: "ldd-minus", t: 5100 },
  { text: "+ function validate(token: string): boolean {", cls: "ldd-plus", t: 5400 },
  { text: "", cls: "", t: 5700 },
  { text: "PostToolUse  ✓  signal captured", cls: "ldd-ok", t: 5900 },
  { text: "", cls: "", t: 6400 },
  { text: "[session ended]", cls: "ldd-dim", t: 6600 },
  { text: "cc-habits: analyzing 3 signals...", cls: "ldd-accent", t: 7200 },
  { text: "cc-habits: learned 2 habits, updated 1.", cls: "ldd-accent", t: 8400 },
];

const RIGHT_STEPS = [
  { text: "~/.claude/habits/habits.md", cls: "ldd-dim", t: 8200 },
  { text: "", cls: "", t: 8600 },
  { text: "## TypeScript", cls: "ldd-section", t: 8800 },
  { text: "- Add explicit types to function parameters", cls: "", t: 9050 },
  { text: "  and return types.", cls: "", t: 9150 },
  { text: "  ↑ 2 reinforcing  ↓ 0 contradicting", cls: "ldd-ok", t: 9350 },
  { text: "  confidence: 0.60  (new ✦)", cls: "ldd-new", t: 9550 },
  { text: "", cls: "", t: 9800 },
  { text: "## Error Handling", cls: "ldd-section", t: 10000 },
  { text: "- Wrap async I/O in try/catch,", cls: "", t: 10200 },
  { text: "  throw descriptive errors.", cls: "", t: 10300 },
  { text: "  ↑ 1 reinforcing  ↓ 0 contradicting", cls: "ldd-ok", t: 10500 },
  { text: "  confidence: 0.50  (new ✦)", cls: "ldd-new", t: 10700 },
];

function LiveDemo() {
  const containerRef = useRef(null);
  const [started, setStarted] = useState(false);
  const [leftLines, setLeftLines] = useState([]);
  const [rightLines, setRightLines] = useState([]);
  const [leftDone, setLeftDone] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || started) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setLeftLines(LEFT_STEPS);
      setRightLines(RIGHT_STEPS);
      setLeftDone(true);
      return;
    }
    if (!("IntersectionObserver" in window)) {
      setStarted(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setStarted(true); io.disconnect(); }
    }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    const timers = LEFT_STEPS.map((step) =>
      setTimeout(() => setLeftLines((prev) => [...prev, step]), step.t)
    );
    const rightTimers = RIGHT_STEPS.map((step) =>
      setTimeout(() => setRightLines((prev) => [...prev, step]), step.t)
    );
    const doneTimer = setTimeout(
      () => setLeftDone(true),
      LEFT_STEPS[LEFT_STEPS.length - 1].t + 200
    );
    return () => {
      [...timers, ...rightTimers, doneTimer].forEach(clearTimeout);
    };
  }, [started]);

  const leftCursorVisible = started && !leftDone;

  return (
    <div ref={containerRef} className="live-demo">
      <div className="live-demo__panels">
        <TerminalPanel header="Claude Code session">
          <div className="live-demo__body">
            {leftLines.map((l, i) => (
              <div key={i} className={`ldd-line ${l.cls}`}>{l.text || " "}</div>
            ))}
            {leftCursorVisible && <span className="ldd-cursor" aria-hidden="true">▌</span>}
          </div>
        </TerminalPanel>

        <TerminalPanel header="~/.claude/habits/habits.md">
          <div className="live-demo__body">
            {rightLines.length === 0 && started && (
              <span className="ldd-dim">(empty — session still running...)</span>
            )}
            {rightLines.map((l, i) => (
              <div key={i} className={`ldd-line ${l.cls}`}>{l.text || " "}</div>
            ))}
          </div>
        </TerminalPanel>
      </div>
    </div>
  );
}

/* Each panel content as a multi-line div; preserves whitespace */
function PanelBody({ text }) {
  return (
    <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {text}
    </div>
  );
}

function HowItWorks() {
  const t = window.useTweakValues();
  const copy = window.COPY;
  const sectionRef = useRef(null);

  // Subtle entrance animation when section comes into view
  useEffect(() => {
    const sec = sectionRef.current;
    if (!sec) return;
    if (!("IntersectionObserver" in window)) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      sec.querySelectorAll(".hiw__panel").forEach((el) => el.classList.add("is-revealed"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((ent, i) => {
          if (ent.isIntersecting) {
            // Stagger reveal slightly so panels enter left → right
            const idx = [...ent.target.parentElement.children].indexOf(ent.target);
            setTimeout(() => ent.target.classList.add("is-revealed"), idx * 90);
            io.unobserve(ent.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    sec.querySelectorAll(".hiw__panel").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section
      id="how-it-works"
      ref={sectionRef}
      className="section section--lime hiw">
      <div className="container">
        <div className="section-head">
          <p className="t-caption ink-dim">{copy.hiwCaption}</p>
          <h2 className="t-display-2">{copy.hiwTitle}</h2>
          <p className="t-body" style={{ maxWidth: "64ch", color: "var(--ink-muted)" }}>
            {copy.hiwSub}
          </p>
        </div>

        <LiveDemo />

        <p className="t-caption ink-dim" style={{ marginBottom: "2.5rem", marginTop: "3rem" }}>
          under the hood
        </p>

        <div className="hiw__panels">
          <div className="hiw__panel">
            <TerminalPanel header="PostToolUse  ·  captures the diff">
              <PanelBody text={P1_TEXT} />
            </TerminalPanel>
            <p className="hiw__panel-cap">
              Every Write/Edit/MultiEdit captures a diff to <code>log.jsonl</code>. Under 50ms.
            </p>
          </div>

          <div className="hiw__panel">
            <TerminalPanel header="Stop  ·  extracts patterns">
              <PanelBody text={P2_TEXT} />
            </TerminalPanel>
            <p className="hiw__panel-cap">
              At session end, one small-model call extracts patterns into <code>habits.md</code>.
            </p>
          </div>

          <div className="hiw__panel">
            <TerminalPanel header="UserPromptSubmit  ·  re-asserts your habits">
              <Panel3Body />
            </TerminalPanel>
            <p className="hiw__panel-cap">
              Every new prompt re-injects your strongest active habits - surviving context compaction.
            </p>
          </div>
        </div>

        <p className="hiw__caption">{copy.hiwFooter}</p>
      </div>
    </section>
  );
}

Object.assign(window, { HowItWorks });
