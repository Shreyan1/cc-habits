// ============================================================
// app.jsx
// ============================================================

const { createContext, useContext } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "acid",
  "atmosphere": "standard"
}/*EDITMODE-END*/;

const TweaksContext = createContext({ values: TWEAK_DEFAULTS, set: () => {} });
function useTweakValues() { return useContext(TweaksContext).values; }
function useTweakSet() { return useContext(TweaksContext).set; }
window.useTweakValues = useTweakValues;
window.useTweakSet = useTweakSet;

const COPY = {
  heroHeadline: "Every coding agent, writing like you.",
  heroCaption: "cc-habits  ·  v0.5.3  ·  open source",
  heroTagline: "It learns your style from the edits you already make, and feeds it back into every session, automatically.",
  heroSub:
    "A local-first CLI that writes your style to a plain habits.md every agent reads every session, across Claude Code, Gemini CLI, Codex, and Kimi. Capture runs locally with no network call and never blocks your terminal. No lock-in.",
  problemCaption: "00  ·  why this exists",
  problemPull: "You've been training your agents all along. They just haven't been listening.",
  problemBody: [
    "Every developer has a fingerprint: the names you reach for, how you handle errors, the abstractions you prefer. None of it is in any prompt you've written.",
    "You generated a CLAUDE.md or AGENTS.md and moved on. That file captured what you said you wanted on the day you made it, not what you've shown your tools a hundred times since. It's stale. You never update it.",
    "cc-habits doesn't ask you to describe your style. It watches your edits. Every time you fix what the agent wrote, that's a signal. It collects them, finds the patterns, and writes it to a file your tools read on every session, automatically."
  ],
  problemContrastLeft: "what the agent wrote",
  problemContrastRight: "what you changed it to",
  hiwCaption: "01  ·  how cc-habits works",
  hiwTitle: "A few hooks. One markdown file. Zero config.",
  hiwSub: "cc-habits plugs into your tool's lifecycle hooks. Capture fires on every edit, inject on every prompt, the same way in each tool, with no per-project setup.",
  hiwFooter: "The capture and inject hooks run locally in milliseconds. The session-end hook makes a single small-model call, and a session-start hook surfaces anything waiting for your review. You choose the provider.",
  capturesCaption: "02  ·  what it captures",
  capturesTitle: "Two kinds of memory, both in plain text.",
  capturesSub: "Habits are how you write code. Memories are the mistakes you don't want to repeat. cc-habits learns both from the edits you already make, and writes them to files you can read, edit, and own.",
  capturesBody: <span>Both are human-readable markdown you can read, edit, delete, or commit to git, documented as an open spec. Memories are opt-in, turned on with <strong><em>cch memories --enable</em></strong>. Same review queue, same tombstones, same files you own.</span>,
  guardCaption: "03  ·  accuracy",
  guardTitle: "Four guardrails so it won't poison your context.",
  perfCaption: "04  ·  performance  ·  measured, not claimed",
  perfTitle: "We profiled it. Here are the real numbers.",
  perfBody: "Every number here comes from benchmarking the actual hook binary, not a guess. The capture hook does its work in about five milliseconds. Nearly all of the rest is the Node runtime starting up, the same tax any CLI pays, and none of it blocks your session.",
  portableCaption: "05  ·  portable  ·  the standard that travels with you",
  portableTitle: "Your habits aren't locked to one tool.",
  portableBody: [
    <span><strong><em>cch sync</em></strong> writes your active habits into <code>AGENTS.md</code>, <code>.cursor/rules</code>, and <code>.clinerules</code>, and <strong><em>cch export/import</em></strong> moves a whole profile to a new machine or a teammate from a file or an <code>https://</code> URL.</span>,
    <span>Your habits are a portable asset you own, in an open format, not a setting trapped inside one vendor. A convention learned once can spread to a whole team, so the layer gets more valuable the more it is used.</span>
  ],
  installCaption: "06  ·  install",
  installTitle: "Two commands. You're done.",
  installBody: <span><strong><em>cch init</em></strong> detects your tools and walks you through picking a provider: Anthropic for the cheapest run, Ollama for a free local run, or OpenAI/Groq keys. It even offers to bootstrap habits from your past sessions instantly.</span>,
  faqCaption: "07  ·  faq",
  faqTitle: "Common questions.",
  ctaTitle: "Make every agent write like you.",
};

const RAIN_GLYPHS = "01<>[]/_-=+*.,;:#";

