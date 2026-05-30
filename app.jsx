/* global React, ReactDOM, useTweaks, TweaksPanel,
   TweakSection, TweakRadio, TweakSelect, TweakToggle,
   NavBar, Footer, Hero, TheProblem, HowItWorks,
   WhatItLearns, Guardrails, UseAnywhere, Install, Faq, FinalCta,
   AsciiRain */

const { createContext, useContext, useEffect, useState } = React;

/* ============================================================
   Tweak defaults
   ============================================================ */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "acid",
  "atmosphere": "standard"
}/*EDITMODE-END*/;

/* ============================================================
   TweaksContext - components read via useTweakValues()
   ============================================================ */
const TweaksContext = createContext({ values: TWEAK_DEFAULTS, set: () => {} });
function useTweakValues() { return useContext(TweaksContext).values; }
function useTweakSet() { return useContext(TweaksContext).set; }
window.useTweakValues = useTweakValues;
window.useTweakSet = useTweakSet;

/* ============================================================
   Voice library - copy variants per voice tweak
   ============================================================ */
const COPY = {
  heroHeadline: "Every coding agent, writing like you.",
  heroCaption: "cc-habits  ·  v0.4.0  ·  open source",
  heroTagline: "It learns your style from the edits you already make, and feeds it back into every session, automatically.",
  heroSub:
    "A 100% local CLI that writes your style to a plain habits.md Claude reads every session. Every hook runs in under 50ms and never blocks your terminal. No lock-in.",
  problemCaption: "00  ·  why this exists",
  problemPull: "You've been training your agents all along. They just haven't been listening.",
  problemBody: [
    "Every developer has a fingerprint: the names you reach for, how you handle errors, the abstractions you prefer. None of it is in any prompt you've written.",
    "You generated a CLAUDE.md and moved on. That file captured what you said you wanted on the day you made it, not what you've shown Claude a hundred times since. It's stale. You never update it.",
    "cc-habits doesn't ask you to describe your style. It watches your edits. Every time you fix what Claude wrote, that's a signal. It collects them, finds the patterns, and writes it to a file Claude reads on every session, automatically."
  ],
  problemContrastLeft: "what the agent wrote",
  problemContrastRight: "what you changed it to",
  hiwCaption: "01  ·  how cc-habits works",
  hiwTitle: "A few hooks. One markdown file. Zero config.",
  hiwSub: "cc-habits plugs into your tool's lifecycle hooks, the same way across Claude Code, Gemini CLI, Codex, and Kimi. They run silently, execute in under 50ms, and never block your terminal.",
  hiwFooter: "The Capture and Submit hooks run locally in milliseconds. The session-end Stop hook makes a single small-model call. You choose the provider.",
  learnsCaption: "02  ·  what it learns",
  learnsTitle: "Your style, in plain markdown.",
  learnsBody: "habits.md is human-readable markdown. Read it, edit it, delete a rule, or commit it to git. The format is documented as an open spec, so you own your data.",
  guardCaption: "03  ·  accuracy",
  guardTitle: "Four guardrails so it won't poison your context.",
  portableCaption: "04  ·  portable",
  portableTitle: "Your habits aren't locked to one tool.",
  portableBody: [
    <span><strong><em>cch sync</em></strong> automatically translates your active habits into <code>AGENTS.md</code>, <code>.cursor/rules</code>, and <code>.clinerules</code>.</span>,
    "Learn your habits in whatever tool you're using today; use them across Claude Code, Gemini CLI, Codex, Kimi, Cursor, and Cline without re-learning."
  ],
  installCaption: "05  ·  install",
  installTitle: "Two commands. You're done.",
  installBody: <span><strong><em>cc-habits init</em></strong> walks you through picking a provider: Anthropic for the cheapest run, Ollama for a free local run, or OpenAI/Groq keys. It even offers to bootstrap habits from your past Claude Code sessions instantly.</span>,
  faqCaption: "06  ·  faq",
  faqTitle: "Common questions.",
  ctaTitle: "Make every agent write like you.",
};

/* ============================================================
   Fixed AsciiRain canvas - lives at app root, behind everything
   ============================================================ */
const RAIN_GLYPHS = "01<>[]/_-=+*.,;:#";

