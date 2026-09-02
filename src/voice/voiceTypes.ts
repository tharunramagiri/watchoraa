// Voice assistant shared types (v0.4 voice-first PWA).

export type VoiceIntentName =
  | 'describe_scene'
  | 'read_text'
  | 'start_navigation'
  | 'start_safe_journey'
  | 'stop_safe_journey'
  | 'check_journey'
  | 'i_am_safe'
  | 'i_am_lost'
  | 'i_arrived'
  | 'emergency'
  | 'cancel_emergency'
  | 'send_location'
  | 'contact_trusted_person'
  | 'who_acknowledged'
  | 'repeat'
  | 'stop_speech'
  | 'speak_slower'
  | 'speak_faster'
  | 'more_detail'
  | 'shorter_answer'
  | 'change_setting'
  | 'permission_status'
  | 'open_tab'
  | 'help'
  | 'confirm'
  | 'cancel'
  | 'report_hazard'
  | 'list_places'
  | 'save_place'
  | 'set_coach_mode'
  | 'shopping'
  | 'identify_color'
  | 'identify_currency'
  | 'read_expiry'
  | 'scan_product'
  | 'teach_thing'
  | 'find_thing'
  | 'follow_up'
  | 'unknown';

export interface VoiceIntent {
  intent: VoiceIntentName;
  parameters: Record<string, string | number | boolean>;
  confidence: number; // 0..1
  requiresConfirmation: boolean;
  /** True when matched by the deterministic router (not AI). */
  deterministic: boolean;
}

/** Intents that must never be executed without explicit confirmation. */
export const CONFIRMATION_REQUIRED: VoiceIntentName[] = [
  'emergency',
  'cancel_emergency',
  'stop_safe_journey',
  'send_location',
  'contact_trusted_person',
  'save_place',
  'report_hazard',
];

/** Safety-critical intents that take highest speech priority (1). */
export const EMERGENCY_PRIORITY_INTENTS: VoiceIntentName[] = ['emergency', 'cancel_emergency', 'send_location', 'i_am_lost'];

export interface VoiceSettings {
  language: string;
  voice: string;
  speechRate: number;
  verbosity: 0 | 1 | 2; // essential | standard | detailed
  /** When true, commands must be preceded by a wake phrase ("Hey Watchora"). */
  wakePhraseEnabled: boolean;
  /** When false, Watchora is hands-free: it listens continuously and needs
   * no button tap. When true, the user taps the mic button (push-to-talk). */
  pushToTalk: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  language: 'en',
  voice: 'en-US-JennyNeural',
  speechRate: 1,
  verbosity: 1,
  // Voice-first by default: blind users cannot be expected to find and tap a
  // mic button every time they want to control the app. Wake phrase + hands-
  // free listening is the primary control mode; push-to-talk is the fallback.
  wakePhraseEnabled: true,
  pushToTalk: false,
};

/** True when the app should listen without any button interaction. */
export function isHandsFree(settings: VoiceSettings): boolean {
  return !settings.pushToTalk;
}

export interface ConfirmationRequest {
  id: string;
  intent: VoiceIntentName;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const HELP_MESSAGE =
  'You can say: describe what is ahead, read this, what money is this, what color is this, read the expiry, scan the barcode, find my keys, tell me more, start a safe journey, emergency, or open settings.';

/** Spoken once per session when hands-free voice control arms successfully. */
export const HANDS_FREE_ONBOARDING =
  'Voice control is on. You do not need to touch the screen. Say Hey Watchora, then your command. For example, Hey Watchora, describe what is ahead.';

/** Spoken when the microphone permission is missing but hands-free is on. */
export const MIC_PERMISSION_REQUEST =
  'Watchora needs your microphone so you can control it by voice without touching the screen. Please allow the microphone when your browser asks.';
