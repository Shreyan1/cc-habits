/* global React */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ============================================================
   mulberry32 - deterministic PRNG (lib/seedRandom.ts)
   ============================================================ */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   Wordmark
   ============================================================ */
function Wordmark({ size = "1.25rem", showCursor = false, className = "" }) {
  return (
    <span
      className={`wordmark ${className}`}
      style={{ fontSize: size }}
      aria-label="cc-habits">
      cc-habits
      {showCursor ? <span className="wordmark__cursor" aria-hidden="true" /> : null}
    </span>
  );
}

/* ============================================================
   Buttons
   ============================================================ */
function ButtonPrimary({ children, onClick, className = "", as = "button", href, ...rest }) {
  const cls = `btn btn--primary ${className}`;
  if (as === "a") {
    return (
      <a className={cls} href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

function ButtonGhost({ children, onClick, className = "", as = "button", href, ...rest }) {
  const cls = `btn btn--ghost ${className}`;
  if (as === "a") {
    return (
      <a className={cls} href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button className={cls} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}

/* CopyButton - used by NavBar + Hero CTA */
function CopyCTA({
  text = "npm install -g cc-habits",
  label,
  compactLabel,
  variant = "primary",
  withArrow = true,
}) {
  const [state, setState] = useState("idle"); // idle | copied | error | flash
  const timer = useRef(null);

  const handleCopy = useCallback(async () => {
    let ok = false;
    // Try modern Async Clipboard API (works in https + same-origin)
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { /* fall through to legacy fallback */ }

    // Fallback for sandboxed iframes / file:// / older browsers
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
    }

    clearTimeout(timer.current);
    if (ok) {
      setState("flash");
      timer.current = setTimeout(() => setState("copied"), 80);
      setTimeout(() => setState("idle"), 1400);
    } else {
      setState("error");
      setTimeout(() => setState("idle"), 1400);
    }
  }, [text]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const display =
    state === "copied" || state === "flash"
      ? "copied!"
      : state === "error"
      ? "select & copy"
      : null;

  const extraClass =
    state === "flash" ? "btn--flash-accent" : state === "error" ? "btn--err" : "";

  const Btn = variant === "ghost" ? ButtonGhost : ButtonPrimary;
  return (
    <Btn onClick={handleCopy} className={extraClass}>
      {display || (
        <>
          <span className="btn__label btn__label--desktop">{label || text}</span>
          <span className="btn__label btn__label--mobile">{compactLabel || label || text}</span>
        </>
      )}
      {withArrow && state === "idle" ? (
        <span className="arr" aria-hidden="true">→</span>
      ) : null}
    </Btn>
  );
}

/* ============================================================
   NavBar
   ============================================================ */
/* ============================================================
   DayNightToggle - animated sun/moon swap, integrates with tweaks
   ============================================================ */
function DayNightToggle() {
  const t = window.useTweakValues ? window.useTweakValues() : { palette: "acid" };
  const setTweak = window.useTweakSet ? window.useTweakSet() : () => {};
  const isDark = t.palette === "crt";
  return (
    <button
      type="button"
      className="theme-toggle"
      data-state={isDark ? "dark" : "light"}
      onClick={() => setTweak("palette", isDark ? "acid" : "crt")}
      aria-label={isDark ? "Switch to day mode" : "Switch to night mode"}
      aria-pressed={isDark}
      title={isDark ? "Day mode" : "Night mode"}>
      <span className="theme-toggle__thumb" aria-hidden="true" />
      <span className="theme-toggle__icon theme-toggle__icon--sun" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14"
             fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      </span>
      <span className="theme-toggle__icon theme-toggle__icon--moon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14"
             fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
        </svg>
      </span>
    </button>
  );
}

/* ============================================================
   NavBar
   ============================================================ */
function NavBar() {
  const [scrolled, setScrolled] = useState(false);
  const [stars, setStars] = useState(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    fetch("https://api.github.com/repos/Shreyan1/cc-habits")
      .then((r) => r.json())
      .then((d) => { if (typeof d.stargazers_count === "number") setStars(d.stargazers_count); })
      .catch(() => {});
  }, []);

  return (
    <nav className={`nav ${scrolled ? "nav--scrolled" : ""}`}>
      <div className="container nav__inner">
        <a href="#top" aria-label="cc-habits home">
          <Wordmark size="1.1rem" showCursor />
        </a>
        <div className="nav__links">
          <a className="nav__link" href="docs.html">Docs</a>
          <a className="nav__link" href="docs.html#spec">Spec</a>
          <a
            className="nav__link"
            href="https://github.com/Shreyan1/cc-habits"
            target="_blank"
            rel="noreferrer">
            GitHub{stars !== null ? ` ★ ${stars}` : ""}
          </a>
          <a
            className="nav__link"
            href="https://www.npmjs.com/package/cc-habits"
            target="_blank"
            rel="noreferrer">
            npm
          </a>
        </div>
        <div className="nav__cta">
          <DayNightToggle />
          <CopyCTA label="npm install -g cc-habits" compactLabel="install" withArrow={false} />
        </div>
      </div>
    </nav>
  );
}

/* ============================================================
   TerminalPanel
   ============================================================ */
function TerminalPanel({ header, children, className = "", style }) {
  return (
    <div className={`terminal ${className}`} style={style}>
      {header ? <span className="terminal__header">{header}</span> : null}
      <div className="terminal__body">{children}</div>
    </div>
  );
}

/* ============================================================
   ConfidenceBar
   ============================================================ */
function ConfidenceBar({ value = 0, state = "active", showLabel = true }) {
  const pct = Math.round(value * 100);
  const fillRef = useRef(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) { setRevealed(true); return; }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setRevealed(true); return; }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setRevealed(true); io.disconnect(); }
    }, { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const fillClass =
    state === "learning"
      ? "cbar__fill--learning"
      : state === "pruning" || value < 0.30
      ? "cbar__fill--pruning"
      : "";
  return (
    <div className="habit__bar-row">
      <div ref={fillRef} className="cbar" aria-hidden="true">
        <div
          className={`cbar__fill ${fillClass}`}
          style={{ "--cbar-fill": revealed ? `${Math.max(0, Math.min(1, value)) * 100}%` : "0%" }}
        />
      </div>
      {showLabel ? <span className="cbar__label">{pct}%</span> : null}
    </div>
  );
}

/* ============================================================
   HabitCard
   ============================================================ */
function HabitCard({
  header,
  rule,
  pos = 0,
  neg = 0,
  since,
  confidence = 0,
  state = "active",
}) {
  return (
    <TerminalPanel header={header}>
      <div className="habit">
        <p className="habit__rule">{rule}</p>
        <div className="habit__meta">
          <span className="habit__pos">↑ {pos} reinforcing</span>
          <span className="habit__neg">↓ {neg} contradicting</span>
          {since ? <span className="habit__since">since {since}</span> : null}
        </div>
        <ConfidenceBar value={confidence} state={state} />
      </div>
    </TerminalPanel>
  );
}

/* ============================================================
   Footer
   ============================================================ */
function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__grid">
          <div className="footer__col">
            <Wordmark size="1.5rem" />
            <p className="footer__tagline">Claude Code, more personalized.</p>
          </div>
          <div className="footer__col">
            <h4>Product</h4>
            <ul>
              <li><a href="#docs">Docs</a></li>
              <li><a href="#spec">Spec</a></li>
              <li><a href="https://github.com/Shreyan1/cc-habits" target="_blank" rel="noreferrer">GitHub</a></li>
              <li><a href="https://www.npmjs.com/package/cc-habits" target="_blank" rel="noreferrer">npm</a></li>
            </ul>
          </div>
          <div className="footer__col">
            <h4>Built by</h4>
            <ul>
              <li><a href="https://github.com/Shreyan1" target="_blank" rel="noreferrer" style={{ fontSize: "1.0625rem", fontWeight: "700" }}>Shreyan Basu Ray</a></li>
              <li style={{ margin: "0.4rem 0" }}>
                <div className="footer__socials" style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                  <a href="https://github.com/Shreyan1" target="_blank" rel="noreferrer" title="GitHub" style={{ color: "var(--ink-muted-on-dark)", display: "inline-flex" }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="social-icon">
                      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path>
                    </svg>
                  </a>
                  <a href="https://www.linkedin.com/in/shreyanbasuray" target="_blank" rel="noreferrer" title="LinkedIn" style={{ color: "var(--ink-muted-on-dark)", display: "inline-flex" }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="social-icon">
                      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"></path>
                      <rect x="2" y="9" width="4" height="12"></rect>
                      <circle cx="4" cy="4" r="2"></circle>
                    </svg>
                  </a>
                </div>
              </li>
              <li style={{ margin: "0.4rem 0" }}>
                <a href="mailto:basurayshreyan@gmail.com" style={{ fontSize: "0.8125rem", color: "var(--ink-muted-on-dark)", textDecoration: "none" }}>basurayshreyan@gmail.com</a>
              </li>
              <li><span style={{ color: "var(--ink-dim-on-dark)", fontSize: "0.75rem" }}>MIT licensed</span></li>
            </ul>
          </div>
        </div>
        <div className="footer__bottom">
          <span>© 2026 cc-habits</span>
          <span>&lt;!-- cc-habits format v0.2 --&gt;</span>
        </div>
      </div>
    </footer>
  );
}

/* ============================================================
   Helpers - split text into per-word/per-char spans
   Words wrap at word boundaries; chars animate inside each word.
   ============================================================ */
function SplitText({ text, play = true, stagger = 60, className = "", as: As = "span" }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const spans = ref.current.querySelectorAll(".char");
    if (!play) {
      spans.forEach((s) => s.classList.remove("char--show"));
      return;
    }
    spans.forEach((s, i) => {
      setTimeout(() => s.classList.add("char--show"), i * stagger);
    });
  }, [play, stagger, text]);

  // Split into words; wrap each word as inline-block so browser breaks at spaces
  const words = useMemo(() => {
    // tokenise preserving spaces as separate tokens
    const tokens = text.split(/(\s+)/);
    let globalIdx = 0;
    return tokens.map((token, ti) => {
      if (/^\s+$/.test(token)) {
        // render whitespace as a plain text node (allows natural word-wrap)
        return <span key={`sp-${ti}`} style={{ display: "inline" }}>{token}</span>;
      }
      const wordSpans = [...token].map((ch) => {
        const idx = globalIdx++;
        return (
          <span key={idx} className="char">
            {ch}
          </span>
        );
      });
      return (
        <span key={`w-${ti}`} style={{ display: "inline-block", whiteSpace: "nowrap" }}>
          {wordSpans}
        </span>
      );
    });
  }, [text]);

  return (
    <As ref={ref} className={className}>
      {words}
    </As>
  );
}

/* ============================================================
   Share globally - Babel scripts each get isolated scope
   ============================================================ */
Object.assign(window, {
  mulberry32,
  Wordmark,
  ButtonPrimary,
  ButtonGhost,
  CopyCTA,
  NavBar,
  TerminalPanel,
  ConfidenceBar,
  HabitCard,
  Footer,
  SplitText,
});
