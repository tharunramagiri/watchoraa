import { useEffect, useRef, type ReactNode } from 'react';

// Watchora landing page — the logged-out front door, restyled in the "Wispr Flow"
// editorial system: warm cream broadsheet (#ffffeb), dark velvet chambers
// (#1a1a1a), EB Garamond at display scale (weight 400, 64–120px), Figtree for all
// UI, lavender (#f0d7ff) as the sole primary-action color, forest teal (#034f46)
// for secondary badges, 2px ink borders everywhere, oversized corner radii, and a
// deliberately shadowless, border-driven editorial flatness.
//
// Sections alternate cream → dark → cream → dark like rooms in a building. The
// waveform visualizer (a signature of the Wispr system) is a natural fit here:
// watchora is a camera-to-voice app, so the "mic is listening" motif doubles as
// honest product communication.

type LandingProps = {
  onSignIn: () => void;
  onSignUp: () => void;
};

function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            el.classList.add('active');
            observer.unobserve(el);
          }
        });
      },
      { rootMargin: '0px 0px -40px 0px', threshold: 0.12 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="wispr-reveal" style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

// Waveform visualizer — Wispr signature: vertical bars of varying height in a
// cream pill with a 2px ink border. Doubles as watchora's "listening" motif.
function Waveform({ dark = false }: { dark?: boolean }) {
  const heights = [10, 18, 26, 34, 22, 30, 14, 24, 16];
  return (
    <span className={`wispr-waveform ${dark ? 'wispr-waveform-dark' : ''}`} aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} style={{ height: `${h}px` }} />
      ))}
    </span>
  );
}

