/* global React, TerminalPanel */
const { useEffect, useRef } = React;

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
