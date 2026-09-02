# Watchora — Security & Logic Hardening Pass

Date: 2026-09-02
Scope: full-stack audit remediation. Every finding below was reproduced in code, fixed, and covered by the test suite (server 66/66, frontend 97/97, both builds clean).

## Critical fixes

| # | Issue | Where | Fix |
|---|---|---|---|
| C1 | `/api/auth/forgot-password` returned the raw reset token to anyone who POSTed an email → account takeover (incl. ADMIN) | `server/src/routes/auth.ts` | Token is no longer in responses. Email delivery via new `lib/notify.ts` (SMTP). Raw token only when `EXPOSE_DEV_RESET_TOKEN=true` (explicit local-dev flag). Test now asserts the token is ABSENT by default. |
| C2 | Vercel demo auth minted ADMIN tokens for any email containing "admin"; plaintext demo passwords | `api/auth/login.ts`, `api/auth/signup.ts` | Removed email-substring role inference entirely. Demo accounts are exactly the three published ones, fixed roles, generic 401 otherwise. Signup always yields BLIND_USER. |
| C3 | Live Sarvam AI key committed in `.env.example` (and referenced by Vercel fns) | `.env.example` | Key replaced with placeholder + rotation warning. **Operator action required: rotate the exposed `sk_yaj0g3lw…` key in the Sarvam dashboard and purge it from platform env history.** |
| C4 | "Your trusted contact has been notified" was false — zero notification code existed | `server/src/routes/` | New `lib/notify.ts` (nodemailer) + `lib/alerts.ts` (shared dispatcher). SOS and journey-lost now email all trusted contacts fire-and-forget; delivery counts land in the audit log (`emergency.contacts_notified` / `safe_journey.contacts_notified`). Response no longer claims "notified" — it says "we are notifying". SMTP config in `.env.example`. |

## High-severity fixes

- **H1** — Login now rejects deactivated accounts (403) in addition to `requireAuth`.
- **H2** — Access-token TTL cut **30 days → 1 hour**. The SPA already refreshes on 401, so this is transparent; a stolen access token now dies within the hour even without a denylist.
- **H4** — Emergency acknowledge now requires the acker to be a **trusted contact of the person in crisis** (case-insensitive email match; ADMIN override). A stranger can no longer forge the "someone saw your SOS" signal.
- **H5** — Caregiver linkage: contact emails stored lowercase (`contacts.ts`), all caregiver/inbox lookups case-insensitive; **`shareExpiresAt` is now enforced** — expired location-sharing grants return `consent:false` in both overview and live-location endpoints.

## Medium fixes

- **M1** — Refresh rotation is atomic: conditional `updateMany({revokedAt: null})` decides the single winner; **reuse of a consumed token now revokes ALL sessions for that user** (kill-switch) + audit event `auth.refresh_reuse_detected`.
- **M2** — First-signup admin bootstrap serialized with a Postgres advisory lock (`pg_advisory_xact_lock`) inside the signup transaction — no more concurrent-double-admin race.
- **M5** — Error handler no longer leaks Prisma internals; 500s return a generic message, full detail goes to pino logs. Errors with an explicit `status`/`statusCode` (4xx) are preserved.
- **M6** — Global rate limit added (120 req/min) as backstop across all routers (auth/AI/TTS keep tighter limits).
- **M8** — Emergency sessions lazily expire: `/active` and `/inbox` transition stale `ACTIVE` rows to `EXPIRED` (`expireStaleSessions`).
- **M9** — Cancel window advertised and enforced are now the same constant (10s) in `emergency.ts`.
- **M13** — Community incident feed no longer includes reporter names.
- **Schema** — Migration `20260902000000_hardening_indexes`: indexes on `TrustedContact(userId/email)`, `ConsentGrant(userId)`, `SavedPlace(userId)`, `Journey(userId,status)`, `EmergencyAcknowledgement(sessionId)`, `ReadingEntry(userId)`, `AssistanceRequest(userId,status)`, `IncidentReport(createdAt/reporterId)`, plus `PromptVersion @@unique([mode, version])`.

## Frontend fixes

- **Stale voice settings**: the once-created speech manager read render-scoped `voice`/`voiceRate` frozen at first render — "speak slower/faster" commands and settings changes were silent no-ops. Now mirrored through refs (`App.tsx`).
- **Safe Journey silent death**: the geolocation watch only started on `start()`; switching tabs unmounted it and returning never restarted it — monitoring stopped while the UI implied otherwise. `loadActive` now restarts the watch for an in-flight journey.
- **Production AI endpoint**: `apiBaseUrl` fell back to `http://127.0.0.1:4000` in deployed builds → all Gemini voice commands broke. Now same-origin unless actually on a dev host (matching `api.ts`).
- **YOLO worker memory leak**: `ImageBitmap.close()` now runs in a `finally` — failed frames no longer leak a full camera frame each; the frame pump stops on worker error instead of posting into a broken worker forever.
- **Speech queue double-advance**: `onEnded()` guards `currentPriority == null`, so the neural-audio path and the speechSynthesis fallback can no longer both advance the queue and overlap/duplicate utterances.
- **Map trail color**: MapLibre can't resolve CSS custom properties; `var(--accent-lavender)` replaced with its literal `#f0d7ff`.
- **Error announce bug**: journey start failures announced the (empty) state string instead of the caught error — user never heard the server's reason.

## Tests updated to the new security contract

- `safe-journey-emergency.test.ts`: caregiver is created as an actual trusted contact before acknowledging; `cancelWindowSeconds` asserted as 10.
- `refresh-caregiver-admin.test.ts`: reset token asserted present under the dev flag and **absent** without it.

## Operator checklist (deploy)

1. Rotate the leaked Sarvam key; set secrets in Dokploy/Vercel env, never in files.
2. Set `SMTP_*` + `PUBLIC_APP_URL` env vars to enable reset/SOS email delivery.
3. Run `npx prisma migrate deploy` (new index migration).
4. Never set `EXPOSE_DEV_RESET_TOKEN` in production.
5. Remove or restrict the three demo passwords in README/seed for any public deployment.

## Remaining known gaps (deliberately not fixed in this pass)

- Admin prompt versions still replace `buildPrompt` wholesale (safety-contract bypass risk) — needs a validated/dry-run flow.
- User free-text is still concatenated into AI prompts without delimiting (prompt-injection surface limited by schema-constrained outputs).
- ML assets (~60 MB) are cache-on-first-fetch, not precached — first-visit offline users lack YOLO/OCR.
- Legacy `POST /api/journeys` still bypasses the one-active-journey invariant.
- Status columns remain free-text strings (no enums).

- Deploy verified live with persisted environment (2026-09-02).
