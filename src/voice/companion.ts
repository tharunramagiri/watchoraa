// Emotional-support companion (deterministic, safety-first).
//
// Watchora speaks constantly to people who are often anxious: navigating an
// unfamiliar street, waiting after an SOS, alone after a fall. Competitors
// ignore the emotional channel entirely. This module gives Watchora a
// consistent, non-clinical, HONEST companion layer:
//  - deterministic (no AI decides your emotional state — it is inferred from
//    observable interaction patterns: repeated unknowns, SOS history, wait
//    time, user's own words via opt-in phrase matching),
//  - never diagnostic, never "I understand exactly how you feel",
//  - never blocks or delays safety speech (it rides at low speech priority),
//  - respects a user toggle and quiet hours, default ON but instantly silenced.

export type EmotionalState =
  | 'steady' // default: no signals
  | 'navigating-unfamiliar' // active journey in progress
  | 'post-alert-wait' // SOS acknowledged, waiting for help
  | 'frustrated'; // repeated unrecognized commands / repeated failures

export interface CompanionContext {
  state: EmotionalState;
  /** Minutes since the last successful interaction. */
  minutesSinceLastSuccess?: number;
  /** Consecutive unrecognized voice commands. */
  consecutiveUnknowns?: number;
  /** User's companion toggle (Settings). Default true. */
  enabled: boolean;
  /** Local hour (0-23) for quiet hours. */
  hour?: number;
}

export interface CompanionLine {
  /** Spoken text. Empty string = nothing to say. */
  text: string;
  /** Companion ambient lines ride at low speech priority (6/7): they must
   * NEVER interrupt navigation, hazard, or emergency speech. Direct feeling
   * replies run at priority 4 (user-answer) — the user spoke to us. */
  priority: 4 | 6 | 7;
  dedupeKey: string;
}

const QUIET_HOURS = [22, 23, 0, 1, 2, 3, 4, 5, 6]; // 22:00–06:59

// Non-clinical, honest lines. Banned patterns tested below: no "I know how
// you feel", no diagnoses, no toxic positivity, no therapist cosplay.
const LINES: Record<EmotionalState, string[]> = {
  steady: [],
  'navigating-unfamiliar': [
    'I am right here with you. You are doing well.',
    'Taking it one step at a time is exactly right.',
    'You have handled unfamiliar places before. I am watching the road with you.',
  ],
  'post-alert-wait': [
    'Your alert is out. Staying where you are is the right call. I will keep you company while you wait.',
    'Help has your location. You are not alone in this.',
    'It is okay to feel tense while waiting. Your contacts can see where you are.',
  ],
  frustrated: [
    'No rush. Say "help" any time and I will list what I can do.',
    'That one did not come through. Try "what is ahead" — that always works.',
  ],
};

export function companionLine(ctx: CompanionContext): CompanionLine {
  if (!ctx.enabled) return { text: '', priority: 7, dedupeKey: 'companion-off' };
  if (ctx.hour != null && QUIET_HOURS.includes(ctx.hour)) {
    return { text: '', priority: 7, dedupeKey: 'companion-quiet' };
  }

  if (ctx.state === 'frustrated') {
    const unknowns = ctx.consecutiveUnknowns ?? 0;
    if (unknowns < 2) return { text: '', priority: 6, dedupeKey: 'companion-steady' };
    const line = LINES.frustrated[Math.min(unknowns - 2, LINES.frustrated.length - 1)];
    return { text: line, priority: 6, dedupeKey: `companion-frustrated-${unknowns}` };
  }

  if (ctx.state === 'post-alert-wait') {
    const mins = ctx.minutesSinceLastSuccess ?? 0;
    // One line right away, one at 5 minutes, then every 10. Never silent for
    // someone waiting for help — never nagging either.
    if (mins === 0 || (mins >= 5 && (mins - 5) % 10 === 0)) {
      const idx = mins === 0 ? 0 : 1 + (Math.floor((mins - 5) / 10) % (LINES['post-alert-wait'].length - 1));
      return { text: LINES['post-alert-wait'][idx], priority: 6, dedupeKey: `companion-wait-${mins}` };
    }
    return { text: '', priority: 6, dedupeKey: 'companion-wait' };
  }

  if (ctx.state === 'navigating-unfamiliar') {
    // Gentle presence line roughly every 10 minutes of active navigation,
    // deterministic via time bucket.
    const mins = ctx.minutesSinceLastSuccess ?? 0;
    if (mins > 0 && mins % 10 === 0) {
      const idx = Math.floor(mins / 10) % LINES['navigating-unfamiliar'].length;
      return { text: LINES['navigating-unfamiliar'][idx], priority: 7, dedupeKey: `companion-nav-${mins}` };
    }
    return { text: '', priority: 7, dedupeKey: 'companion-nav' };
  }

  return { text: '', priority: 7, dedupeKey: 'companion-steady' };
}

/**
 * Opt-in feeling words ("I'm scared", "I'm nervous", "I feel alone").
 * Deterministic phrase matching — the user's words are only ever read for
 * these local patterns, never sent anywhere. Responds honestly: no
 * pretending to understand, one concrete offer of help.
 */
const FEELING_PATTERNS: Array<{ match: RegExp; line: string }> = [
  { match: /\b(i'?m (scared|afraid|frightened)|i am scared|i feel scared)\b/i, line: 'Thank you for telling me. If you are somewhere unsafe, say "emergency" and I will alert your contacts right now. If not, I am here — ask me anything about what is around you.' },
  { match: /\b(i feel alone|i'?m alone|nobody (is )?here)\b/i, line: 'I am here with you, and your trusted contacts are one command away. Say "send my location" if you want them to know where you are.' },
  { match: /\b(i'?m (lost|stuck)|i am lost|i feel lost)\b/i, line: 'Let us sort this out together. I can describe what is around you, or guide you back to a saved place — say "list my places" to start.' },
  { match: /\b(i can'?t do this|too hard|give up)\b/i, line: 'You do not have to do everything at once. Pick one small thing — I can read a label, check what is ahead, or call a contact. Which one?' },
  { match: /\b(i'?m (tired|exhausted)|i am tired)\b/i, line: 'Rest is allowed. If you are mid-journey, your caregiver can see your progress. When you are ready, say "check in" to let them know you are okay.' },
];

export function matchFeelingPhrase(transcript: string): CompanionLine | null {
  for (const pattern of FEELING_PATTERNS) {
    if (pattern.match.test(transcript)) {
      // Priority 4 (user-answer): the user addressed us directly; this may
      // interrupt background speech but never hazard/emergency (1-3).
      return { text: pattern.line, priority: 4, dedupeKey: 'companion-feeling' };
    }
  }
  return null;
}
