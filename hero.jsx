// ============================================================
// hero.jsx
// ============================================================

const { useEffect: useEffectHero, useState: useStateHero } = React;

function Hero() {
  const t = window.useTweakValues();
  const copy = COPY;
  const [playWordmark, setPlayWordmark] = useStateHero(false);

  useEffectHero(() => {
    const played = sessionStorage.getItem("cch_wordmark_played") === "1";
    if (!played) {
      sessionStorage.setItem("cch_wordmark_played", "1");
      const t2 = setTimeout(() => setPlayWordmark(true), 80);
      return () => clearTimeout(t2);
    } else {
      setPlayWordmark(true);
    }
  }, []);

  return (
    <section id="top" className="hero section--lime">
      <div className="container hero__inner">
        <div className="hero__brand">
          <Wordmark size="1.45rem" className="hero__logo" blink />
          <span className="hero__badge">v0.9.0</span>
          <span className="hero__badge">open source</span>
        </div>

        <h1 className="t-display-1 hero__headline">
          <SplitText
            text={copy.heroHeadline}
            play={playWordmark}
            stagger={45} />
          
        </h1>

        <p className="t-h3 hero__tagline">{copy.heroTagline}</p>

        <p className="t-body hero__sub">{copy.heroSub}</p>

        <div className="hero__ctas">
          <CopyCTA label="npm install -g cc-habits@latest" />
          <ButtonGhost as="a" href="#how-it-works">
            How it works <span className="arr" aria-hidden="true">→</span>
          </ButtonGhost>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Hero });
