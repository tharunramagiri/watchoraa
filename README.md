# Watchora

**Watchora is an AI-powered mobility and safety platform for blind and low-vision
people.** Point the camera, pick a mode, and get a spoken description — backed
by real accounts, trusted contacts, safe-journey monitoring, and a
deterministic emergency system. Live at https://watchora.ramagiritharun.in —
see `docs/watchora-startup-plan.md` for the startup master plan,
`docs/growth-plan-2026-09.md` for go-to-market, and
`docs/hardening-2026-09-02.md` for the security audit + remediation log.

> **Watchora is a secondary assistive tool. It does not replace a white cane,
> guide dog, orientation and mobility training, official pedestrian signals or
> emergency services.** It never claims a path is safe to cross, never
> authorizes road crossing, and never detects "dangerous people."

## What it does (v0.7 — Daily living, real safety delivery, emotional companion)

- **Real SOS delivery** — triggering SOS emails (SMTP) and SMS-messages
  (Twilio) every trusted contact, with per-channel delivery counts audited.
  The app never says "your contact has been notified" unless the message
  actually went out. Emergency acknowledgement is restricted to the user's
  trusted contacts.
- **Daily-living channels by voice** — `what money is this` (never guesses
  between similar banknotes), `what color is this` (lighting caveats),
  `read the expiry` (verbatim dates), `scan the barcode` (GS1 checksum
  validation, OpenFoodFacts lookup through the server proxy, allergens +
  sugar/salt spoken), and `tell me more` follow-up Q&A on the current scene.
