# Watchora — Real-User Pain-Point Research (2026-09)

Grounded in the ACCESS study of 60 adults with vision impairment (Remillard
et al., PMC11102008), WHO fact sheets, and community reports (r/Blind, AFB
AccessWorld testing, Hable/Seattle Times guides). Full sources in the research
brief. Ranked by how often the pain appears AND how well a phone-camera AI can
address it.

## The top 10 daily-activity problems

| # | Pain | What users do today | What Watchora does / will do | Honest limits |
|---|---|---|---|---|
| 1 | **Can't tell which bus is coming** | ask drivers, transit apps, paratransit | camera reads bus numbers/signage at the stop (reading mode) | moving buses in traffic, indoor arrival detection — out of reach |
| 2 | **Mail & documents can't be triaged privately** | family, OCR apps, label services | offline OCR + reading mode; AI classifies "this looks like a bill" | handwriting unreliable; no legal/medical guarantees |
| 3 | **Medication labels** ("I fear dosages since I can't read the label") | talking readers, braille labels (most blind people don't read braille), pill organizers | reading mode reads the label; expiry command reads use-by dates | must REFUSE to identify loose unlabeled pills — too dangerous |
| 4 | **Cooking & stove safety** | bump dots, talking thermometers, meal prep | expiry/best-before command; assistant mode can describe stove state | can't judge doneness/temperature — never claim food is cooked |
| 5 | **Cash banknotes** (US bills ruled inaccessible, ACB v. Paulson) | folding systems, kindness of strangers | **`identify_currency` command shipped** — AI names denomination from visible marks, never guesses between two similar notes | counterfeits undetectable; low light = say so |
| 6 | **Grocery shopping** (fear of being suspected of stealing while inspecting items) | helpers, customer service, delivery sites that block screen readers | `read_expiry`, shopping mode, label reading | barcode-precision nutrition needs a scanner — roadmap |
| 7 | **Indoor wayfinding in new buildings** | staff, O&M training, rare beacons | saved places + camera reads room signs | full indoor maps need beacons/native — not a PWA feat |
| 8 | **Dropped objects** (coin, pill, key) | hands-and-knees sweeping, AirTags | YOLO sweep-scan can locate "small object on floor" + haptic direction | can't see under furniture or in clutter |
| 9 | **Inaccessible appliances/kiosks** | memorizing button positions, asking strangers | reading mode reads the screen aloud | can't press buttons; fast-changing screens |
| 10 | **Color-matching clothes** (embarrassment risk) | tactile closet tags, pre-matched outfits, asking | **`identify_color` command shipped**; assistant prompt states lighting caveats | fashion/taste judgments are out of scope |

## The emotional layer (why the companion module exists)

Research is unambiguous: asking for help "feels very vulnerable," fear of
being a burden, fear of being suspected of shoplifting, fall anxiety,
loneliness — **loss of independence is the central fear**. Voice-first design
itself addresses the embarrassment dimension (no fumbling a screen in public).
Watchora's companion module (`src/voice/companion.ts`) extends this with
deterministic emotional support: presence lines during journeys and post-SOS
waits, frustration detection from repeated unrecognized commands, and opt-in
feeling-phrase replies ("I'm scared" → honest, actionable support + the
emergency offer). All deterministic, all local, all silence-able, never
diagnostic, never blocking safety speech.

## What this means for the roadmap

Shipped in this tranche: currency ID, color ID, expiry reading, lighting
query, companion. Next-highest-value copies from the competitor teardown
(see `docs/beat-the-competitors-2026-09.md`): follow-up Q&A on the current
frame, barcode scan, find-my-things.
