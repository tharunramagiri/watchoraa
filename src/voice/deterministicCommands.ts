// Deterministic command router (v0.4). Safety-sensitive commands are matched
// locally through patterns BEFORE any AI interpretation. This is the layer
// that guarantees emergency/journey commands never depend on a model.

import type { VoiceIntent } from './voiceTypes';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function has(text: string, ...needles: string[]): boolean {
  return needles.some((n) => text.includes(n));
}

/** Extracts a destination from phrases like "to the railway station". */
function extractDestination(text: string): string {
  const m = /(?:to|toward|towards)\s+(?:the\s+)?(.+?)(?:\.|$)/.exec(text);
  if (!m) return '';
  const dest = m[1].trim().replace(/^(my|the|a)\s+/, '').trim();
  return dest.length > 0 && dest.length <= 60 ? dest : '';
}

/** Extracts the text after the first matching trigger phrase (for object names). */
function extractAfter(text: string, phrases: string[]): string {
  for (const phrase of phrases) {
    const idx = text.indexOf(phrase);
    if (idx >= 0) {
      const rest = text.slice(idx + phrase.length).replace(/^(the|my|a)\s+/, '').replace(/[.!?]+$/, '').trim();
      if (rest) return rest.slice(0, 60);
    }
  }
  return '';
}

function intent(intent: VoiceIntent['intent'], parameters: VoiceIntent['parameters'] = {}, requiresConfirmation = false, confidence = 0.99): VoiceIntent {
  return { intent, parameters, confidence, requiresConfirmation, deterministic: true };
}

/**
 * Matches a transcript against deterministic patterns. Returns null when no
 * deterministic command matches, so the caller can fall back to AI.
 */
