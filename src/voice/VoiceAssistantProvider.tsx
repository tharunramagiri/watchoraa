// Central voice assistant provider (v0.5). One coordinated service for all
// voice input: mic lifecycle, speech recognition, push-to-talk, hands-free
// wake-phrase listening, command routing, confirmation, and error recovery.
// All voice output still goes through the existing speech-priority system.
//
// Hands-free is the DEFAULT control mode (blind users cannot be expected to
// find and tap a mic button): the app listens continuously, ignores everything
// until it hears a wake phrase ("Hey Watchora"), and then routes the command
// that follows. Push-to-talk remains as a fallback for when hands-free is
// disabled, permission is denied, or the browser does not support the API.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommandRouter, LOW_CONFIDENCE_MESSAGE } from './commandRouter';
import { matchDeterministicCommand } from './deterministicCommands';
import { matchFeelingPhrase } from './companion';
import { EMERGENCY_PRIORITY_INTENTS } from './voiceTypes';
import { ConfirmationManager } from './confirmationManager';
import { DEFAULT_VOICE_SETTINGS, isHandsFree, HANDS_FREE_ONBOARDING, MIC_PERMISSION_REQUEST, type VoiceIntent, type VoiceSettings } from './voiceTypes';
import { loadVoiceSettings, saveVoiceSettings } from './voiceSettingsStorage';
import { decideHandsFreeAction } from './handsFreeSession';

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'paused'
  | 'permission-needed'
  | 'offline'
  | 'error'
  | 'unsupported';

export interface VoiceAssistantApi {
  state: VoiceState;
  transcript: string;
  lastIntent: VoiceIntent | null;
  supported: boolean;
  micPermission: boolean;
  settings: VoiceSettings;
  setSettings: (s: Partial<VoiceSettings>) => void;
  startListening: () => void;
  stopListening: () => void;
  toggleListening: () => void;
  speak: (text: string) => void;
  routeText: (text: string) => Promise<VoiceIntent>;
  handleTranscript: (text: string) => Promise<void>;
  confirmation: ConfirmationManager;
  /** True when hands-free listening is active or paused (i.e. the mode is on). */
  handsFree: boolean;
  /** True when a wake phrase has been heard and a command is expected next. */
  wakeArmed: boolean;
}

const Ctx = createContext<VoiceAssistantApi | null>(null);

export function useVoiceAssistant(): VoiceAssistantApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVoiceAssistant must be used inside VoiceAssistantProvider');
  return v;
}