function RainBackground() {
  const t = useTweakValues();
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Atmosphere → density + opacity
    const atmo = t.atmosphere || "standard";
    const DENSITY = { calm: 0.6, standard: 1.0, storm: 1.5 }[atmo] || 1.0;
    const OPACITY = { calm: 0.13, standard: 0.22, storm: 0.36 }[atmo] || 0.22;

    let raf, swapTimer;
    let cells = [];
    let cols, rows, cellW, cellH;

    function readColors() {
      const styles = getComputedStyle(document.documentElement);
      return {
        dim: styles.getPropertyValue("--ink-dim").trim() || "#4A7A0A",
        accent: styles.getPropertyValue("--accent").trim() || "#00B7FF",
      };
    }
    let colors = readColors();

    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const baseCols = w < 700 ? 36 : 72;
      const baseRows = w < 700 ? 22 : 28;
      cols = Math.round(baseCols * DENSITY);
      rows = Math.round(baseRows * DENSITY);
      cellW = w / cols;
      cellH = h / rows;

      const rand = (function () { let s = 42; return () => { s = (s + 0x6D2B79F5) >>> 0; let x = Math.imul(s ^ (s >>> 15), s | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; })();
      cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ch = RAIN_GLYPHS[Math.floor(rand() * RAIN_GLYPHS.length)];
          const useAccent = rand() < 0.08;
          cells.push({ col: c, row: r, ch, alpha: 1, color: useAccent ? colors.accent : colors.dim });
        }
      }
      draw();
    }

    function draw() {
      const w = window.innerWidth, h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.font = `${Math.max(9, Math.min(13, cellH * 0.62))}px "JetBrains Mono", monospace`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      for (const cell of cells) {
        ctx.globalAlpha = cell.alpha * OPACITY;
        ctx.fillStyle = cell.color;
        ctx.fillText(cell.ch, cell.col * cellW + cellW / 2, cell.row * cellH + cellH / 2);
      }
      ctx.globalAlpha = 1;
    }

    function swap() {
      if (cells.length === 0) return;
      const n = Math.round(6 * DENSITY);
      const idxs = [];
      while (idxs.length < n) {
        const i = Math.floor(Math.random() * cells.length);
        if (!idxs.includes(i)) idxs.push(i);
      }
      const oldChars = idxs.map((i) => cells[i].ch);
      const newChars = idxs.map(() => RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)]);
      const start = performance.now();
      const dur = 200;
      const step = (now) => {
        const tp = Math.min(1, (now - start) / dur);
        idxs.forEach((i, k) => {
          const phase = tp < 0.5 ? 1 - tp * 2 : (tp - 0.5) * 2;
          cells[i].alpha = phase;
          cells[i].ch = tp >= 0.5 ? newChars[k] : oldChars[k];
        });
        draw();
        if (tp < 1) raf = requestAnimationFrame(step);
        else { idxs.forEach((i) => (cells[i].alpha = 1)); draw(); }
      };
      raf = requestAnimationFrame(step);
    }

    resize();
    if (!reduceMotion) {
      const interval = { calm: 7000, standard: 5000, storm: 3000 }[atmo] || 5000;
      swapTimer = setInterval(swap, interval);
    }

    let resizeRaf;
    const onResize = () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { colors = readColors(); resize(); }); };
    window.addEventListener("resize", onResize);

    // Recolor on palette change
    const mut = new MutationObserver(() => { colors = readColors(); for (let i = 0; i < cells.length; i++) { cells[i].color = (cells[i].color === colors.accent || cells[i].color === colors.dim) ? cells[i].color : (Math.random() < 0.08 ? colors.accent : colors.dim); } draw(); });
    mut.observe(document.body, { attributes: true, attributeFilter: ["data-palette"] });

    // Also redraw on palette change of body
    setTimeout(() => { colors = readColors(); resize(); }, 80);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      clearInterval(swapTimer);
      window.removeEventListener("resize", onResize);
      mut.disconnect();
    };
  }, [t.atmosphere, t.palette]);

  return <canvas ref={canvasRef} className="rain-canvas" aria-hidden="true" />;
}

/* ============================================================
   App
   ============================================================ */
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Hydrate from localStorage on first mount (cross-page persistence)
  useEffect(() => {
    try {
      const stored = localStorage.getItem("cch_palette");
      if (stored && stored !== t.palette) setTweak("palette", stored);
    } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply palette to <body> + persist to localStorage
  useEffect(() => {
    document.body.dataset.palette = t.palette || "acid";
    try { localStorage.setItem("cch_palette", t.palette || "acid"); } catch (e) {}
  }, [t.palette]);

  return (
    <TweaksContext.Provider value={{ values: t, set: setTweak }}>
      <RainBackground />
      <NavBar />
      <main>
        <Hero />
        <TheProblem />
        <HowItWorks />
        <WhatItLearns />
        <Guardrails />
        <UseAnywhere />
        <Install />
        <Faq />
        <FinalCta />
      </main>
      <Footer />

      <TweaksPanel>
        <TweakSection label="Palette" />
        <TweakToggle
          label="Night mode"
          value={t.palette === "crt"}
          onChange={(v) => setTweak("palette", v ? "crt" : "acid")}
        />
        <TweakSection label="Atmosphere" />
        <TweakRadio
          label="Energy"
          value={t.atmosphere}
          options={[
            { value: "calm", label: "calm" },
            { value: "standard", label: "std" },
            { value: "storm", label: "storm" },
          ]}
          onChange={(v) => setTweak("atmosphere", v)}
        />
      </TweaksPanel>
    </TweaksContext.Provider>
  );
}

window.COPY = COPY;
window.useTweakValues = useTweakValues;

const root = ReactDOM.createRoot(document.getElementById("app"));
root.render(<App />);