export function matchDeterministicCommand(transcript: string): VoiceIntent | null {
  const t = normalize(transcript);
  if (!t) return null;

  // ── Emergency (highest priority; local, deterministic) ──
  // Cancel must be checked BEFORE the bare emergency match, otherwise
  // "cancel emergency" would match "emergency".
  if (has(t, 'cancel emergency', 'cancel sos', 'stop emergency', 'stand down')) {
    return intent('cancel_emergency', {}, true, 1);
  }
  if (has(t, 'emergency', 'send sos', 'sos', 'i need help', 'help me now', 'call my trusted contact', 'call trusted contact')) {
    return intent('emergency', {}, true, 1);
  }
  if (has(t, 'send my current location', 'send my location', 'share my location', 'share location')) {
    return intent('send_location', {}, true, 1);
  }
  if (has(t, 'who acknowledged', 'who acknowledged my sos', 'who acknowledged my emergency')) {
    return intent('who_acknowledged', {}, false, 1);
  }

  // ── Safe Journey ──
  if (has(t, 'start a safe journey', 'start safe journey', 'start journey', 'begin journey')) {
    const dest = extractDestination(t);
    return intent('start_safe_journey', { destination: dest }, dest ? false : true, 0.99);
  }
  if (has(t, 'stop my journey', 'stop the journey', 'end journey', 'end my journey')) {
    return intent('stop_safe_journey', {}, true, 1);
  }
  if (has(t, 'check my journey', 'journey status', 'how is my journey')) {
    return intent('check_journey', {}, false, 1);
  }
  if (has(t, 'i am safe', "i'm safe", 'i arrived', 'arrived safely', 'made it')) {
    return intent(has(t, 'i arrived', 'arrived safely', 'made it') ? 'i_arrived' : 'i_am_safe', {}, false, 1);
  }
  if (has(t, 'i am lost', "i'm lost", 'lost my way', 'i am confused', 'help i am lost')) {
    return intent('i_am_lost', {}, false, 1);
  }

  // ── Vision coaching modes (off-phrases first so "turn off navigation
  // coaching" never matches the on-phrase; block sits before "read this" so
  // "read this label" routes to shopping, not read_text) ──
  if (has(t, 'turn off navigation coaching', 'stop navigation coaching', 'disable coaching', 'stop coaching', 'turn off coaching')) {
    return intent('set_coach_mode', { mode: 'off' }, false, 1);
  }
  if (has(t, 'navigation mode', 'navigation coaching', 'turn on navigation coaching', 'start coaching', 'start navigation coaching', 'walking mode')) {
    return intent('set_coach_mode', { mode: 'navigation' }, false, 1);
  }
  if (has(t, 'reading mode', 'text mode')) {
    return intent('set_coach_mode', { mode: 'reading' }, false, 1);
  }
  if (has(t, 'exploration mode', 'explore mode')) {
    return intent('set_coach_mode', { mode: 'exploration' }, false, 1);
  }
  if (has(t, 'shopping mode')) {
    return intent('set_coach_mode', { mode: 'shopping' }, false, 1);
  }
  // ── Shopping (before generic "read this") ──
  if (has(t, 'read this label', 'read the label', 'read this product', 'read the product', 'what does this cost', 'what is the price', 'check this product', 'read the barcode')) {
    return intent('shopping', {}, false, 1);
  }
  // ── Barcode scan (before generic "read this") ──
  if (has(t, 'scan the barcode', 'scan barcode', 'scan this barcode', 'scan the product', 'scan product', 'read the barcode number', 'identify product by barcode', 'what is this product')) {
    return intent('scan_product', {}, false, 1);
  }

  // ── Daily-living identification (copied from Seeing AI's most-used channels:
  // Color, Currency; plus expiry-date reading for food/medicine) ──
  if (has(t, 'what color is this', 'what colour is this', 'what color', 'what colour', 'tell me the color', 'tell me the colour', 'identify the color', 'identify the colour')) {
    return intent('identify_color', {}, false, 1);
  }
  if (has(t, 'what money is this', 'which note is this', 'which bill is this', 'identify the money', 'identify this banknote', 'how much money is this', 'what note am i holding', 'what currency')) {
    return intent('identify_currency', {}, false, 1);
  }
  if (has(t, 'read the expiry', 'read the expiration', 'what is the expiry', 'when does this expire', 'best before', 'use by date', 'read the date on this')) {
    return intent('read_expiry', {}, false, 1);
  }
  if (has(t, 'is there enough light', 'how is the lighting', 'is it dark in here')) {
    return intent('describe_scene', { focus: 'lighting' }, false, 0.9);
  }
  // Follow-up on the last analysis (Seeing AI "More info" pattern): works
  // right after any scene/reading response, without re-capturing intent.
  if (has(t, 'tell me more', 'what else', 'go deeper', 'more detail about the scene', 'anything else in the scene', 'what else do you see', 'describe more')) {
    return intent('follow_up', {}, false, 0.9);
  }
  // ── Find-my-things: teach personal objects, then locate them by voice ──
  if (has(t, 'teach this', 'remember this', 'remember this object', 'save this object')) {
    const name = extractAfter(t, ['teach this as', 'teach this', 'remember this as', 'remember this', 'save this object as', 'save this object']) || 'my thing';
    return intent('teach_thing', { name }, false, 0.95);
  }
  if (has(t, 'find my', "where is my", "where did i put my", "have you seen my")) {
    const name = extractAfter(t, ['find my', 'where is my', 'where did i put my', 'have you seen my']) || '';
    return intent('find_thing', { name }, false, name ? 0.95 : 0.8);
  }

  // ── Assistance ──
  if (has(t, 'describe what is ahead', 'what is ahead', 'what is in front', 'describe the scene', 'describe my surroundings', 'what is around me', 'what objects are near')) {
    return intent('describe_scene', {}, false, 1);
  }
  if (has(t, 'read this', 'read the text', 'read text', 'read what is here', 'read the sign')) {
    return intent('read_text', {}, false, 1);
  }
  if (has(t, 'find the door', 'where is the entrance', 'where is the door')) {
    return intent('describe_scene', { focus: 'door' }, false, 0.9);
  }

  // ── Navigation ──
  if (has(t, 'navigate to', 'take me to', 'go to', 'navigate')) {
    const dest = extractDestination(t);
    return intent('start_navigation', { destination: dest }, false, dest ? 0.95 : 0.8);
  }
  if (has(t, 'how far is', 'distance to', 'which direction is', 'which way is')) {
    const dest = extractDestination(t) || t.replace(/.*(?:how far is|distance to|which direction is|which way is)\s+(?:the\s+)?/, '').trim().slice(0, 40);
    return intent('start_navigation', { destination: dest, query: 'distance' }, false, 0.9);
  }
  if (has(t, 'where am i')) {
    return intent('start_navigation', { query: 'where' }, false, 0.95);
  }

  // ── Settings / permissions ──
  if (has(t, 'check my permissions', 'permission status', 'permission centre', 'open permission center', 'open permission centre')) {
    return intent('permission_status', {}, false, 1);
  }
  if (has(t, 'speak slower', 'slow down', 'talk slower')) {
    return intent('speak_slower', {}, false, 1);
  }
  if (has(t, 'speak faster', 'talk faster')) {
    return intent('speak_faster', {}, false, 1);
  }
  if (has(t, 'more detail', 'give more details', 'longer answer', 'detailed description')) {
    return intent('more_detail', {}, false, 1);
  }
  if (has(t, 'shorter answer', 'give a shorter answer', 'be brief')) {
    return intent('shorter_answer', {}, false, 1);
  }
  if (has(t, 'turn hazard vibration on', 'hazard vibration on', 'vibration on', 'vibration only')) {
    return intent('change_setting', { setting: 'hazardVibration', value: true }, false, 1);
  }
  if (has(t, 'turn hazard vibration off', 'hazard vibration off', 'vibration off')) {
    return intent('change_setting', { setting: 'hazardVibration', value: false }, false, 1);
  }
  if (has(t, 'voice warnings only', 'voice only', 'voice guidance on')) {
    return intent('change_setting', { setting: 'voiceWarnings', value: true }, false, 1);
  }
  if (has(t, 'turn voice guidance off', 'voice guidance off')) {
    return intent('change_setting', { setting: 'voiceGuidance', value: false }, false, 1);
  }
  if (has(t, 'increase speech speed', 'speech speed up')) {
    return intent('speak_faster', {}, false, 1);
  }
  if (has(t, 'switch to italian', 'speak italian')) {
    return intent('change_setting', { setting: 'language', value: 'it' }, false, 1);
  }
  if (has(t, 'switch to english', 'speak english')) {
    return intent('change_setting', { setting: 'language', value: 'en' }, false, 1);
  }

  // ── Open tabs / navigation between screens ──
  if (has(t, 'go home', 'open home', 'open the home screen', 'open dashboard')) {
    return intent('open_tab', { tab: 'home' }, false, 1);
  }
  if (has(t, 'open assist', 'open the camera', 'open camera', 'start camera')) {
    return intent('open_tab', { tab: 'tracking' }, false, 1);
  }
  if (has(t, 'open safe journey', 'open journey')) {
    return intent('open_tab', { tab: 'journey' }, false, 1);
  }
  if (has(t, 'open emergency', 'open sos', 'open safety')) {
    return intent('open_tab', { tab: 'sos' }, false, 1);
  }
  if (has(t, 'open reading', 'open read')) {
    return intent('open_tab', { tab: 'tracking', mode: 'reading' }, false, 1);
  }
  if (has(t, 'open saved places', 'open places', 'open my places')) {
    return intent('open_tab', { tab: 'routes' }, false, 1);
  }
  if (has(t, 'open trusted contacts', 'open contacts', 'open my contacts')) {
    return intent('open_tab', { tab: 'sos', section: 'contacts' }, false, 1);
  }
  if (has(t, 'open settings')) {
    return intent('open_tab', { tab: 'settings' }, false, 1);
  }
  if (has(t, 'open community', 'open reports')) {
    return intent('open_tab', { tab: 'community' }, false, 1);
  }
  if (has(t, 'what can i do', 'what can you do', 'help', 'what commands')) {
    return intent('help', {}, false, 1);
  }

  // ── Saved places / hazards ──
  if (has(t, 'list my saved places', 'list saved places', 'my saved places')) {
    return intent('list_places', {}, false, 1);
  }
  if (has(t, 'save this location as', 'save this as', 'save this place')) {
    const m = /save this (?:location|place)?\s*(?:as|as my)?\s*(.+?)(?:\.|$)/.exec(t);
    return intent('save_place', { label: m?.[1]?.trim() ?? 'Saved place' }, true, 0.95);
  }
  if (has(t, 'report broken pavement', 'report construction', 'report hazard', 'report a hazard')) {
    const cat = has(t, 'broken pavement') ? 'broken-pavement' : has(t, 'construction') ? 'construction' : 'hazard';
    return intent('report_hazard', { category: cat }, true, 0.95);
  }
  if (has(t, 'what hazards are nearby', 'hazards nearby')) {
    return intent('report_hazard', { query: 'nearby' }, false, 0.95);
  }

  // ── Speech control ──
  if (has(t, 'stop speaking', 'be quiet', 'silence', 'shut up')) {
    return intent('stop_speech', {}, false, 1);
  }
  if (has(t, 'repeat that', 'repeat last', 'say that again', 'repeat the last warning')) {
    return intent('repeat', {}, false, 1);
  }

  // ── Confirmation words (handled by the confirmation manager, not as commands) ──
  if (t === 'confirm' || t === 'yes' || t === 'yeah' || t === 'go ahead' || t === 'ok' || t === 'okay') {
    return intent('confirm', {}, false, 1);
  }
  if (t === 'cancel' || t === 'no' || t === 'never mind' || t === 'stop') {
    return intent('cancel', {}, false, 1);
  }

  return null;
}