export type VoiceAssistantProps = {
  children: ReactNode;
  onCommand: (intent: VoiceIntent) => void;
  /** Fired when the user starts talking (barge-in): stops any in-progress speech. */
  onBargeIn?: () => void;
  speak: (text: string, priority?: number, dedupeKey?: string) => void;
  getVoiceSettings?: () => VoiceSettings;
  /** Optional AI intent parser (Gemini) for flexible wording. */
  aiParser?: CommandRouter['aiParser'];
  offline?: boolean;
  /** Bridge whose onSpeechChange the provider subscribes to, so recognition
   * pauses while Watchora itself is speaking (the mic would otherwise hear
   * its own voice and could loop). Optional for tests. */
  bridge?: { current: { onSpeechChange: ((speaking: boolean) => void) | null } };
};

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getRecognitionCtor(): (new () => RecognitionLike) | undefined {
  const w = window as Window & { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

/** How long to keep waiting for the command after a bare wake phrase. */
const WAKE_COMMAND_TIMEOUT_MS = 12_000;
/** Delay before restarting recognition after it ends (Chrome drops the
 * connection periodically; a short pause avoids a hot error loop). */
const RESTART_DELAY_MS = 700;
/** Delay after TTS finishes before listening resumes (let echo fade). */
const RESUME_AFTER_SPEECH_MS = 450;

export function VoiceAssistantProvider({ children, onCommand, speak: speakProp, getVoiceSettings, aiParser, offline, onBargeIn, bridge }: VoiceAssistantProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [lastIntent, setLastIntent] = useState<VoiceIntent | null>(null);
  const [settings, setSettingsState] = useState<VoiceSettings>(() => getVoiceSettings?.() ?? loadVoiceSettings(DEFAULT_VOICE_SETTINGS));
  const [micPermission, setMicPermission] = useState<boolean>(() => (typeof navigator !== 'undefined' ? true : false));
  const [wakeArmed, setWakeArmed] = useState(false);

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const routerRef = useRef<CommandRouter | null>(null);
  const confirmRef = useRef<ConfirmationManager | null>(null);
  const speakRef = useRef(speakProp);
  const onCommandRef = useRef(onCommand);
  const onBargeInRef = useRef(onBargeIn);
  // activeRef: true while a recognition instance is actually live.
  const activeRef = useRef(false);
  // handsFreeOnRef: the hands-free session is enabled (may be paused for
  // speech or by the user; distinct from "a recognition instance is live").
  const handsFreeOnRef = useRef(false);
  const pausedByUserRef = useRef(false);
  const speechActiveRef = useRef(false);
  const wakeArmedRef = useRef(false);
  const welcomedRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopIntentionalRef = useRef(false);
  const permissionDeniedRef = useRef(false);
  const appliedLangRef = useRef<string | null>(null);
  const appliedWakeRef = useRef<boolean | null>(null);

  speakRef.current = speakProp;
  onCommandRef.current = onCommand;
  onBargeInRef.current = onBargeIn;

  if (!routerRef.current) routerRef.current = new CommandRouter({ aiParser, offline: offline ?? false });
  if (!confirmRef.current) confirmRef.current = new ConfirmationManager();

  const router = routerRef.current;
  const confirmation = confirmRef.current;
  const supported = useMemo(() => typeof getRecognitionCtor() === 'function', []);

  const handsFree = isHandsFree(settings);

  useEffect(() => {
    router.setOffline(offline ?? false);
  }, [offline, router]);

  useEffect(() => {
    router.setAiParser(aiParser ?? null);
  }, [aiParser, router]);

  // Keep handsFreeOnRef in sync with the setting, and (re)start/stop the
  // session when the mode flips. Also restart recognition when the wake
  // phrase or language setting changes, so the live session always reflects
  // the user's current choice.
  useEffect(() => {
    handsFreeOnRef.current = handsFree;
    const langChanged = appliedLangRef.current != null && appliedLangRef.current !== settings.language;
    const wakeChanged = appliedWakeRef.current != null && appliedWakeRef.current !== settings.wakePhraseEnabled;
    if (langChanged || wakeChanged) {
      appliedLangRef.current = null;
      appliedWakeRef.current = null;
      stopRecognition();
    }
    if (!handsFree) {
      pausedByUserRef.current = false;
      wakeArmedRef.current = false;
      setWakeArmed(false);
      stopRecognition();
    } else if (supported && !permissionDeniedRef.current) {
      resumeHandsFree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFree, supported, settings.language, settings.wakePhraseEnabled]);

  // Subscribe to speech lifecycle so recognition pauses while TTS plays.
  useEffect(() => {
    if (!bridge) return;
    bridge.current.onSpeechChange = (speaking: boolean) => {
      speechActiveRef.current = speaking;
      if (speaking) {
        // The mic would hear Watchora's own voice. Stop listening now;
        // it resumes after speech ends (RESUME_AFTER_SPEECH_MS).
        clearRestartTimer();
        clearResumeTimer();
        stopRecognition();
        if (handsFreeOnRef.current) {
          // Keep the session "on" but visually paused during speech.
          setState('speaking');
        }
      } else {
        if (handsFreeOnRef.current && !pausedByUserRef.current) {
          resumeTimerRef.current = setTimeout(() => {
            resumeTimerRef.current = null;
            resumeHandsFree();
          }, RESUME_AFTER_SPEECH_MS);
        }
      }
    };
    return () => {
      bridge.current.onSpeechChange = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      recognitionRef.current?.abort();
      clearRestartTimer();
      clearResumeTimer();
    };
  }, []);

  function clearRestartTimer() {
    if (restartTimerRef.current != null) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }

  function clearResumeTimer() {
    if (resumeTimerRef.current != null) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }

  const setSettings = useCallback((patch: Partial<VoiceSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveVoiceSettings(next);
      return next;
    });
  }, []);

  /** Routes a final transcript through the router and executes it. */
  const runCommand = useCallback(
    async (text: string) => {
      setState('processing');
      // Emotional companion: opt-in feeling phrases are matched locally
      // (deterministic, never sent to AI) and answered before the command
      // router sees them — "I'm scared" must never be treated as an unknown
      // command. Safety commands still win: if the transcript ALSO matches a
      // deterministic safety intent, the router path takes precedence below.
      const feeling = matchFeelingPhrase(text);
      const deterministicSafety = matchDeterministicCommand(text);
      const isSafetyCommand = deterministicSafety && EMERGENCY_PRIORITY_INTENTS.includes(deterministicSafety.intent);
      if (feeling && !isSafetyCommand) {
        speakRef.current(feeling.text, feeling.priority);
        setLastIntent({ intent: 'help', parameters: { companion: 'feeling' }, confidence: 1, requiresConfirmation: false, deterministic: true });
        setState('idle');
        return;
      }
      const intent = await router.route(text);
      setLastIntent(intent);
      if (confirmation.handleConfirmIntent(intent)) {
        setState('idle');
        return;
      }
      if (intent.intent === 'unknown') {
        speakRef.current(LOW_CONFIDENCE_MESSAGE, 5);
        setState('idle');
        return;
      }
      onCommandRef.current(intent);
      setState('idle');
    },
    [router, confirmation],
  );

  const stopRecognition = useCallback(() => {
    clearRestartTimer();
    if (activeRef.current || recognitionRef.current) {
      activeRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    }
  }, []);

  const stopListening = useCallback(() => {
    if (handsFreeOnRef.current) {
      // User pressed the button to pause hands-free mode entirely.
      pausedByUserRef.current = true;
      wakeArmedRef.current = false;
      setWakeArmed(false);
      stopRecognition();
      setState('paused');
      return;
    }
    stopRecognition();
    setState('idle');
  }, [stopRecognition]);

  const startHandsFree = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setState('unsupported');
      return;
    }
    if (activeRef.current) return; // already listening
    if (permissionDeniedRef.current) {
      setState('permission-needed');
      return;
    }
    // Barge-in: if the user is talking while TTS plays, stop the speech.
    if (speechActiveRef.current) onBargeInRef.current?.();
    activeRef.current = true;
    stopIntentionalRef.current = false;
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = settings.language === 'en' ? 'en-US' : settings.language === 'it' ? 'it-IT' : settings.language;
    appliedLangRef.current = settings.language;
    appliedWakeRef.current = settings.wakePhraseEnabled;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => {
      setState('listening');
      if (handsFreeOnRef.current && !welcomedRef.current) {
        welcomedRef.current = true;
        speakRef.current(HANDS_FREE_ONBOARDING, 5, 'hands-free-onboarding');
      }
    };
    rec.onresult = (event) => {
      if (speechActiveRef.current) return; // our own TTS, ignore
      let t = '';
      let isFinal = false;
      for (let i = 0; i < event.results.length; i++) {
        t += event.results[i][0].transcript;
        if ((event.results[i] as { isFinal?: boolean }).isFinal) isFinal = true;
      }
      t = t.trim();
      if (!t) return;
      setTranscript(t);
      if (!isFinal) {
        // Interim result: if the user has spoken while TTS was (just) going,
        // treat it as a barge-in. Otherwise wait for the final result.
        if (speechActiveRef.current) onBargeInRef.current?.();
        return;
      }
      // Barge-in: the user talked over speech that was still playing.
      if (speechActiveRef.current) onBargeInRef.current?.();

      const decision = decideHandsFreeAction({
        transcript: t,
        wakePhraseEnabled: settings.wakePhraseEnabled,
        wakeArmed: wakeArmedRef.current,
      });
      wakeArmedRef.current = decision.wakeArmed;
      setWakeArmed(decision.wakeArmed);

      if (decision.command) {
        void runCommand(decision.command);
        return;
      }
      if (decision.promptForCommand) {
        // "Hey Watchora" alone: prompt for the command.
        setState('listening');
        if ('vibrate' in navigator) navigator.vibrate([30, 40, 30]);
        speakRef.current('Yes?', 4, 'wake-yes');
        // Time out the armed state so we don't wait forever.
        clearRestartTimer();
        restartTimerRef.current = setTimeout(() => {
          restartTimerRef.current = null;
          if (wakeArmedRef.current) {
            wakeArmedRef.current = false;
            setWakeArmed(false);
          }
        }, WAKE_COMMAND_TIMEOUT_MS);
      }
      // No command and no prompt: the utterance was ignored (privacy).
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        permissionDeniedRef.current = true;
        setMicPermission(false);
        activeRef.current = false;
        recognitionRef.current = null;
        setState('permission-needed');
        speakRef.current(MIC_PERMISSION_REQUEST, 5, 'mic-permission-request');
        return;
      }
      if (event.error === 'network') {
        setState('offline');
      } else if (event.error === 'no-speech') {
        setState('idle');
      } else if (event.error === 'aborted') {
        // Restart below handles it.
      } else {
        setState('error');
      }
      activeRef.current = false;
      recognitionRef.current = null;
      // Hands-free keeps going through transient errors.
      if (handsFreeOnRef.current && !permissionDeniedRef.current && !stopIntentionalRef.current) {
        scheduleRestart();
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      activeRef.current = false;
      if (handsFreeOnRef.current && !stopIntentionalRef.current && !permissionDeniedRef.current) {
        // Chrome ends sessions periodically; silently restart.
        scheduleRestart();
      } else if (!handsFreeOnRef.current && !activeRef.current) {
        setState('idle');
      }
    };
    try {
      rec.start();
    } catch {
      activeRef.current = false;
      recognitionRef.current = null;
      // Some browsers block mic start without a user gesture. Fall back to
      // starting on the first interaction (see installGestureFallback).
      if (handsFreeOnRef.current && !permissionDeniedRef.current) {
        scheduleRestart();
      }
    }
  }, [settings.language, settings.wakePhraseEnabled, runCommand, stopRecognition]);

  function scheduleRestart() {
    clearRestartTimer();
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!activeRef.current && handsFreeOnRef.current && !pausedByUserRef.current && !speechActiveRef.current && !permissionDeniedRef.current) {
        startHandsFree();
      }
    }, RESTART_DELAY_MS);
  }

  function resumeHandsFree() {
    pausedByUserRef.current = false;
    if (!handsFreeOnRef.current) return;
    if (speechActiveRef.current) return;
    startHandsFree();
  }

  // One-time fallback: if the browser refused the first auto-start (usually
  // because the page needs a user gesture for mic access), arm hands-free on
  // the very next interaction anywhere. No button needed — any tap works.
  useEffect(() => {
    if (!supported || !handsFree || permissionDeniedRef.current) return;
    const tryStart = () => {
      if (activeRef.current || !handsFreeOnRef.current) return;
      startHandsFree();
    };
    // Only install if recognition is not already running shortly after mount.
    const firstCheck = setTimeout(() => {
      if (!activeRef.current) {
        window.addEventListener('pointerdown', tryStart, { once: true });
        window.addEventListener('keydown', tryStart, { once: true });
      }
    }, 1500);
    return () => {
      clearTimeout(firstCheck);
      window.removeEventListener('pointerdown', tryStart);
      window.removeEventListener('keydown', tryStart);
    };
  }, [supported, handsFree, startHandsFree]);

  const startListening = useCallback(() => {
    if (handsFreeOnRef.current) {
      // Resume the hands-free session. A tap is also a signal the user wants
      // voice control back, so clear any earlier permission denial.
      permissionDeniedRef.current = false;
      pausedByUserRef.current = false;
      setState('listening');
      startHandsFree();
      return;
    }
    // Push-to-talk one-shot.
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setState('unsupported');
      return;
    }
    if (activeRef.current) {
      stopListening();
      return;
    }
    onBargeInRef.current?.();
    activeRef.current = true;
    stopIntentionalRef.current = false;
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = settings.language === 'en' ? 'en-US' : settings.language === 'it' ? 'it-IT' : settings.language;
    rec.continuous = false;
    rec.interimResults = true;
    rec.onstart = () => setState('listening');
    rec.onresult = (event) => {
      let t = '';
      for (let i = 0; i < event.results.length; i++) {
        t += event.results[i][0].transcript;
      }
      setTranscript(t.trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setMicPermission(false);
        setState('permission-needed');
      } else if (event.error === 'network') {
        setState('offline');
      } else if (event.error === 'no-speech') {
        setState('idle');
      } else {
        setState('error');
      }
      activeRef.current = false;
      recognitionRef.current = null;
    };
    rec.onend = () => {
      activeRef.current = false;
      recognitionRef.current = null;
      if (!handsFreeOnRef.current) setState('idle');
    };
    try {
      rec.start();
    } catch {
      setState('error');
      activeRef.current = false;
      recognitionRef.current = null;
    }
  }, [settings.language, startHandsFree, stopListening]);

  const toggleListening = useCallback(() => {
    if (handsFreeOnRef.current) {
      if (activeRef.current || state === 'speaking') {
        stopListening();
      } else {
        startListening();
      }
      return;
    }
    if (activeRef.current) stopListening();
    else startListening();
  }, [handsFreeOnRef, activeRef, state, stopListening, startListening]);

  const routeText = useCallback(
    async (text: string): Promise<VoiceIntent> => {
      setState('processing');
      const intent = await router.route(text);
      setLastIntent(intent);
      if (confirmation.handleConfirmIntent(intent)) {
        setState('idle');
        return intent;
      }
      return intent;
    },
    [router, confirmation],
  );

  const handleTranscript = useCallback(
    async (text: string) => {
      const intent = await routeText(text);
      if (intent.intent === 'unknown') {
        speakRef.current(LOW_CONFIDENCE_MESSAGE, 5);
        setState('idle');
        return;
      }
      onCommandRef.current(intent);
      setState('idle');
    },
    [routeText],
  );

  // Auto-start hands-free on mount if it is the default mode. Deliberately
  // runs after children effects so App.tsx has registered the voice bridge.
  useEffect(() => {
    if (handsFree && supported && !permissionDeniedRef.current) {
      const t = setTimeout(() => {
        resumeHandsFree();
      }, 600);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api: VoiceAssistantApi = {
    state,
    transcript,
    lastIntent,
    supported,
    micPermission,
    settings,
    setSettings,
    startListening,
    stopListening,
    toggleListening,
    speak: (text: string) => speakRef.current(text, 5),
    routeText,
    handleTranscript,
    confirmation,
    handsFree,
    wakeArmed,
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
