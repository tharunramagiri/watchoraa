# Watchora — Beat-the-Competitors Plan (2026-09)

Feature-level teardown of the five serious competitors, and the copy-list.
Full teardown with sources in the research brief; positioning economics in
`docs/growth-plan-2026-09.md`.

## Where each competitor is beatable

| Competitor | Their strength | Their weakness we exploit |
|---|---|---|
| **Be My Eyes** | 10.9M volunteers + Be My AI; enterprise "Service AI" (Microsoft/Google/Meta pay) | AI is snapshot-based with follow-ups but **no continuous hazard stream, no haptics, no SOS**; needs network + patience |
| **Seeing AI** (Microsoft) | The channel model: Short Text, Document, Person, Currency, Color, Light, Handwriting, Indoor Navigation, Find My Things | English-first historically; **no SOS, no caregiver, no community layer**; research-project sunset risk (they killed Soundscape) |
| **Envision AI** | 60+ language OCR, teach-a-face, find objects, companion video help | Glasses upsell focus; subscription on hardware; no hazard layer |
| **WeWALK** | Smart cane hardware + transit alerts + obstacle detection | Requires buying hardware; app is a companion to the cane |
| **Aira** | Professional human interpreters, B2B venue sponsorship | Humans don't scale; coverage is venue-gated; consumer price opacity |
| **NaviLens** | Tags readable at 30m in any light (NYC MTA, Barcelona) | Only works where tags are installed — infrastructure sales cycle |

**The structural gap none of them fill: Watchora is the only free,
browser-based, multilingual product that combines continuous hazard warning
(deterministic, on-device) + real SOS/caregiver safety net + the full
"Seeing-AI-style" daily-living channels.** They each own one island.

## What we copied (shipped this tranche)

- **Currency channel** → `identify_currency` command: AI names the
  denomination from visible marks, states which marks it used, never guesses
  between two similar notes, reminds the user that feel+size beat photos.
- **Colors channel** → `identify_color` command with lighting-caveat honesty
  (AFB testing found competitors' color ID inconsistent — ours is instructed
  to express uncertainty rather than guess).
- **Expiry/use-by reading** → `read_expiry` (medication + food safety).
- **Light query** → "is there enough light" focus in describe_scene.
- **Emotional presence layer** — something none of them have at all.

## Copy next (ranked by user value × PWA feasibility)

1. **Follow-up Q&A on the current frame** (Seeing AI "More Info" + Be My AI
   chat): keep the last frame + conversation, let the user ask "how far is
   that bench?" without re-capturing. Trivial: frame stays server-side for
   the turn; add chat history to the prompt.
2. **Barcode product lookup**: getUserMedia + a JS barcode lib; feeds the
   existing shopping mode with name/price/nutrition.
3. **Find My Things**: user photographs a personal object once; we store an
   embedding on-device; YOLO-class sweep + embedding match locates it with
   haptics. (Envision does this for faces; objects is easier.)
4. **Document mode with layout**: multi-page OCR with structure (Seeing AI
   Document) — our Tesseract path + prompt shape.
5. **AI→human escalation** (Be My Eyes pattern) — later, needs volunteers
   or a B2B partner; note as the enterprise wedge.

## Explicit non-copies

- Face recognition/age/gender estimation (Seeing AI Person): ethically wrong
  for our user base; we committed to never identifying people.
- LiDAR audio-AR (Seeing AI World): hardware-gated; PWA can't compete there.
- Hardware canes/glasses: asset-light is our advantage.