// Hand-drawn lavender underline accent — Wispr signature for key headline words.
function Squiggle() {
  return (
    <svg className="wispr-squiggle" width="240" height="18" viewBox="0 0 240 18" fill="none" aria-hidden="true">
      <path
        d="M4 12 C 30 4, 55 16, 82 10 S 132 4, 158 10 S 208 16, 236 8"
        stroke="#f0d7ff"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

const MODES = ['Navigation', 'Reading', 'Environment', 'Assistant'];

const FEATURES = [
  {
    title: 'Camera-to-voice AI',
    body: 'Real Gemini vision calls, server-side, spoken aloud. Summary, details, warnings, and confidence — never a wall of text.',
    tag: 'Four modes',
  },
  {
    title: 'Local hazard layer',
    body: 'YOLO object detection runs on your device the moment the camera is on. Sub-second, offline, private — and it never leaves your phone.',
    tag: 'On-device',
  },
  {
    title: 'Read text, even offline',
    body: 'Local OCR reads signs, labels, and documents in seconds with zero network. Low confidence falls back to the cloud read instead of guessing.',
    tag: 'Offline-first',
  },
  {
    title: 'SOS that never lies',
    body: 'Emergency requests are a deterministic log, separate from AI scene analysis. Trusted contacts get real SMS and email alerts, and the app tells you exactly what was delivered.',
    tag: 'Trust',
  },
  {
    title: 'Money, colors, expiry dates',
    body: 'Say "what money is this", "what color is this", or "read the expiry" — daily tasks done by voice. It never guesses between two similar banknotes and always says when lighting makes it unsure.',
    tag: 'Daily living',
  },
  {
    title: 'A companion, not a command line',
    body: 'Say "I\'m scared" or "I feel lost" and Watchora responds with practical help, right on your device — never sent anywhere, never interrupting a safety alert.',
    tag: 'With you',
  },
];

const PRINCIPLES = [
  {
    title: 'Uncertainty is never hidden',
    body: 'The model never claims a path is definitely safe, never tells you to cross a road from camera analysis alone, and never states an exact distance unless it is directly measurable. Low confidence means the warning says so — out loud.',
  },
  {
    title: 'Fail silent, not fail loud',
    body: 'When detection confidence drops, nothing fires rather than guessing. A wrong vibration at a curb is worse than no vibration at all.',
  },
  {
    title: 'Your data stays yours',
    body: 'Camera frames are processed in memory and discarded after each request. Your Gemini key never leaves the server. Rate limits and size caps are enforced.',
  },
];

const CHECKLIST = [
  'Free account — real row in Postgres, no seeded demo data',
  'Installable PWA — add it to your home screen',
  'Trusted contacts, saved places, SOS history, community reports',
];

export function LandingPage({ onSignIn, onSignUp }: LandingProps) {
  return (
    <main className="wispr">
      <a
        className="wispr-skip"
        href="#wispr-features"
        onClick={(e) => {
          // Same real fix as the dashboard skip link (App.tsx): a bare
          // hash-link scrolls but does not reliably move keyboard/screen-
          // reader focus in every browser, so the skip link does not
          // actually let a screen-reader user skip the nav/hero content.
          e.preventDefault();
          document.getElementById('wispr-features')?.focus();
        }}
      >
        Skip to what watchora does
      </a>

      {/* Floating nav pill */}
      <nav className="wispr-nav" aria-label="Primary">
        <div className="wispr-nav-pill">
          <a className="wispr-wordmark" href="#wispr-top">
            <Waveform />
            <span className="wispr-wordmark-name">watchora</span>
          </a>
          <a className="wispr-nav-link" href="#wispr-features">
            What it does
          </a>
          <a className="wispr-nav-link" href="#wispr-safety">
            How it stays safe
          </a>
          <span className="wispr-nav-divider" aria-hidden="true" />
          <button className="wispr-nav-ghost" onClick={onSignIn}>
            Sign in
          </button>
          <button className="wispr-cta wispr-cta-nav" onClick={onSignUp}>
            Create account
          </button>
        </div>
      </nav>

      {/* ── Cream chamber: hero ─────────────────────────────── */}
      <header id="wispr-top" className="wispr-hero">
        <div className="wispr-hero-inner">
          <Reveal>
            <span className="wispr-badge wispr-badge-teal">
              <span className="wispr-badge-dot" aria-hidden="true" />
              Camera-to-voice · Real accounts, not demos
            </span>
          </Reveal>

          <Reveal delay={80}>
            <h1 className="wispr-display">
              Point the camera.
              <br />
              <span className="wispr-display-muted">Hear what's there.</span>
              <span className="wispr-underline-wrap">
                <Squiggle />
              </span>
            </h1>
          </Reveal>

          <Reveal delay={160}>
            <p className="wispr-lede">
              Watchora turns a phone camera into a spoken second pair of eyes —
              navigation, reading, and environment description, with trusted contacts,
              SOS, and community hazard reports.
            </p>
          </Reveal>

          <Reveal delay={240}>
            <div className="wispr-hero-actions">
              <button className="wispr-cta wispr-cta-primary" onClick={onSignUp}>
                <span>Create your account</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </button>
              <button className="wispr-btn-outline" onClick={() => document.querySelector('#wispr-features')?.scrollIntoView({ behavior: 'smooth' })}>
                See what it does
              </button>
            </div>
          </Reveal>

          <Reveal delay={320}>
            <div className="wispr-hero-meta">
              <Waveform />
              <span className="wispr-hero-meta-text">Spoken feedback · haptic alerts · offline-capable</span>
            </div>
          </Reveal>
        </div>
        <div className="wispr-scroll-hint" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </header>

      {/* ── Dark chamber: features ──────────────────────────── */}
      <section className="wispr-dark-chamber" id="wispr-features" tabIndex={-1}>
        <div className="wispr-chamber-inner">
          <div className="wispr-chamber-head">
            <div>
              <Reveal>
                <h2 className="wispr-heading">What watchora does</h2>
              </Reveal>
              <Reveal delay={80}>
                <p className="wispr-chamber-sub">Real capabilities, verified live — from hazard warnings to reading a banknote.</p>
              </Reveal>
            </div>
            <Reveal delay={140}>
              <div className="wispr-platform-row">
                {MODES.map((mode) => (
                  <span key={mode} className="wispr-pill-platform">
                    {mode}
                  </span>
                ))}
              </div>
            </Reveal>
          </div>

          <div className="wispr-feature-grid">
            {FEATURES.map((feature, i) => (
              <Reveal key={feature.title} delay={(i % 2) * 90}>
                <article className="wispr-dark-card">
                  <span className="wispr-dark-card-tag">{feature.tag}</span>
                  <h3 className="wispr-dark-card-title">{feature.title}</h3>
                  <p className="wispr-dark-card-body">{feature.body}</p>
                </article>
              </Reveal>
            ))}
          </div>

          {/* Phone mockup — flat dark illustration with cream chat bubbles */}
          <Reveal delay={120}>
            <div className="wispr-phone" aria-hidden="true">
              <div className="wispr-phone-screen">
                <div className="wispr-phone-bubble wispr-phone-bubble-out">
                  <span>Describe what's in front of me.</span>
                </div>
                <div className="wispr-phone-bubble wispr-phone-bubble-in">
                  <span>Stop. There is a chair ahead on your left.</span>
                  <Waveform dark />
                </div>
                <div className="wispr-phone-bubble wispr-phone-bubble-out">
                  <span>And the sign?</span>
                </div>
                <div className="wispr-phone-bubble wispr-phone-bubble-in">
                  <span>Reception Desk. Stairs to your right.</span>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Cream chamber: comparison + accents ─────────────── */}
      <section className="wispr-cream-section">
        <div className="wispr-section-inner">
          <Reveal>
            <div className="wispr-section-head">
              <div>
                <h2 className="wispr-heading wispr-heading-ink">Why the local layer matters</h2>
                <p className="wispr-section-sub">A blind pedestrian can't wait 15 seconds for an answer. Watchora doesn't make them.</p>
              </div>
              <span className="wispr-badge wispr-badge-forest">On-device · Offline-capable</span>
            </div>
          </Reveal>

          <div className="wispr-compare">
            <Reveal>
              <div className="wispr-compare-card wispr-compare-dark">
                <p className="wispr-compare-label">Cloud round-trip</p>
                <p className="wispr-compare-stat">15s</p>
                <p className="wispr-compare-copy">Worst-case latency for a single photo sent to the model — the old way of doing this.</p>
              </div>
            </Reveal>
            <Reveal delay={100}>
              <div className="wispr-compare-card wispr-compare-cream">
                <p className="wispr-compare-label wispr-compare-label-ink">Local hazard layer</p>
                <p className="wispr-compare-stat wispr-compare-stat-ink">≈1s</p>
                <p className="wispr-compare-copy wispr-compare-copy-ink">YOLO detection on your device, haptic alert immediately, no network required.</p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Dark chamber: safety ────────────────────────────── */}
      <section className="wispr-dark-chamber wispr-dark-chamber-last" id="wispr-safety">
        <div className="wispr-chamber-inner">
          <Reveal>
            <div className="wispr-chamber-head">
              <div>
                <h2 className="wispr-heading">How watchora stays safe</h2>
                <p className="wispr-chamber-sub">Built for people who can't afford confident guesses.</p>
              </div>
              <span className="wispr-badge wispr-badge-lavender">Safety by design</span>
            </div>
          </Reveal>

          <div className="wispr-principles">
            {PRINCIPLES.map((principle, i) => (
              <Reveal key={principle.title} delay={i * 90}>
                <article className="wispr-principle">
                  <span className="wispr-principle-num">{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="wispr-principle-title">{principle.title}</h3>
                  <p className="wispr-principle-body">{principle.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Cream chamber: final CTA ────────────────────────── */}
      <section className="wispr-cream-section wispr-cta-section">
        <div className="wispr-section-inner">
          <div className="wispr-cta-card">
            <Reveal>
              <div>
                <h2 className="wispr-cta-heading">
                  Ready to <span className="wispr-display-muted">hear it</span> yourself?
                </h2>
                <ul className="wispr-checklist">
                  {CHECKLIST.map((item) => (
                    <li key={item}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
            <Reveal delay={120}>
              <div className="wispr-cta-panel">
                <div className="wispr-cta-panel-head">
                  <div>
                    <span className="wispr-cta-label">Account</span>
                    <strong className="wispr-cta-price">Free</strong>
                  </div>
                  <span className="wispr-badge wispr-badge-teal">No seed data</span>
                </div>
                <button className="wispr-cta wispr-cta-primary wispr-cta-block" onClick={onSignUp}>
                  <span>Create your account</span>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </button>
                <button className="wispr-btn-outline wispr-btn-block" onClick={onSignIn}>
                  Already have an account? Sign in
                </button>
                <p className="wispr-cta-note">Camera and microphone work best over HTTPS — this site is served that way.</p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── Dark footer band ────────────────────────────────── */}
      <footer className="wispr-footer">
        <div className="wispr-section-inner">
          <div className="wispr-footer-top">
            <div className="wispr-wordmark">
              <Waveform dark />
              <span className="wispr-wordmark-name">watchora</span>
            </div>
            <nav className="wispr-footer-links" aria-label="Footer">
              <a href="#wispr-features">What it does</a>
              <a href="#wispr-safety">Safety</a>
              <a href="/install-guide.html">Install guide</a>
              <a href="/commitment.html">Our commitment</a>
              <button onClick={onSignIn}>Sign in</button>
            </nav>
          </div>
          <div className="wispr-footer-bottom">
            <span>© 2026 watchora · Built for people who can't wait to see.</span>
            <span className="wispr-footer-tag">Camera-to-voice assistance</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