- **Find-my-things** — teach a personal object by voice ("teach this as my
  wallet"), locate it later ("find my wallet") with a hard honesty contract:
  the vision check must answer found/not-found and may never claim to see an
  object that is not clearly in frame. Objects only — no people
  identification, ever.
- **Emotional companion** — deterministic, on-device support: feeling phrases
  ("I'm scared", "I'm lost") get practical help and the emergency offer;
  presence lines during journeys and post-SOS waits; frustration detection.
  Never diagnostic, never interrupting safety speech.
- **Screen-reader-first install guide** (`/install-guide.html`) and a
  durability commitment page (`/commitment.html`).
- **Security posture (hardening pass 2026-09-02)** — short-lived access
  tokens (1h) with atomic refresh rotation + replay kill-switch, restricted
  SOS acknowledgement, consent expiry enforcement, email delivery for
  password reset, SSRF-guarded server fetches, global rate limiting, generic
  5xx responses, real DB enums for statuses, TTL cleanup of token tables,
  and a deterministic deploy pipeline with post-deploy health verification.
  Full table in `docs/hardening-2026-09-02.md`.

## What it does (v0.6 — People awareness, ground-level hazards, motion cadence)

- **People awareness** — the Navigation Coach uses distinct, neutral phrasing
  for `person` detections ("Person approaching on your left...", "Caution. A
  person is close... step right to give them room."). It never identifies,
  judges, or names anyone — presence and direction only, verified by an
  automated test that asserts the absence of danger/threat/suspicious/police/
  report language.
- **Ground-level trip-hazard language** — an object whose bounding box sits in
  the lower quarter of the camera frame gets an explicit "Watch your step..."
  cue even at moderate size, since small low objects (posts, curbs) are easy
  to miss.
- **Opt-in motion cadence** — accelerometer-derived motion (stationary/
  walking/running) only feeds the coach's adaptive frame rate after the user
  has explicitly granted the Motion permission. Without that grant, the coach
  always uses the safest, lowest-cadence (stationary) setting — it never
  claims to sense motion it does not have permission to read.
- **Release-readiness audit** (2026-08-06) — full 25-step manual QA (25/25),
  denied-permission path testing (10/10), offline audit (13/13), SOS
  hold-to-activate audit (5/5), a voice-command ground-truth matrix with
  negative safety tests, a security/privacy review (0 npm vulnerabilities,
  frontend + backend), and 24 release screenshots. See
  `docs/release-notes-v0.6.md` for the full summary and
  `docs/audit-2026-08-06.md` for detailed evidence. **Not yet completed:** a
  real screen-reader hardware pass (TalkBack/VoiceOver) and real mobile
  device testing — both require hardware not available in this environment,
  and are the explicit blockers before this branch should be merged. See
  `docs/accessibility-testing.md` and `docs/browser-support.md`.

## What it does (v0.5 — Proactive Vision Coach + offline-first hardening)

- **Navigation Coach** — deterministic proactive vision coaching layered on the
  local YOLO detections: SPOTTED → TRACKING → PASSING → CLEARED per obstacle,
  directional language with clock positions, obstacle chaining ("scanning ahead
  for the next obstacle"), silence breaker, walking updates, adaptive
  frame-rate (0.5/1.5/2.5 FPS by motion), and a stereo-panned directional cue
  tone. Modes: Navigation, Reading, Exploration, Shopping. All decision logic is
  AI-free and unit-tested.
- **Shopping mode** — "read this label", "what does this cost" route
  deterministically to shopping; the server AI allow-list includes `shopping`
  and never safety-critical intents.
- **Offline-first hardening (verified end-to-end)** — the service worker now
  precaches the app bundle + lazy chunks at install, cache matching ignores
  `Vary` quirks, and the session survives offline reload via a cached user
  profile. Offline: shell, dashboard, local YOLO + coach, OCR, saved places,
  emergency info, permission status, and local voice commands all work.
- **Barge-in** — pressing the talk button stops current speech immediately
  (deterministic, before any recognition).
- Full competitive analysis + roadmap: `docs/competitive-edge.md`.

## What it does (v0.4 — Voice-First PWA)

**Watchora now runs primarily through an accessible AI voice assistant:**

- **Guided permission onboarding** — a spoken welcome, a "Start Watchora"
  button, then a one-at-a-time permission sequence (audio → microphone →
  camera → location → notifications → motion) with "Skip for now" fallbacks.
- **Central voice assistant** — one coordinated service (mic lifecycle,
  speech recognition, push-to-talk, wake phrase, confirmation, error recovery).
  Persistent "Talk to Watchora" button on every screen.
- **Deterministic command router** — safety commands (emergency, journey,
  location) match locally and never depend on AI. Flexible wording falls back
  to a server-side AI parser that never handles safety-critical intents.
- **Voice-first dashboard** — Home shows current status, permission status,
  and large action cards (Assist, Safe Journey, Read, Emergency), each with a
  voice hint. Emergency control is always in reach (hold-to-activate, spoken
  + haptic cancellation countdown, status screen).
- **Permission Centre** — full status + re-request for all capabilities,
  reachable from onboarding, the dashboard, Settings, and voice.
- **Accessibility** — WCAG 2.2 AA baseline, ARIA live regions, focus
  management, screen-reader-friendly labels, large touch targets, reduced
  motion, offline fallbacks.
- Full command reference: `docs/voice-first-pwa.md`.

## What it does (v0.3 — Safety Foundation)

- **Camera-to-voice AI assistance** — real Gemini calls, server-side, with
  structured JSON (summary/details/warnings/confidence), safety-tuned prompts,
  and an honest demo fallback.
- **Free high-quality neural voices** — Microsoft Edge neural TTS (no key,
  400+ voices / ~140 locales incl. all major Indian languages) with a real
  voice picker in Settings; falls back to the on-device voice when offline.
- **Local perception** — on-device YOLO hazard layer, hybrid OCR, haptic
  feedback, GPS saved places (see `docs/yolo-ocr-slam-plan.md`).
- **Real accounts** — email/password auth with bcrypt, JWT access +
  rotating refresh tokens, password reset, first-signup-becomes-admin
  bootstrap, roles (BLIND_USER / CAREGIVER / ADMIN).
- **Safe Journey (P0)** — start a journey with destination, ETA, trusted
  contact, check-in interval, live-location sharing. Watchora prompts you if
  you deviate from your route or miss your arrival, then escalates to your
  trusted contact after repeated unanswered prompts. "I'm lost" requests help.
- **Emergency / SOS (P0)** — deterministic, no-AI emergency system: trigger
  with a rich payload (coordinates, accuracy, battery, heading, maps link),
  5-second cancellation window, live-location updates, trusted-contact
  acknowledgement, caregiver inbox.
- **Trusted contacts, saved places, community reports** — real Postgres rows,
  scoped per user; community moderation (OPEN/REVIEWED/REMOVED, reporter
  self-delete).
- **Caregiver portal** — see the people who listed you as a trusted contact,
  their open SOS, recent journeys, saved places.
- **Admin** — users/roles, incidents, SOS, AI usage stats, prompt versioning,
  audit log, caregiver data.
- **Audit trail** — signup/login/role changes/deactivations/SOS/journeys all
  recorded and readable by admins.
- **PWA shell** — manifest + service worker + offline shell.

## Run it

Frontend app in the root, backend API in `server/`.

### Backend

```bash
cd server
npm install
cp .env.example .env   # set DATABASE_URL, JWT_SECRET, GEMINI_API_KEY
createdb watchora
npx prisma migrate deploy
npm run seed           # seeds default Admin, Blind User, and Caregiver accounts
npm run dev            # http://127.0.0.1:4000
```

Health: `http://127.0.0.1:4000/healthz` · tests: `cd server && npm test`
(61 tests: auth, AI safety, TTS, preferences, caregiver, refresh/reset,
Safe Journey, emergency).

### Frontend

```bash
npm install
npm run dev            # http://127.0.0.1:5173
```

### Default Accounts (from `npm run seed`)

| Account Type | Email / Username | Password | Role |
| :--- | :--- | :--- | :--- |
| **Admin User** | `admin@watchora.app` | `AdminPass123!` | `ADMIN` |
| **Normal User** | `user@watchora.app` | `UserPass123!` | `BLIND_USER` |
| **Caregiver User** | `caregiver@watchora.app` | `CarePass123!` | `CAREGIVER` |

*(Note: On a fresh database, the first user to sign up through the UI automatically becomes the ADMIN).*

## Voice

Settings → Voice & audio: pick any neural voice from ~140 locales (all Indian
languages: हिन्दी, தமிழ், తెలుగు, ಕನ್ನಡ, മലയാളം, বাংলা, ગુજરાતી, मराठी, اردو;
plus English IN/UK/US/AU, Vietnamese, Spanish, and more). Speech speed is
adjustable; the voice + speed persist to your preferences.

## Safety model

- **Deterministic safety layer** — Safe Journey + emergency are pure rules;
  Gemini is never in the emergency path.
- **Confidence-aware** — AI output is labeled low/medium/high; never claims a
  path is safe or tells you to cross.
- **Prompt-first escalation** — deviations and missed arrivals ask you first;
  contacts are only alerted after repeated unanswered prompts.
- **Privacy** — camera frames stay in memory; images are never stored; the
  Gemini key never leaves the server; community reports hide REMOVED content.

## Known limitations (documented, not hidden)

- **PWA limits** — a web page cannot run the camera in the background, listen
  continuously, or guarantee background GPS. A native Android app is the
  planned path for those (see the roadmap in `docs/competitive-edge.md` and
  `docs/release-notes-v0.6.md`).
- **SOS delivery** — the caregiver portal + inbox surface alerts; push/SMS/email
  delivery needs a provider key (SMTP/Twilio/FCM) to be wired.
- **AI is a cautious assistant** — no emotion detection, no criminal-intent
  detection, no "safe to cross" authorization, no exact-distance claims.

## Tests & branch status

- **Frontend:** `npm test` — 67/67 passing (`vitest run`, 5 test files: navigation coach, spatial audio, permission service, command router, negative safety tests)
- **Backend:** `cd server && npm test` — 66/66 passing (8 test files)
- **Build:** `npm run build` (frontend) and `cd server && npm run build` — both clean
- **Branch:** merged into `main` 2026-08-06 (commit `dea157a`); the
  `voice-first-pwa` branch was removed after the merge. Feature-complete
  through v0.6 plus the Caregiver live-location map. A real screen-reader
  hardware pass remains outstanding (see `docs/accessibility-testing.md`).

## Docs

- `docs/release-notes-v0.6.md` — v0.4→v0.6 summary, test totals, security
  review, screenshots, known limitations, rollback plan, and the
  release-readiness recommendation.
- `docs/audit-2026-08-06.md` — the full v0.5/v0.6 feature + release-readiness
  audit with evidence for every claim.
- `docs/manual-qa-v0.6.md` — the full 25-step manual QA flow, results, and findings.
- `docs/voice-command-reference.md` — ground-truth matrix of every voice
  command (deterministic vs. AI-routed, permission, confirmation, offline
  availability, safety priority) with negative safety tests.
- `docs/browser-support.md` — honest browser/device capability matrix and
  documented fallback behavior for every gap.
- `docs/accessibility-testing.md` — automated accessibility checks completed,
  and the screen-reader hardware pass items still outstanding.
- `docs/offline-behaviour.md` — first-visit, reload-offline, and
  network-returns behavior with evidence, including the "no offline
  write-queue" limitation stated plainly.
- `docs/competitive-edge.md` — competitive research vs. other assistive
  vision apps, and the v0.6+ roadmap.
- `docs/screenshots/v0.6/` — 24 release screenshots (12 mobile + 12 desktop).
- `docs/watchora-startup-plan.md` — the startup master plan (research, product
  system, architecture, roadmap v0.3 → v1.0).
- `docs/watchora-audit-2026-08-06.md` — the running audit (pass 1: dead schema
  + audit trail; pass 2: refresh/reset/AI-gating/caregiver/prompts/moderation;
  pass 3: neural voices; pass 4: Safe Journey + emergency).
- `docs/blindnav-audit.md`, `docs/blindnav-roadmap.md` — original product audit
  and roadmap.
- `docs/yolo-ocr-slam-plan.md` — local perception architecture.