function RainBackground() {
  const t = useTweakValues();
  const canvasRef = React.useRef(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const atmo = t.atmosphere || "standard";
    const DENSITY = { calm: 0.6, standard: 1.0, storm: 1.5 }[atmo] || 1.0;
    const OPACITY = { calm: 0.10, standard: 0.15, storm: 0.26 }[atmo] || 0.15;

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

    const mut = new MutationObserver(() => { colors = readColors(); for (let i = 0; i < cells.length; i++) { cells[i].color = (cells[i].color === colors.accent || cells[i].color === colors.dim) ? cells[i].color : (Math.random() < 0.08 ? colors.accent : colors.dim); } draw(); });
    mut.observe(document.body, { attributes: true, attributeFilter: ["data-palette"] });

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

const LOGO_PATHS = {
  claude: { vb: "0 0 24 24", d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" },
  googlegemini: { vb: "0 0 24 24", d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" },
  openai: { vb: "0 0 24 24", d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
  kimi: { vb: "0 0 24 25", paths: ["M21.7202 0.939941C22.9502 0.939941 23.9502 1.93994 23.9502 3.16994C23.9502 4.39994 22.9502 5.39994 21.7202 5.39994H19.7502C19.6002 5.39994 19.4902 5.27994 19.4902 5.13994V3.16994C19.4902 1.93994 20.4902 0.939941 21.7202 0.939941Z", "M9.39 13.9501L17.82 5.59012C17.98 5.43012 17.89 5.12012 17.68 5.12012H13.14C13.14 5.12012 13.04 5.14012 13 5.18012L3.92 14.1901C3.78 14.3301 3.57 14.2101 3.57 13.9801V5.39012C3.57 5.24012 3.47 5.12012 3.35 5.12012H0.219999C0.0999993 5.12012 0 5.24012 0 5.39012V23.9201C0 24.0701 0.0999993 24.1901 0.219999 24.1901H3.35C3.47 24.1901 3.57 24.0701 3.57 23.9201V20.1401C3.57 20.0601 3.6 19.9801 3.65 19.9301L6.47 17.1401C6.54 17.0701 6.63 17.0601 6.71 17.1101L14.24 22.6501C15.47 23.4801 16.85 23.9901 18.25 24.1401C18.37 24.1501 18.48 24.0301 18.48 23.8701V20.3101C18.48 20.1701 18.4 20.0601 18.29 20.0501C17.47 19.9201 16.66 19.6001 15.94 19.1101L9.42 14.3901C9.28 14.3001 9.27 14.0701 9.39 13.9501Z"] },
  cursor: { vb: "0 0 24 24", d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" },
  cline: { vb: "0 0 24 24", d: "m23.365 13.556-1.442-2.895V8.994c0-2.764-2.218-5.002-4.954-5.002h-2.464c.178-.367.276-.779.276-1.213A2.77 2.77 0 0 0 12.018 0a2.77 2.77 0 0 0-2.763 2.779c0 .434.098.846.276 1.213H7.067c-2.736 0-4.954 2.238-4.954 5.002v1.667L.64 13.549c-.149.29-.149.636 0 .927l1.472 2.855v1.667C2.113 21.762 4.33 24 7.067 24h9.902c2.736 0 4.954-2.238 4.954-5.002V17.33l1.44-2.865c.143-.286.143-.622.002-.91m-12.854 2.36a2.27 2.27 0 0 1-2.261 2.273 2.27 2.27 0 0 1-2.261-2.273v-4.042A2.27 2.27 0 0 1 8.249 9.6a2.267 2.267 0 0 1 2.262 2.274zm7.285 0a2.27 2.27 0 0 1-2.26 2.273 2.27 2.27 0 0 1-2.262-2.273v-4.042A2.267 2.267 0 0 1 15.535 9.6a2.267 2.267 0 0 1 2.261 2.274z" },
  windsurf: { vb: "0 0 24 24", d: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z" },
  ollama: { vb: "0 0 24 24", d: "M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z" },
};

const INTEGRATIONS = [
  { name: "Claude Code", key: "claude" },
  { name: "Gemini CLI", key: "googlegemini" },
  { name: "Codex", key: "openai" },
  { name: "Kimi", key: "kimi" },
  { name: "Cursor", key: "cursor" },
  { name: "Cline", key: "cline" },
  { name: "Windsurf", key: "windsurf" },
  { name: "Ollama", key: "ollama" },
];

function LogoMark({ item }) {
  // Real inline brand marks (Simple Icons paths), tinted to the theme via
  // currentColor. A monospace initial badge covers any missing key.
  const logo = LOGO_PATHS[item.key];
  if (logo) {
    const ds = logo.paths || [logo.d];
    return (
      <svg className="mq__logo" viewBox={logo.vb} width="22" height="22"
           role="img" aria-label={item.name} fill="currentColor">
        {ds.map((d, i) => <path key={i} d={d} />)}
      </svg>
    );
  }
  return <span className="mq__badge" aria-hidden="true">{item.name[0]}</span>;
}

function LogoMarquee() {
  // Duplicate the list so the -50% translate loops seamlessly.
  const items = [...INTEGRATIONS, ...INTEGRATIONS];
  return (
    <section className="mq" aria-label="Supported tools and integrations">
      <div className="mq__caption">works with your whole toolchain</div>
      <div className="mq__viewport">
        <div className="mq__track">
          {items.map((item, i) => (
            <div className="mq__item" key={i}>
              <LogoMark item={item} />
              <span className="mq__name">{item.name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("cch_palette");
      if (stored && stored !== t.palette) setTweak("palette", stored);
    } catch (e) {}
  }, []);

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
        <LogoMarquee />
        <TheProblem />
        <HowItWorks />
        <WhatItCaptures />
        <Guardrails />
        <Performance />
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
