import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, getToken, getRefreshToken, setSession, clearSession, setToken, localeFromVoice, getCachedUser, setCachedUser } from './api';
import { scanBarcode, cachedProduct, rememberProduct, formatProductSpeech, type ScanHandle } from './barcode/productScan';
import type {
  AdminAssistanceRequest,
  AdminIncident,
  AdminUser,
  AiStats,
  AssistanceRequest,
  CaregiverLiveLocation,
  CaregiverOverview,
  ConsentGrant,
  EmergencySession,
  IncidentReport,
  PromptVersion,
  PublicUser,
  ReadingEntry,
  SafeJourney,
  SavedPlace,
  TrustedContact,
  TtsVoice,
} from './api';
import { useHazardDetection } from './useHazardDetection';
import { useNavigationCoach } from './navigation/useNavigationCoach';
import { useDeviceMotion } from './navigation/useDeviceMotion';
import { playDirectionalCue } from './navigation/spatialAudio';
import type { CoachDetection, CoachMode } from './navigation/navigationCoach';
import { fireHapticEvent, type HapticSettings } from './haptics';
import { getCurrentPosition, describeRelativePosition, type Coordinates } from './geo';
import { recognizeText, OCR_FALLBACK_CONFIDENCE_THRESHOLD } from './ocr';
import { SpeechPriorityManager, type SpeechPriority } from './speechPriority';
import { LiveAnnouncer, useLiveAnnouncer } from './accessibility/LiveAnnouncer';
import { useFocusTrap } from './accessibility/FocusManager';
import { PermissionService } from './permissions/permissionService';
import { PermissionOnboarding, type OnboardingResult } from './permissions/PermissionOnboarding';
import { PermissionCenter } from './permissions/PermissionCenter';
import { VoiceAssistantProvider, useVoiceAssistant } from './voice/VoiceAssistantProvider';
import type { VoiceSettings } from './voice/voiceTypes';
import { VoiceFirstDashboard, type DashboardTab } from './pages/VoiceFirstDashboard';
import { PermissionSettings } from './pages/PermissionSettings';

import type { VoiceIntent } from './voice/voiceTypes';
import { HELP_MESSAGE } from './voice/voiceTypes';
import type { VoiceBridge } from './VoiceFirstShell';
import { LandingPage } from './LandingPage';
import { VoiceFirstShell, createVoiceBridge, usePermissionService } from './VoiceFirstShell';
import { getVoiceTestPhrase, getStepSpeech, getPhoneticFallback } from './voice/voicePhrases';

import { MapView } from './MapView';
type TabKey = 'home' | 'tracking' | 'routes' | 'journey' | 'sos' | 'community' | 'caregiver' | 'settings' | 'admin';
type Tone = 'online' | 'busy' | 'warning' | 'error';

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

const tabs: Array<{ key: TabKey; label: string; icon: string; note: string }> = [
  { key: 'home', label: 'Home', icon: '🏠', note: 'Command centre' },
  { key: 'tracking', label: 'Assist', icon: '📍', note: 'Camera + voice' },
  { key: 'routes', label: 'Places', icon: '🗺️', note: 'Saved places' },
  { key: 'journey', label: 'Safe Journey', icon: '🛡️', note: 'Safety monitoring' },
  { key: 'sos', label: 'SOS', icon: '🚨', note: 'Emergency' },
  { key: 'community', label: 'Community', icon: '👥', note: 'Reports' },
  { key: 'caregiver', label: 'Caregiver', icon: '🤝', note: 'People you support' },
  { key: 'settings', label: 'Settings', icon: '⚙️', note: 'Voice and account' },
  { key: 'admin', label: 'Admin', icon: '🛠️', note: 'Operations' },
];

type AnalysisMode = 'navigation' | 'assistant' | 'reading' | 'environment';

type AiResult = {
  mode: AnalysisMode;
  summary: string;
  details: string[];
  warnings: string[];
  confidence: 'low' | 'medium' | 'high';
  shouldStop: boolean;
  demo: boolean;
  // Where this result actually came from — surfaced in the UI so "local OCR" is
  // never mislabeled as "Gemini live" (a real bug caught during live verification
  // of Phase B: the source pill previously only checked `demo`, which is false
  // for both a genuine Gemini call and a local Tesseract.js read).
  source: 'gemini' | 'local-ocr';
};

const ANALYSIS_TIMEOUT_MS = 20_000;

const analysisModes: Array<{ key: AnalysisMode; label: string }> = [
  { key: 'navigation', label: 'Navigation' },
  { key: 'environment', label: 'Environment' },
  { key: 'reading', label: 'Reading' },
  { key: 'assistant', label: 'Assistant' },
];

function compressImage(canvas: HTMLCanvasElement, maxDimension = 1280, quality = 0.8): string {
  const { width, height } = canvas;
  const scale = Math.min(1, maxDimension / Math.max(width, height));

  if (scale >= 1) {
    return canvas.toDataURL('image/jpeg', quality);
  }

  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = Math.round(width * scale);
  scaledCanvas.height = Math.round(height * scale);
  const context = scaledCanvas.getContext('2d');
  if (!context) return canvas.toDataURL('image/jpeg', quality);

  context.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
  return scaledCanvas.toDataURL('image/jpeg', quality);
}

function AuthScreen({
  onAuthenticated,
  initialMode = 'login',
  onClose,
}: {
  onAuthenticated: (user: PublicUser) => void;
  initialMode?: 'login' | 'signup';
  onClose?: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [flow, setFlow] = useState<'auth' | 'forgot' | 'reset'>('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  // Blind-user-perspective audit (2026-08-07): this dialog had role=dialog
  // aria-modal=true but no actual focus trap, so Tab could escape into the
  // page behind it and focus was never restored to the triggering control
  // on close — both real screen-reader/keyboard usability defects, not just
  // Lighthouse-invisible ones (Lighthouse does not check for a real trap).
  const authDialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(authDialogRef, true);
  const [resetToken, setResetToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setError('');
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (mode === 'signup' && !fullName.trim()) {
      setError('Enter your name.');
      return;
    }

    setLoading(true);
    try {
      const result =
        mode === 'signup'
          ? await api.signup({ email: email.trim(), password, fullName: fullName.trim() })
          : await api.login({ email: email.trim(), password });
      setSession(result.token, result.refreshToken);
      onAuthenticated(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Is the backend running?');
    } finally {
      setLoading(false);
    }
  }

  async function forgot() {
    setError('');
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    setLoading(true);
    try {
      const result = await api.forgotPassword(email.trim());
      const msg = result.devToken
        ? `Reset issued. Dev token (self-hosted, no email configured): ${result.devToken} — open Settings → Forgot password → enter it below.`
        : 'If an account exists, a reset link has been issued.';
      setError(msg);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a reset.');
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    setError('');
    if (!resetToken.trim() || password.length < 8) {
      setError('Enter the reset token and a new password (at least 8 characters).');
      return;
    }
    setLoading(true);
    try {
      const result = await api.resetPassword(resetToken.trim(), password);
      setSession(result.token, result.refreshToken);
      setResetToken('');
      onAuthenticated(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset your password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="onboarding-backdrop" ref={authDialogRef} role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <section className="panel onboarding-card">
        <div className="section-head">
          <div>
            <p className="topbar-kicker">watchora</p>
            <h2 id="auth-title">{mode === 'signup' ? 'Create your account' : 'Sign in'}</h2>
          </div>
          {onClose ? (
            <button className="ghost-btn" onClick={onClose} aria-label="Close">
              ✕
            </button>
          ) : null}
        </div>
        <div className="form-stack">
          {flow === 'forgot' ? (
            <>
              <label>
                <span>Email</span>
                <input aria-label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
              </label>
              {error ? (
                <p role="alert" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
                  {error}
                </p>
              ) : null}
              <button className="primary-btn" onClick={forgot} disabled={loading}>
                {loading ? 'Please wait…' : 'Send reset link'}
              </button>
              <button className="ghost-btn" onClick={() => setFlow('auth')}>
                Back to sign in
              </button>
            </>
          ) : flow === 'reset' ? (
            <>
              <label>
                <span>Reset token</span>
                <input aria-label="Reset token" value={resetToken} onChange={(event) => setResetToken(event.target.value)} placeholder="Paste the reset token" />
              </label>
              <label>
                <span>New password</span>
                <input aria-label="New password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                />
              </label>
              {error ? (
                <p role="alert" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
                  {error}
                </p>
              ) : null}
              <button className="primary-btn" onClick={reset} disabled={loading}>
                {loading ? 'Please wait…' : 'Set new password'}
              </button>
              <button className="ghost-btn" onClick={() => setFlow('auth')}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              {mode === 'signup' ? (
                <label>
                  <span>Full name</span>
                  <input aria-label="Full name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your name" />
                </label>
              ) : null}
              <label>
                <span>Email</span>
                <input aria-label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
              </label>
              <label>
                <span>Password</span>
                <input aria-label="Password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  onKeyDown={(event) => event.key === 'Enter' && submit()}
                />
              </label>
              {error ? (
                <p role="alert" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              ) : null}
              <button className="primary-btn" onClick={submit} disabled={loading}>
                {loading ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
              </button>
              <button className="ghost-btn" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
                {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
              </button>
              {mode === 'login' ? (
                <button className="ghost-btn" onClick={() => setFlow('forgot')}>
                  Forgot your password?
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const voiceBridge = useRef(createVoiceBridge());

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setAuthChecked(true);
      return;
    }
    api
      .me()
      .then(({ user }) => {
        setCachedUser(user);
        setCurrentUser(user);
      })
      .catch(() => {
        // Offline or server unreachable: keep the last-known session so the
        // shell, dashboard, and local capabilities (OCR, hazard layer, saved
        // places, emergency info) still work. The token stays in place so the
        // session refreshes the moment connectivity returns. A real 401 already
        // cleared the session in the request layer before reaching here.
        const cached = getCachedUser();
        if (cached) {
          setCurrentUser(cached);
        } else {
          clearSession();
        }
      })
      .finally(() => setAuthChecked(true));
  }, []);

  function handleLogout() {
    // Best-effort server-side revoke of the refresh token, then clear locally.
    api.logout(getRefreshToken() ?? undefined).catch(() => {});
    clearSession();
    setCurrentUser(null);
  }

  if (!authChecked) return null;

  if (!currentUser) {
    // Logged-out front door: the landing page IS the index route. The existing
    // AuthScreen dialog opens on top when someone chooses to sign in / sign up,
    // instead of being the first thing a visitor sees.
    return (
      <>
        <LandingPage
          onSignIn={() => {
            setAuthMode('login');
            setAuthOpen(true);
          }}
          onSignUp={() => {
            setAuthMode('signup');
            setAuthOpen(true);
          }}
        />
        {authOpen ? (
          <AuthScreen
            initialMode={authMode}
            onAuthenticated={(user) => {
              setAuthOpen(false);
              setCachedUser(user);
              setCurrentUser(user);
            }}
            onClose={() => setAuthOpen(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <VoiceFirstShell bridge={voiceBridge}>
      <MainApp user={currentUser} onLogout={handleLogout} voiceBridge={voiceBridge} />
    </VoiceFirstShell>
  );
}

function MainApp({
  user,
  onLogout,
  voiceBridge,
}: {
  user: PublicUser;
  onLogout: () => void;
  voiceBridge: { current: VoiceBridge };
}) {
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const permissionService = usePermissionService();
  const voiceAssistant = useVoiceAssistant();
  const [showPermissions, setShowPermissions] = useState(false);
  const [statusMessage, setStatusMessage] = useState(`Signed in as ${user.fullName}`);
  const [statusTone, setStatusTone] = useState<Tone>('online');
  const [prompt, setPrompt] = useState('Describe the environment in front of me and warn about obstacles.');
  const [response, setResponse] = useState('Live camera output will appear here.');
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('navigation');
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [voiceRate, setVoiceRate] = useState(1.05);
  const [language, setLanguage] = useState('English');
  const [voice, setVoice] = useState('en-US-JennyNeural');
  // Mirrors for the speech manager: it is created once, so its play closure
  // reads the ref instead of the render-scoped state (which would freeze at
  // first-render values forever).
  const voiceRateRef = useRef(voiceRate);
  const voiceRef = useRef(voice);
  voiceRateRef.current = voiceRate;
  voiceRef.current = voice;
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [themeMode, setThemeMode] = useState<'Light' | 'Dark'>('Light');
  const [hazardLayerEnabled, setHazardLayerEnabled] = useState(true);
  // Vision coaching mode (v0.5): proactive, deterministic navigation/reading/
  // exploration/shopping guidance layered on the local hazard detections.
  const [coachMode, setCoachMode] = useState<CoachMode>('off');
  const [hapticSettings, setHapticSettings] = useState<HapticSettings>({
    hapticsEnabled: true,
    toneEnabled: true,
    intensity: 'medium',
  });

  const [places, setPlaces] = useState<SavedPlace[] | null>(null);
  const [contacts, setContacts] = useState<TrustedContact[] | null>(null);
  const [incidents, setIncidents] = useState<IncidentReport[] | null>(null);
  const [assistanceRequests, setAssistanceRequests] = useState<AssistanceRequest[] | null>(null);
  const [readingEntries, setReadingEntries] = useState<ReadingEntry[] | null>(null);
  const prefsLoadedRef = useRef(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingKey = `watchora_onboarding_${user.id}`;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const speechLockRef = useRef(false);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsUrlRef = useRef<string | null>(null);
  const speakSeqRef = useRef(0);
  // Active barcode scan (so a new scan stops the previous loop).
  const productScanRef = useRef<ScanHandle | null>(null);
  const speechManagerRef = useRef<SpeechPriorityManager | null>(null);
  const lastSpokenRef = useRef('');
  // Tracks how many utterances are currently playing so the voice provider
  // can pause mic recognition while Watchora itself is talking (its own
  // voice in the mic would otherwise trigger spurious wake phrases/loops).
  const speechActiveCountRef = useRef(0);
  function setSpeechActive(on: boolean) {
    if (on) speechActiveCountRef.current += 1;
    else speechActiveCountRef.current = Math.max(0, speechActiveCountRef.current - 1);
    voiceBridge.current.onSpeechChange?.(speechActiveCountRef.current > 0);
  }

  // Priority-aware speech: danger/emergency interrupts anything lower.
  // voice/voiceRate live in refs so the once-created manager never speaks with
  // stale settings — settings changes must apply to the very next utterance.
  function speakWithPriority(text: string, priority: SpeechPriority = 5, dedupeKey?: string, rateOverride?: number) {
    if (!speechManagerRef.current) {
      speechManagerRef.current = new SpeechPriorityManager({
        play: (t, p, customRate) => {
          stopSpeaking();
          const seq = ++speakSeqRef.current;
          const locale = localeFromVoice(voiceRef.current);
          const effectiveRate = customRate ?? voiceRateRef.current;
          api
            .ttsAudioUrl(t, voice, effectiveRate)
            .then((url) => {
              if (seq !== speakSeqRef.current) {
                URL.revokeObjectURL(url);
                return;
              }
              ttsUrlRef.current = url;
              const audio = new Audio(url);
              ttsAudioRef.current = audio;
              audio.playbackRate = 1.0;
              // Recognition must pause while we talk: the mic would hear our
              // own voice and could loop. Signal both edges here.
              audio.onplay = () => setSpeechActive(true);
              audio.onended = () => {
                if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
                if (ttsUrlRef.current) {
                  URL.revokeObjectURL(ttsUrlRef.current);
                  ttsUrlRef.current = null;
                }
                setSpeechActive(false);
                fallbackSpeak(t, locale, effectiveRate);
                speechManagerRef.current?.onEnded();
              };
              audio.onerror = () => {
                if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
                if (ttsUrlRef.current) {
                  URL.revokeObjectURL(ttsUrlRef.current);
                  ttsUrlRef.current = null;
                }
                setSpeechActive(false);
                fallbackSpeak(t, locale, effectiveRate);
                speechManagerRef.current?.onEnded();
              };
              audio.play().catch(() => {
                if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
                if (ttsUrlRef.current) {
                  URL.revokeObjectURL(ttsUrlRef.current);
                  ttsUrlRef.current = null;
                }
                fallbackSpeak(t, locale, effectiveRate);
                setSpeechActive(false);
                speechManagerRef.current?.onEnded();
              });
            })
            .catch(() => {
              if (seq !== speakSeqRef.current) return;
              fallbackSpeak(t, locale, effectiveRate);
              speechManagerRef.current?.onEnded();
            });
        },
        stop: () => stopSpeaking(),
      });
    }
    speechManagerRef.current.speak({ text, priority, dedupeKey, rate: rateOverride });
  }

  // Same fallback contract as api.ts: same-origin when deployed, localhost
  // only when actually running on a dev machine (never in a production build).
  const isDevHost = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? (isDevHost ? 'http://127.0.0.1:4000' : '');

  // Phase A: local, low-latency hazard detection (YOLOv8n via onnxruntime-web, in a
  // Web Worker). Runs continuously while the camera is on, independent of the
  // on-demand Gemini "Capture & analyze" flow — see docs/yolo-ocr-slam-plan.md.
  const hazardState = useHazardDetection(videoRef, cameraActive && hazardLayerEnabled, hapticSettings);

  // Real-device performance audit (2026-08-07) found the YOLOv8n model is
  // ~12MB — on throttled mobile data (e.g. 4G) that can take up to a minute
  // on a first-ever visit before local hazard detection is ready (cached by
  // the service worker after that, so it's a one-time cost). The visual
  // status bar already says "Loading local detection model…" but its
  // aria-live is off unless a hazard exists, so a blind user got total
  // silence during that wait. Speak the state transitions explicitly so
  // they always know detection is starting up rather than broken.
  const hazardWarmupSpokenRef = useRef(false);
  const hazardSlowWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hazardState.status === 'warming-up' && !hazardWarmupSpokenRef.current) {
      hazardWarmupSpokenRef.current = true;
      speak('Loading local hazard detection. This can take a little while on a slow connection, and only happens once.', 3, 'hazard-warmup');
      hazardSlowWarningTimerRef.current = setTimeout(() => {
        speak('Local hazard detection is still loading. You can keep using the camera in the meantime.', 3, 'hazard-warmup-slow');
      }, 15_000);
    }
    if (hazardState.status !== 'warming-up') {
      hazardWarmupSpokenRef.current = false;
      if (hazardSlowWarningTimerRef.current) {
        clearTimeout(hazardSlowWarningTimerRef.current);
        hazardSlowWarningTimerRef.current = null;
      }
    }
    return () => {
      if (hazardSlowWarningTimerRef.current) {
        clearTimeout(hazardSlowWarningTimerRef.current);
        hazardSlowWarningTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hazardState.status]);


  // ── Navigation Coach (v0.5): turns live detections into deterministic spoken
  // guidance (SPOTTED -> TRACKING -> PASSING -> CLEARED, directional + clock
  // positions, obstacle chaining, silence breaker). Safety output never depends
  // on AI. The onAnnounce callback speaks + haptics + pans a spatial cue.
  const coachDetections = useMemo<CoachDetection[]>(
    () => hazardState.detections.map((d) => ({ className: d.className, confidence: d.confidence, box: d.box })),
    [hazardState.detections],
  );
  // Motion cadence (v0.6): only active once the user has explicitly granted
  // the motion permission (PermissionOnboarding/PermissionCenter). Without it
  // the coach stays at the conservative stationary cadence — it never
  // pretends to sense motion it does not have permission to read.
  const motionGranted = permissionService.get('motion').state === 'allowed';
  const motionLevel = useDeviceMotion(motionGranted && coachMode !== 'off' && cameraActive);
  useNavigationCoach({
    active: coachMode !== 'off' && cameraActive && hazardLayerEnabled,
    detections: coachDetections,
    motion: motionLevel,
    onAnnounce: (a) => {
      if (a.haptic === 'hazard-immediate') fireHapticEvent('hazard-immediate', hapticSettings);
      else if (a.haptic === 'hazard-nearby') fireHapticEvent('hazard-nearby', hapticSettings);
      else if (a.haptic === 'clear') fireHapticEvent('clear', hapticSettings);
      playDirectionalCue(a.pan);
      speak(a.text, a.priority as SpeechPriority, a.dedupeKey);
    },
  });

  // Browser-speech fallback when the neural TTS service is unreachable.
  function fallbackSpeak(text: string, locale?: string, rate?: number) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const voices = window.speechSynthesis.getVoices() || [];
    const isMale = voice.toLowerCase().includes('guy') || voice.toLowerCase().includes('ryan') || voice.toLowerCase().includes('prabhat') || voice.toLowerCase().includes('madhur') || voice.toLowerCase().includes('valluvar') || voice.toLowerCase().includes('mohan') || voice.toLowerCase().includes('gagan') || voice.toLowerCase().includes('midhun') || voice.toLowerCase().includes('bashkar') || voice.toLowerCase().includes('alvaro') || voice.toLowerCase().includes('katja');
    const langPrefix = (locale || 'en').split('-')[0].toLowerCase();
    const langVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));

    let textToSpeak = text;
    let effectiveLang = locale || 'en-US';
    let chosenVoice: SpeechSynthesisVoice | null = null;

    if (langVoices.length > 0) {
      chosenVoice = langVoices.find((v) => {
        const name = v.name.toLowerCase();
        if (isMale && (name.includes('male') || name.includes('madhur') || name.includes('neel') || name.includes('hemant') || name.includes('valluvar') || name.includes('mohan') || name.includes('gagan') || name.includes('midhun') || name.includes('bashkar') || name.includes('alvaro') || name.includes('guy') || name.includes('david'))) return true;
        if (!isMale && (name.includes('female') || name.includes('swara') || name.includes('lekha') || name.includes('veena') || name.includes('pallavi') || name.includes('shruti') || name.includes('sapna') || name.includes('sobhana') || name.includes('tanishaa') || name.includes('dhwani') || name.includes('elvira') || name.includes('jenny') || name.includes('samantha'))) return true;
        return /natural|premium|enhanced|google|apple/i.test(name);
      }) || langVoices[0];
      effectiveLang = chosenVoice.lang || locale || 'en-US';
    } else {
      textToSpeak = getPhoneticFallback(text, voice);
      chosenVoice =
        voices.find((v) => v.lang.toLowerCase().startsWith('en-in') || v.lang.toLowerCase().includes('in')) ||
        voices.find((v) => {
          const name = v.name.toLowerCase();
          if (isMale && (name.includes('guy') || name.includes('daniel') || name.includes('male') || name.includes('david'))) return true;
          if (!isMale && (name.includes('jenny') || name.includes('samantha') || name.includes('karen') || name.includes('female') || name.includes('victoria') || name.includes('zira'))) return true;
          return /natural|premium|enhanced|google|apple/i.test(name);
        }) ||
        voices[0] ||
        null;
      effectiveLang = chosenVoice?.lang || 'en-IN';
    }

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = Math.max(0.5, Math.min(2.0, rate ?? voiceRate));
    utterance.pitch = 1;
    utterance.lang = effectiveLang;
    if (chosenVoice) utterance.voice = chosenVoice;

    // Signal the voice provider so microphone recognition pauses while we
    // talk (the mic would otherwise hear our own voice and could loop).
    utterance.onstart = () => setSpeechActive(true);
    utterance.onend = () => {
      setSpeechActive(false);
      speechManagerRef.current?.onEnded();
    };
    utterance.onerror = () => {
      setSpeechActive(false);
      speechManagerRef.current?.onEnded();
    };
    window.speechSynthesis.speak(utterance);
  }

  // High-quality neural speech: prefers the backend (free Edge neural voices,
  // 30+ languages incl. all Indian languages), falls back to the on-device
  // voice if the service is unavailable.
  // High-quality neural speech with priority: default priority 5 (navigation).
  // Danger/emergency call sites pass higher priorities (1-3) which interrupt.
  function speak(text: string, priority: SpeechPriority = 5, dedupeKey?: string, rateOverride?: number) {
    const cleanText = text.trim();
    if (!cleanText) return;
    lastSpokenRef.current = cleanText;
    speakWithPriority(cleanText, priority, dedupeKey, rateOverride);
  }

  function stopSpeaking() {
    speakSeqRef.current++; // invalidate any in-flight TTS
    ttsAudioRef.current?.pause();
    ttsAudioRef.current = null;
    if (ttsUrlRef.current) {
      URL.revokeObjectURL(ttsUrlRef.current);
      ttsUrlRef.current = null;
    }
    window.speechSynthesis?.cancel();
    // Nothing is speaking anymore; tell the voice provider it may resume
    // listening (any fallback utterance queued by the interrupt will signal
    // its own start shortly).
    speechActiveCountRef.current = 0;
    voiceBridge.current.onSpeechChange?.(false);
  }

  function announce(message: string, tone: Tone = 'online') {
    setStatusMessage(message);
    setStatusTone(tone);
  }

  // ── Voice command handler (v0.4): maps a parsed VoiceIntent to app actions.
  const journeyIntentRef = useRef<{ destination: string } | null>(null);
  const voiceEmergencyRef = useRef<(() => void) | null>(null);

  function handleVoiceCommand(intent: VoiceIntent) {
    const tab = (t: TabKey) => setActiveTab(t);
    const params = intent.parameters as Record<string, string>;
    switch (intent.intent) {
      case 'emergency':
        tab('sos');
        announce('Emergency requested. Confirm to share your location with trusted contacts.', 'error');
        speak('Emergency requested. Say confirm to share your location with trusted contacts, or cancel.', 1, 'emergency-voice');
        voiceEmergencyRef.current?.();
        break;
      case 'cancel_emergency':
        tab('sos');
        speak('Cancelling emergency. Say confirm to cancel, or cancel to abort.', 1, 'emergency-cancel-voice');
        voiceEmergencyRef.current?.();
        break;
      case 'describe_scene':
        tab('tracking');
        setAnalysisMode('navigation');
        void voiceCaptureAndAnalyze('navigation', 'Describe what is directly ahead of me in a few words, focusing on immediate obstacles and safe path.');
        break;
      case 'read_text':
        tab('tracking');
        setAnalysisMode('reading');
        void voiceCaptureAndAnalyze('reading', 'Read the text visible in this image aloud, word for word.');
        break;
      case 'identify_color':
        tab('tracking');
        setAnalysisMode('assistant');
        void voiceCaptureAndAnalyze('assistant', 'Identify the main color of the object in the center of this image. If the lighting makes it uncertain, say which colors it could be. One short sentence.');
        break;
      case 'identify_currency':
        tab('tracking');
        setAnalysisMode('assistant');
        void voiceCaptureAndAnalyze('assistant', 'This image shows money (a banknote or coin). Identify its denomination and currency. Note that lighting can mislead: tell me the visual marks you based this on. Never guess between two similar denominations.');
        break;
      case 'read_expiry':
        tab('tracking');
        setAnalysisMode('assistant');
        void voiceCaptureAndAnalyze('assistant', 'Find and read any expiry date, best-before date, or use-by date in this image. Read the date exactly as written. If no date is visible, say so plainly.');
        break;
      case 'scan_product': {
        tab('tracking');
        const runScan = async () => {
          if (!('geolocation' in navigator)) return; // unreachable guard; camera check below matters
          if (!videoRef.current) {
            speak('Turn on the camera first, then say scan the barcode again.', 5, 'scan-no-camera');
            return;
          }
          speak('Hold the camera steady over the barcode.', 5, 'scan-start');
          try {
            const handle = await scanBarcode(
              videoRef.current,
              (code) => {
                void navigator.vibrate?.(80);
                speak('Scanned. Looking up the product.', 5, 'scan-found');
                const cached = cachedProduct(code);
                const lookup = cached
                  ? Promise.resolve({ product: cached, cached: true })
                  : api
                      .productLookup(code)
                      .then((r) => {
                        if (r.product.found) rememberProduct(code, r.product);
                        return r;
                      });
                lookup
                  .then((r) => speak(formatProductSpeech(r.product), 5, `scan-${code}`))
                  .catch(() => speak('The product database is not reachable right now. You can say read this to have the label read aloud instead.', 5, 'scan-error'));
              },
              25_000,
            );
            productScanRef.current = handle;
          } catch {
            speak('Barcode scanning is not supported on this browser. You can say read this to have the label read aloud instead.', 5, 'scan-unsupported');
          }
        };
        if (cameraActive) {
          void runScan();
        } else {
          void (async () => {
            await startCamera();
            await runScan();
          })();
        }
        break;
      }
      case 'teach_thing': {
        tab('tracking');
        setAnalysisMode('assistant');
        const thingName = String(params.name || 'my thing');
        speak(`Learning ${thingName}. Hold it steady in the camera.`, 5, `teach-start-${thingName}`);
        void voiceCaptureAndAnalyze('assistant', `Describe this object in one short reusable description for recognition: its most distinctive visual features (color, shape, material, markings). No speculation.`);
        const stopWatchingTeach = setInterval(() => {
          const latest = aiResult;
          if (latest?.summary && !isAnalyzing) {
            clearInterval(stopWatchingTeach);
            void api
              .createThing(thingName, `${latest.summary} ${latest.details?.[0] ?? ''}`.trim())
              .then((r) => speak(`${r.updated ? 'Updated' : 'Learned'} ${thingName}. Say find my ${thingName} any time.`, 5, `teach-done-${thingName}`))
              .catch(() => speak('I could not save that object. Please try again.', 5, 'teach-error'));
          }
        }, 1200);
        setTimeout(() => clearInterval(stopWatchingTeach), 30_000);
        break;
      }
      case 'find_thing': {
        tab('tracking');
        const target = String(params.name || '').trim();
        if (!target) {
          speak('What is the object called?', 5, 'find-noname');
          break;
        }
        api
          .listThings(target)
          .then(async (r) => {
            const match = r.things[0];
            if (!match) {
              speak(`I do not know ${target} yet. Point the camera at it and say, teach this as ${target}.`, 5, `find-unknown-${target}`);
              return;
            }
            setAnalysisMode('assistant');
            speak(`Looking for ${target}.`, 5, `find-start-${target}`);
            await voiceCaptureAndAnalyze('assistant', `You are looking for the user's personal object called "${match.name}", previously described as: "${match.description}". Is that exact object visible in this image now? If yes, say "Found" and give its direction (left, right, ahead) and approximate distance if visually estimable. If it is not clearly present, say "Not found" and do not guess.`);
          })
          .catch(() => speak('I could not check your taught objects.', 5, 'find-error'));
        break;
      }
      case 'follow_up': {        tab('tracking');
        setAnalysisMode('assistant');
        const prior = aiResult;
        if (!prior) {
          speak('Nothing to add yet — point the camera and say describe what is ahead first.', 5, 'followup-empty');
          break;
        }
        const context = `Earlier you described this scene as: "${prior.summary}". The user wants MORE detail about the same scene, not a repeat. Describe what you did NOT mention before: background objects, signage, people and their direction of movement, or anything relevant beyond the first answer. Keep it under three sentences.`;
        void voiceCaptureAndAnalyze('assistant', context);
        break;
      }
      case 'start_safe_journey':
        tab('journey');
        if (params.destination) {
          journeyIntentRef.current = { destination: params.destination };
          speak(`Starting a safe journey to ${params.destination}. Review the details on the journey screen.`, 5, 'voice-journey-start');
        } else {
          speak('Safe Journey is open. Tell me the destination, or type it on the screen.', 5, 'voice-journey-open');
        }
        break;
      case 'stop_safe_journey':
        tab('journey');
        speak('Ending your safe journey. Say confirm, or cancel.', 3, 'voice-journey-stop');
        break;
      case 'check_journey':
        api
          .activeJourney()
          .then((r) => {
            if (r.journey) {
              speak(`Your active journey is to ${r.journey.destination}. Status is ${r.journey.status}.`, 5, 'voice-journey-check');
            } else {
              speak('You do not have an active journey.', 5, 'voice-journey-none');
            }
          })
          .catch(() => speak('I could not check your journey.', 5));
        break;
      case 'i_am_safe':
        api
          .activeJourney()
          .then((r) => {
            if (r.journey) {
              return api.journeyCheckIn(r.journey.id).then(() => speak('Checked in. I will keep monitoring.', 5, 'voice-safe'));
            }
            speak('You do not have an active journey.', 5);
            return undefined;
          })
          .catch(() => speak('I could not check you in.', 5));
        break;
      case 'i_arrived':
        api
          .activeJourney()
          .then((r) => {
            if (r.journey) {
              return api.endJourney(r.journey.id).then(() => speak('Journey completed. You are safe.', 4, 'voice-arrived'));
            }
            speak('You do not have an active journey.', 5);
            return undefined;
          })
          .catch(() => speak('I could not end the journey.', 5));
        break;
      case 'i_am_lost':
        tab('journey');
        api
          .activeJourney()
          .then((r) => {
            if (r.journey) return api.journeyLost(r.journey.id).then(() => speak('Help requested. Your trusted contact has been notified.', 2, 'voice-lost'));
            speak('You do not have an active journey. Say emergency if you need help now.', 5);
            return undefined;
          })
          .catch(() => speak('I could not request help.', 5));
        break;
      case 'send_location':
        tab('sos');
        speak('Sharing your location. Say confirm, or cancel.', 3, 'voice-share-loc');
        break;
      case 'permission_status':
        setShowPermissions(true);
        speak('Opening Permission Centre.', 5, 'voice-perms');
        break;
      case 'open_tab': {
        const target = (params.tab ?? 'home') as TabKey;
        if (tabs.some((t) => t.key === target)) tab(target);
        else tab('home');
        speak(`Opening ${tabs.find((t) => t.key === target)?.label ?? 'Home'}.`, 5, 'voice-open-tab');
        break;
      }
      case 'repeat':
        speak(lastSpokenRef.current || 'I have nothing to repeat yet.', 5, 'voice-repeat');
        break;
      case 'stop_speech':
        stopSpeaking();
        speak('Stopping speech. Emergency warnings remain active.', 5, 'voice-stop');
        break;
      case 'speak_slower':
        setVoiceRate((v) => Math.max(0.7, Number((v - 0.1).toFixed(2))));
        speak('Speaking slower.', 5, 'voice-slower');
        break;
      case 'speak_faster':
        setVoiceRate((v) => Math.min(1.5, Number((v + 0.1).toFixed(2))));
        speak('Speaking faster.', 5, 'voice-faster');
        break;
      case 'more_detail':
        speak('Switching to detailed descriptions.', 5, 'voice-detail');
        break;
      case 'shorter_answer':
        speak('Switching to short descriptions.', 5, 'voice-short');
        break;
      case 'change_setting': {
        const setting = params.setting;
        const value = params.value === 'true' || params.value === 'on';
        if (setting === 'hazardVibration') {
          setHapticSettings((h) => ({ ...h, hapticsEnabled: value }));
          speak(`Hazard vibration ${value ? 'on' : 'off'}.`, 5, 'voice-hvib');
        } else if (setting === 'voiceGuidance') {
          speak('Voice guidance is always available for safety. You can reduce verbosity in settings.', 5, 'voice-vguid');
        } else if (setting === 'language') {
          speak(`Language change to ${value} is available in Settings.`, 5, 'voice-lang');
        }
        break;
      }
      case 'set_coach_mode': {
        const mode = String(params.mode ?? 'off') as CoachMode;
        const valid: CoachMode[] = ['navigation', 'reading', 'exploration', 'shopping', 'off'];
        if (!valid.includes(mode)) {
          speak('I did not understand that coaching mode.', 5, 'voice-coach-invalid');
          break;
        }
        setCoachMode(mode);
        if (mode === 'off') {
          speak('Navigation coaching off. Say navigation mode to restart.', 5, 'voice-coach');
        } else {
          if (!cameraActive) {
            tab('tracking');
            speak(`${mode === 'navigation' ? 'Navigation' : mode === 'reading' ? 'Reading' : mode === 'exploration' ? 'Exploration' : 'Shopping'} mode on. Turn on the camera to start coaching.`, 5, 'voice-coach');
          } else {
            speak(`${mode === 'navigation' ? 'Navigation' : mode === 'reading' ? 'Reading' : mode === 'exploration' ? 'Exploration' : 'Shopping'} mode on. Coaching is active.`, 5, 'voice-coach');
          }
        }
        break;
      }
      case 'shopping':
        setCoachMode('shopping');
        tab('tracking');
        speak('Shopping mode. Point the camera at a product or label, then say read this label, or what is this.', 5, 'voice-shop');
        break;
      case 'help':
        speak(HELP_MESSAGE, 5, 'voice-help');
        break;
      case 'list_places':
        tab('routes');
        speak('Opening saved places.', 5, 'voice-places');
        break;
      case 'save_place':
        tab('routes');
        speak(params.label ? `Saving this location as ${params.label}. Use the places screen to confirm.` : 'Open the places screen to save this location.', 5, 'voice-save-place');
        break;
      case 'report_hazard':
        tab('community');
        speak('Opening community reports. You can report a hazard there.', 5, 'voice-hazard');
        break;
      case 'unknown':
      default:
        speak(HELP_MESSAGE, 5, 'voice-unknown');
        break;
    }
  }

  // Register the bridge so the voice provider can reach this handler + speech.
  useEffect(() => {
    voiceBridge.current.speak = (text, priority = 5, dedupeKey) => speak(text, priority as SpeechPriority, dedupeKey);
    voiceBridge.current.handleCommand = (intent) => handleVoiceCommand(intent);
    voiceBridge.current.stopSpeaking = () => stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceBridge]);

  // Global "any touch stops the talking" barge-in. While Watchora is speaking
  // the microphone is paused (so it cannot hear its own voice and loop), which
  // means a blind user cannot interrupt a long reading with their voice. A tap
  // or keypress anywhere is a reflex interrupt: it stops the speech, and the
  // voice provider resumes listening ~450ms later so the next command works.
  useEffect(() => {
    const interrupt = () => {
      if (speechActiveCountRef.current > 0) {
        stopSpeaking();
        if ('vibrate' in navigator) navigator.vibrate(15);
      }
    };
    window.addEventListener('pointerdown', interrupt);
    window.addEventListener('keydown', interrupt);
    return () => {
      window.removeEventListener('pointerdown', interrupt);
      window.removeEventListener('keydown', interrupt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getRecognitionCtor() {
    const win = window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    return (win.SpeechRecognition || win.webkitSpeechRecognition) as (new () => RecognitionLike) | undefined;
  }

  function ensureRecognition() {
    if (recognitionRef.current) return recognitionRef.current;
    const RecognitionCtor = getRecognitionCtor();
    if (!RecognitionCtor) return null;

    const recognition = new RecognitionCtor();
    recognition.lang = language === 'English' ? 'en-US' : language === 'Vietnamese' ? 'vi-VN' : 'es-ES';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      speechLockRef.current = true;
      announce('Listening for a command...', 'busy');
    };
    recognition.onresult = (event: any) => {
      let transcript = '';
      for (const result of event.results) transcript += result[0].transcript;
      setPrompt(transcript.trim());
    };
    recognition.onerror = (event: any) => {
      speechLockRef.current = false;
      announce(`Speech recognition error: ${event.error}.`, 'error');
    };
    recognition.onend = () => {
      speechLockRef.current = false;
      announce('Stopped listening.', 'online');
    };

    recognitionRef.current = recognition;
    return recognition;
  }

  function handleStartListening() {
    const recognition = ensureRecognition();
    if (!recognition) {
      announce('This browser does not support speech recognition.', 'error');
      return;
    }
    if (speechLockRef.current) {
      recognition.stop();
      return;
    }
    recognition.start();
  }

  function handleStopListening() {
    recognitionRef.current?.stop();
    speechLockRef.current = false;
    announce('Stopped listening.', 'online');
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      announce('This browser does not support camera access.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);
      announce('Live camera connected.', 'online');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown camera error';
      announce(`Could not start camera: ${message}`, 'error');
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
    }
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    announce('Camera stopped.', 'online');
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return '';
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return '';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return compressImage(canvas);
  }

  async function analyzeFrame(mode: AnalysisMode, nextPrompt: string) {
    if (isAnalyzing) return;

    const imageDataUrl = captureFrame();
    if (!imageDataUrl) {
      announce('Start the camera and capture a frame first.', 'warning');
      return;
    }

    // Phase B: reading mode tries local OCR first (fast, offline, private) before
    // falling back to the cloud Gemini path. Other modes are unchanged — natural
    // scene description/navigation genuinely needs the vision model, OCR does not
    // help there. See docs/yolo-ocr-slam-plan.md #2.2 for why this is a hybrid,
    // not an on-device-only replacement.
    if (mode === 'reading') {
      setIsAnalyzing(true);
      announce('Reading the current frame locally.', 'busy');
      try {
        const ocr = await recognizeText(imageDataUrl);
        if (ocr.text && ocr.confidence >= OCR_FALLBACK_CONFIDENCE_THRESHOLD) {
          const result: AiResult = {
            mode: 'reading',
            summary: ocr.text.split('\n').find((line) => line.trim().length > 0)?.trim() || ocr.text.slice(0, 120),
            details: ocr.text.split('\n').map((line) => line.trim()).filter(Boolean).slice(1),
            warnings: [],
            confidence: ocr.confidence >= 80 ? 'high' : 'medium',
            shouldStop: false,
            demo: false,
            source: 'local-ocr',
          };
          setAiResult(result);
          setResponse(result.summary);
          announce('Read locally, on this device.', 'online');
          speak(result.summary);
          setIsAnalyzing(false);
          return;
        }
        // Low-confidence or empty local OCR: fall through to the Gemini path below
        // rather than reading unreliable text aloud with false authority.
        announce('Local reading was unclear. Asking the cloud model for a better read.', 'busy');
      } catch {
        announce('Local reading failed. Asking the cloud model instead.', 'busy');
      }
      // isAnalyzing stays true; falls through into the existing Gemini flow below.
    } else {
      setIsAnalyzing(true);
      announce('Analyzing the current frame.', 'busy');
    }

    const controller = new AbortController();
    analysisAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);

    try {
      const httpResponse = await fetch(`${apiBaseUrl}/api/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          prompt: nextPrompt.trim() || 'Analyze the current frame.',
          imageDataUrl,
        }),
        signal: controller.signal,
      });

      if (!httpResponse.ok) {
        const errorBody = await httpResponse.json().catch(() => ({ error: 'Analysis failed.' }));
        throw new Error(typeof errorBody.error === 'string' ? errorBody.error : 'Analysis failed.');
      }

      const data = (await httpResponse.json()) as Partial<AiResult>;
      if (!data.summary) throw new Error('The server returned an unexpected response.');

      const result: AiResult = {
        mode,
        summary: data.summary,
        details: data.details ?? [],
        warnings: data.warnings ?? [],
        confidence: data.confidence ?? 'low',
        shouldStop: Boolean(data.shouldStop),
        demo: Boolean(data.demo),
        source: 'gemini',
      };

      setAiResult(result);
      setResponse(result.summary);
      announce(result.demo ? 'Demo response received (no API key configured).' : 'Analysis complete.', result.demo ? 'warning' : 'online');

      // Apply the same "binary before nuance" + confidence-aware discipline used by
      // the local hazard layer (docs/yolo-ocr-slam-plan.md #2.4): a low-confidence
      // cloud answer must not be spoken in the same tone as a confident one, and a
      // shouldStop result gets the same immediate-hazard haptic as the local layer
      // rather than only a spoken sentence that could be missed.
      if (result.shouldStop) {
        fireHapticEvent('hazard-immediate', hapticSettings);
        speak(`Caution. ${result.summary}`, 2, 'hazard-immediate');
      } else if (result.confidence === 'low') {
        speak(`I'm not fully sure, but: ${result.summary}`);
      } else {
        speak(result.summary);
      }

      // Record a journey for navigation sessions (best-effort, never blocks the UI).
      if (mode === 'navigation') {
        api
          .createJourney({ destination: nextPrompt.trim().slice(0, 200) || 'Current location', mode: 'NAVIGATION' })
          .catch(() => {});
      }
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      const message = isTimeout
        ? 'The analysis request timed out. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Could not reach the backend.';

      setAiResult(null);
      setResponse(message);
      announce(message, 'error');
      speak(message);
    } finally {
      clearTimeout(timeout);
      analysisAbortRef.current = null;
      setIsAnalyzing(false);
    }
  }

  function cancelAnalysis() {
    analysisAbortRef.current?.abort();
  }

  // Blind-user-perspective audit (2026-08-07): "describe what is ahead" and
  // "read this" previously only switched tabs/mode and then told the user to
  // "press capture" — defeating the entire point of a hands-free voice
  // command for someone who may be walking with a cane in one hand. This
  // starts the camera if needed (waiting for the video element to actually
  // have a frame ready, not just for getUserMedia to resolve) and then
  // triggers the same analysis a manual "Capture & analyze" tap would.
  async function voiceCaptureAndAnalyze(mode: AnalysisMode, promptText: string) {
    if (!cameraActive) {
      speak('Starting the camera.', 4, 'voice-camera-starting');
      await startCamera();
      // Wait for the video element to actually have pixels — getUserMedia
      // resolving does not guarantee a frame is paintable yet.
      const video = videoRef.current;
      if (video) {
        await new Promise<void>((resolve) => {
          if (video.videoWidth > 0) {
            resolve();
            return;
          }
          const onReady = () => {
            video.removeEventListener('loadeddata', onReady);
            resolve();
          };
          video.addEventListener('loadeddata', onReady);
          // Don't hang forever if the camera never produces a frame.
          setTimeout(() => {
            video.removeEventListener('loadeddata', onReady);
            resolve();
          }, 4000);
        });
      }
    }
    await analyzeFrame(mode, promptText);
  }

  function repeatInstruction() {
    if (aiResult) speak(aiResult.summary);
  }

  async function saveReadingHistory() {
    if (!aiResult || aiResult.mode !== 'reading') return;
    const text = [aiResult.summary, ...aiResult.details].join('\n').trim();
    if (!text) return;
    try {
      const { entry } = await api.createReadingEntry({
        source: 'camera',
        extractedText: text.slice(0, 20_000),
        language,
      });
      setReadingEntries((prev) => [entry, ...(prev ?? [])]);
      announce('Saved to reading history.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not save reading history.', 'error');
    }
  }

  useEffect(() => {
    return () => {
      stopCamera();
      recognitionRef.current?.stop();
      stopSpeaking();
      analysisAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const label = tabs.find((tab) => tab.key === activeTab)?.label ?? 'Assist';
    document.title = `watchora — ${label}`;
    // Blind-user-perspective audit (2026-08-07): without an explicit spoken cue,
    // a screen-reader user who taps a tab button gets zero feedback that the
    // screen changed — the title updates visually but is not automatically spoken.
    // Speak the tab name on every change (except initial mount where the app
    // shell itself already speaks a welcome).
  }, [activeTab]);

  // Announce tab changes through the live region so screen readers speak them.
  const tabAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!tabAnnouncedRef.current) {
      tabAnnouncedRef.current = true;
      return;
    }
    const label = tabs.find((tab) => tab.key === activeTab)?.label ?? 'Assist';
    announce(`${label} tab`, 'online');
    speak(label, 5, `tab-${activeTab}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'routes' && places === null) {
      api
        .listPlaces()
        .then((res) => setPlaces(res.places))
        .catch(() => announce('Could not load saved places.', 'error'));
    }
    if (activeTab === 'sos') {
      if (contacts === null) {
        api
          .listContacts()
          .then((res) => setContacts(res.contacts))
          .catch(() => announce('Could not load emergency contacts.', 'error'));
      }
      if (assistanceRequests === null) {
        api
          .listAssistanceRequests()
          .then((res) => setAssistanceRequests(res.requests))
          .catch(() => announce('Could not load SOS history.', 'error'));
      }
    }
    if (activeTab === 'community' && incidents === null) {
      api
        .listIncidents()
        .then((res) => setIncidents(res.incidents))
        .catch(() => announce('Could not load community reports.', 'error'));
    }
    if (activeTab === 'settings') {
      if (readingEntries === null) {
        api
          .listReadingEntries()
          .then((res) => setReadingEntries(res.entries))
          .catch(() => announce('Could not load reading history.', 'error'));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // First-run onboarding (roadmap Phase 1): show once per user until completed,
  // persisted locally. Voice-first permission + feedback calibration.
  useEffect(() => {
    if (!localStorage.getItem(onboardingKey)) {
      // Small delay so the dashboard paints first, then the voice-first welcome speaks.
      const timer = setTimeout(() => setShowOnboarding(true), 600);
      return () => clearTimeout(timer);
    }
  }, [onboardingKey]);

  // Load saved accessibility preferences + the neural voice catalog once.
  useEffect(() => {
    api
      .getPreferences()
      .then((res) => {
        prefsLoadedRef.current = true;
        setVoiceRate(res.preferences.speechRate);
        if (res.preferences.voiceName) setVoice(res.preferences.voiceName);
      })
      .catch(() => announce('Could not load your saved settings.', 'warning'));
    api
      .ttsVoices()
      .then((res) => {
        setVoices(res.voices);
        if (res.voices.length) setLanguage(res.voices[0]!.language);
      })
      .catch(() => setVoices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the displayed language label in sync with the chosen voice.
  useEffect(() => {
    if (!voices) return;
    const v = voices.find((item) => item.shortName === voice);
    if (v) setLanguage(v.language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, voices]);

  // Persist preference changes (skip the first mount render before prefs load).
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    const timer = setTimeout(() => {
      api
        .updatePreferences({ speechRate: voiceRate, voiceName: voice })
        .catch(() => announce('Could not save your voice settings.', 'warning'));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceRate, voice]);

  const selectedThemeClass = themeMode === 'Dark' ? 'theme-dark' : 'theme-light';
  const activeLabel = tabs.find((tab) => tab.key === activeTab)?.label || 'Assist';
  const visibleTabs =
    user.role === 'ADMIN'
      ? tabs
      : tabs.filter((tab) => tab.key !== 'admin' && (user.role === 'CAREGIVER' || tab.key !== 'caregiver'));

  const renderTracking = () => (
    <div className="screen-grid tracking-grid">
      <section className="hero-panel panel">
        <div className="hero-copy">
          <div className="eyebrow-row">
            <span className="eyebrow">watchora assist</span>
          </div>
          <h2>Camera-to-voice assistance</h2>
          <p className="hero-subtitle">Point the camera, pick a mode, and get a spoken description powered by Gemini.</p>
        </div>
        <div className="live-panel">
          <div className="live-panel-head">
            <span className="live-badge">LIVE</span>
            <span className="live-copy">Your camera</span>
          </div>
          <div className="video-frame large">
            <video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" />
            <div className="video-overlay tracking-overlay">
              <div className="overlay-pill">{cameraActive ? 'Camera connected' : 'Camera will appear here'}</div>
            </div>
            {hazardLayerEnabled && cameraActive
              ? hazardState.detections.map((detection, index) => (
                  <div
                    key={index}
                    className={`hazard-box ${detection.className}`}
                    style={{
                      left: `${detection.box.x * 100}%`,
                      top: `${detection.box.y * 100}%`,
                      width: `${detection.box.width * 100}%`,
                      height: `${detection.box.height * 100}%`,
                    }}
                  >
                    <span className="hazard-box-label">{detection.className}</span>
                  </div>
                ))
              : null}
          </div>
          <canvas ref={canvasRef} className="hidden-canvas" />

          <div
            className={`hazard-status-bar hazard-status-${hazardState.status}`}
            role="status"
            aria-live={hazardState.topHazard ? 'assertive' : 'off'}
          >
            <span className="hazard-status-dot" aria-hidden="true" />
            <span>
              {!hazardLayerEnabled
                ? 'Local hazard detection is off.'
                : hazardState.status === 'idle'
                  ? 'Local hazard detection ready — connect the camera to start.'
                  : hazardState.status === 'warming-up'
                    ? 'Loading local detection model…'
                    : hazardState.status === 'error'
                      ? `Local hazard detection unavailable: ${hazardState.errorMessage ?? 'unknown error'}`
                      : hazardState.topHazard
                        ? `${hazardState.topHazard.className} near ${hazardState.topHazard.bearingClock} o'clock`
                        : 'Path looks clear.'}
            </span>
            {hazardLayerEnabled && hazardState.status === 'running' ? (
              <span className="hazard-status-fps">{hazardState.fps} fps</span>
            ) : null}
            <button
              className="ghost-btn hazard-toggle"
              onClick={() => setHazardLayerEnabled((v) => !v)}
              aria-pressed={hazardLayerEnabled}
            >
              {hazardLayerEnabled ? 'Turn off local detection' : 'Turn on local detection'}
            </button>
          </div>

          <div className="tracking-actions">
            <button className="primary-btn" onClick={startCamera} disabled={cameraActive}>
              📡 Connect camera
            </button>
            <button className="secondary-btn" onClick={stopCamera} disabled={!cameraActive}>
              Stop camera
            </button>
          </div>


          <div className="analysis-mode-row" role="radiogroup" aria-label="Analysis mode">
            {analysisModes.map((mode) => (
              <button
                key={mode.key}
                className={`ghost-btn ${analysisMode === mode.key ? 'active' : ''}`}
                role="radio"
                aria-checked={analysisMode === mode.key}
                onClick={() => setAnalysisMode(mode.key)}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <div className="coach-mode-row" role="radiogroup" aria-label="Vision coaching mode">
            {(
              [
                { key: 'off', label: 'Coaching off' },
                { key: 'navigation', label: '🧭 Navigation' },
                { key: 'reading', label: '📖 Reading' },
                { key: 'exploration', label: '🌍 Explore' },
                { key: 'shopping', label: '🛒 Shopping' },
              ] as Array<{ key: CoachMode; label: string }>
            ).map((m) => (
              <button
                key={m.key}
                className={`ghost-btn ${coachMode === m.key ? 'active' : ''}`}
                role="radio"
                aria-checked={coachMode === m.key}
                onClick={() => {
                  setCoachMode(m.key);
                  if (m.key !== 'off') {
                    speak(`${m.label.replace(/[🧭📖🌍🛒 ]/g, '')} mode on. Coaching is active.`, 5, 'voice-coach-ui');
                  } else {
                    speak('Navigation coaching off.', 5, 'voice-coach-ui');
                  }
                }}
              >
                <span aria-hidden="true">{m.label.match(/^[^\w\s]/) ? m.label[0] : ''}</span>{m.label.replace(/^[^\w\s]\s*/, '')}
              </button>
            ))}
          </div>
          {coachMode !== 'off' ? (
            <p className="coach-status" role="status" aria-live="polite">
              <span aria-hidden="true">🎙️</span> {coachMode === 'navigation' ? 'Navigation' : coachMode === 'reading' ? 'Reading' : coachMode === 'exploration' ? 'Exploration' : 'Shopping'} coaching
              {cameraActive && hazardLayerEnabled ? ' active — hazards announced with direction and clock position.' : ' — connect the camera to start.'}
            </p>
          ) : null}

          <div className="tracking-actions">
            <button
              className="primary-btn"
              onClick={() => analyzeFrame(analysisMode, prompt)}
              disabled={!cameraActive || isAnalyzing}
              aria-busy={isAnalyzing}
            >
              {isAnalyzing ? '⏳ Analyzing…' : '📸 Capture & analyze'}
            </button>
            {isAnalyzing ? (
              <button className="secondary-btn" onClick={cancelAnalysis}>
                <span aria-hidden="true">✋</span> Cancel
              </button>
            ) : (
              <>
                <button className="secondary-btn" onClick={repeatInstruction} disabled={!aiResult}>
                  <span aria-hidden="true">🔁</span> Repeat instruction
                </button>
                <button className="secondary-btn" onClick={stopSpeaking}>
                  <span aria-hidden="true">🔇</span> Stop speaking
                </button>
              </>
            )}
          </div>

          <div className="ai-result-panel panel" role="status" aria-live="polite">
            <p className="ai-result-summary">{response}</p>
            {aiResult ? (
              <>
                {aiResult.details.length > 0 ? (
                  <ul className="ai-result-details">
                    {aiResult.details.map((detail, index) => (
                      <li key={index}>{detail}</li>
                    ))}
                  </ul>
                ) : null}
                {aiResult.warnings.length > 0 ? (
                  <div className="ai-result-warnings" role="alert">
                    {aiResult.warnings.map((warning, index) => (
                      <p key={index}><span aria-hidden="true">⚠️</span> {warning}</p>
                    ))}
                  </div>
                ) : null}
                <div className="ai-result-meta">
                  <span
                    className={`pill pill-${aiResult.confidence === 'high' ? 'success' : aiResult.confidence === 'medium' ? 'neutral' : 'warning'}`}
                  >
                    Confidence: {aiResult.confidence}
                  </span>
                  {aiResult.demo ? (
                    <span className="pill pill-neutral">Demo mode</span>
                  ) : aiResult.source === 'local-ocr' ? (
                    <span className="pill pill-success">Read locally, on this device</span>
                  ) : (
                    <span className="pill pill-success">Gemini live</span>
                  )}
                  {aiResult.shouldStop ? <span className="pill pill-danger">Stop recommended</span> : null}
                </div>
                {aiResult.mode === 'reading' && (
                  <button className="ghost-btn" onClick={saveReadingHistory} aria-label="Save this reading to history">
                    <span aria-hidden="true">💾</span> Save to reading history
                  </button>
                )}
              </>
            ) : null}
          </div>

          <div className="quick-links">
            <button className="ghost-btn" onClick={() => setActiveTab('routes')}>
              <span aria-hidden="true">🗺️</span> Saved places
            </button>
            <button className="ghost-btn" onClick={() => setActiveTab('community')}>
              <span aria-hidden="true">🛡️</span> Community reports
            </button>
          </div>
        </div>
      </section>
    </div>
  );

  return (
    <>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          // Blind-user-perspective audit (2026-08-07): a bare hash-link skip
          // link scrolls but does not reliably move actual keyboard/screen-
          // reader focus in every browser (notably Safari/VoiceOver on
          // macOS/iOS) — verified via a real headless run that
          // document.activeElement stayed on <body> after activating this
          // link. Without focus actually moving, the very next Tab press
          // resumes from wherever it was, defeating the point of a skip
          // link. Force it explicitly rather than relying on default hash
          // navigation.
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to main content
      </a>
      {/* Blind-user-perspective audit (2026-08-07): announce() (used ~85
          times throughout this component for camera errors, journey status,
          SOS confirmations, saved-place/contact confirmations, etc.) only
          ever updated the visible .status-chip text — a plain div with no
          aria-live. Screen readers never announced any of it unless that
          exact element already had focus. Worse, .status-chip lives inside
          .sidebar, which is display:none on the mobile breakpoint (the
          layout the app's own PWA design targets), so on a phone those
          messages were completely invisible AND unannounced: a silent
          failure for exactly the population this app serves. This is a
          dedicated, always-present, visually-hidden live region so every
          announce() call is actually spoken by TalkBack/VoiceOver/NVDA
          regardless of viewport or which visual chip is or isn't rendered. */}
      <div
        className="sr-only"
        aria-live={statusTone === 'error' ? 'assertive' : 'polite'}
        role={statusTone === 'error' ? 'alert' : 'status'}
      >
        {statusMessage}
      </div>
      <div className={`app-shell ${selectedThemeClass}`}>
        <aside className="sidebar panel" aria-label="Primary navigation">
          <div className="brand-block">
            <div className="brand-mark" aria-hidden="true">W</div>
            <div>
              {/* This is app-chrome branding, not page content — using a
                  heading here creates two <h1>s on the Assist tab (the
                  other is the actual page heading "Camera-to-voice
                  assistance"), which breaks the heading outline a screen
                  reader's "jump by heading" navigation relies on. */}
              <p className="brand-name">watchora</p>
              <p>{user.fullName}</p>
            </div>
          </div>
          {/* nav keeps its navigation landmark role; the tablist semantics
              live on an inner div so the region is still a landmark. */}
          <nav className="sidebar-nav" aria-label="Dashboard sections">
            <div role="tablist">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.key}
                  role="tab"
                  id={`tab-${tab.key}`}
                  aria-controls={`panel-${tab.key}`}
                  aria-selected={activeTab === tab.key}
                  className={`nav-item ${activeTab === tab.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <span className="nav-icon" aria-hidden="true">{tab.icon}</span>
                  <span>
                    <strong>{tab.label}</strong>
                    <small>{tab.note}</small>
                  </span>
                </button>
              ))}
            </div>
          </nav>
          <div className="sidebar-footer">
            <div className={`status-chip ${statusTone}`}>{statusMessage}</div>
            <button className="ghost-btn" onClick={onLogout}>
              Log out
            </button>
          </div>
        </aside>

        <div className="content-shell">
          <header className="topbar panel">
            <div>
              <p className="topbar-kicker">watchora</p>
              {/* Single h1 per screen. Blind users navigate by heading
                  (VoiceOver rotor / TalkBack "navigate by heading"); every
                  screen must have exactly one level-1 heading so the outline
                  is predictable and the current screen is always announced.
                  Tab bodies use h2/h3 below this. */}
              <h1>{activeLabel}</h1>
            </div>
            <div className="topbar-actions">
              <button className="primary-btn sos-inline" onClick={() => setActiveTab('sos')}>
                <span aria-hidden="true">🚨</span> SOS
              </button>
            </div>
          </header>

          <main id="main-content" className="main-content" tabIndex={-1}>
            {activeTab === 'home' && (
              <section role="tabpanel" id="panel-home" aria-labelledby="tab-home" className="tab-panel">
                <VoiceFirstDashboard
                  permissionService={permissionService}
                  emergency={{ state: 'idle' }}
                  activeJourney={null}
                  offline={!navigator.onLine}
                  onOpenTab={(t) => setActiveTab(t as TabKey)}
                  onOpenPermissions={() => setShowPermissions(true)}
                  onEmergency={() => {
                    setActiveTab('sos');
                    announce('Emergency requested. Use the emergency screen to share your location.', 'error');
                    speak('Emergency requested. Use the emergency screen to share your location.', 1, 'dash-emergency');
                  }}
                  onCancelEmergency={() => {}}
                  onResolveEmergency={() => {}}
                  speak={speak as (text: string, priority?: number, dedupeKey?: string) => void}
                />
              </section>
            )}
            {activeTab === 'tracking' && (
              <section role="tabpanel" id="panel-tracking" aria-labelledby="tab-tracking" className="tab-panel">
                {renderTracking()}
              </section>
            )}
            {activeTab === 'routes' && (
              <section role="tabpanel" id="panel-routes" aria-labelledby="tab-routes" className="tab-panel">
                <PlacesTab places={places} onCreated={(place) => setPlaces((prev) => [place, ...(prev ?? [])])} onDeleted={(id) => setPlaces((prev) => (prev ?? []).filter((p) => p.id !== id))} announce={announce} />
              </section>
            )}
            {activeTab === 'journey' && (
              <section role="tabpanel" id="panel-journey" aria-labelledby="tab-journey" className="tab-panel">
                <SafeJourneyTab contacts={contacts} onNeedContacts={() => setActiveTab('sos')} announce={announce} speak={speak} permissionService={permissionService} />
              </section>
            )}
            {activeTab === 'sos' && (
              <section role="tabpanel" id="panel-sos" aria-labelledby="tab-sos" className="tab-panel">
                <SosTab
                  contacts={contacts}
                  assistanceRequests={assistanceRequests}
                  onContactCreated={(contact) => setContacts((prev) => [...(prev ?? []), contact])}
                  onContactDeleted={(id) => setContacts((prev) => (prev ?? []).filter((c) => c.id !== id))}
                  onRequestCreated={(req) => setAssistanceRequests((prev) => [req, ...(prev ?? [])])}
                  onRequestResolved={(req) => setAssistanceRequests((prev) => (prev ?? []).map((r) => (r.id === req.id ? req : r)))}
                  announce={announce}
                  speak={speak}
                />
              </section>
            )}
            {activeTab === 'community' && (
              <section role="tabpanel" id="panel-community" aria-labelledby="tab-community" className="tab-panel">
                <CommunityTab incidents={incidents} onCreated={(incident) => setIncidents((prev) => [incident, ...(prev ?? [])])} announce={announce} />
              </section>
            )}
            {activeTab === 'caregiver' && user.role !== 'BLIND_USER' && (
              <section role="tabpanel" id="panel-caregiver" aria-labelledby="tab-caregiver" className="tab-panel">
                <CaregiverTab announce={announce} />
              </section>
            )}
            {activeTab === 'settings' && (
              <section role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" className="tab-panel">
                <SettingsTab
                  user={user}
                  language={language}
                  themeMode={themeMode}
                  onThemeChange={setThemeMode}
                  voiceRate={voiceRate}
                  onVoiceRateChange={(updater) => {
                    setVoiceRate((prev) => {
                      const next = typeof updater === 'function' ? updater(prev) : updater;
                      speak(getVoiceTestPhrase(voice), 4, 'test-voice-btn', next);
                      return next;
                    });
                  }}
                  voice={voice}
                  voices={voices}
                  onVoiceChange={(v) => {
                    setVoice(v);
                    speak(getVoiceTestPhrase(v), 4, 'voice-change-test', voiceRate);
                  }}
                  onTestVoice={() => speak(getVoiceTestPhrase(voice), 4, 'test-voice-btn', voiceRate)}
                  hapticSettings={hapticSettings}
                  onHapticSettingsChange={setHapticSettings}
                  onTestHaptic={() => fireHapticEvent('hazard-nearby', hapticSettings)}
                  voiceSettings={voiceAssistant.settings}
                  onVoiceSettingsChange={(patch) => {
                    voiceAssistant.setSettings(patch);
                    if ('pushToTalk' in patch) {
                      if (patch.pushToTalk) {
                        speak('Hands-free voice control off. Press the talk button to use your voice.', 5, 'settings-handsfree');
                      } else {
                        speak('Hands-free voice control on. Say Hey Watchora, then your command.', 5, 'settings-handsfree');
                      }
                    }
                    if ('wakePhraseEnabled' in patch) {
                      speak(
                        patch.wakePhraseEnabled
                          ? 'Wake phrase on. Say Hey Watchora before each command.'
                          : 'Wake phrase off. Watchora will respond to every command directly.',
                        5,
                        'settings-wake',
                      );
                    }
                  }}
                  onLogout={onLogout}
                  readingEntries={readingEntries}
                  onDeleteReading={async (id) => {
                    try {
                      await api.deleteReadingEntry(id);
                      setReadingEntries((prev) => (prev ?? []).filter((r) => r.id !== id));
                      announce('Reading entry deleted.', 'online');
                    } catch (error) {
                      announce(error instanceof ApiError ? error.message : 'Could not delete reading entry.', 'error');
                    }
                  }}
                />
              </section>
            )}
            {activeTab === 'admin' && user.role === 'ADMIN' && (
              <section role="tabpanel" id="panel-admin" aria-labelledby="tab-admin" className="tab-panel">
                <AdminTab announce={announce} />
              </section>
            )}
          </main>
        </div>

        <nav className="bottom-nav panel" aria-label="Mobile navigation">
          <div role="tablist" className="bottom-nav-tablist">
            {visibleTabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                id={`tab-mobile-${tab.key}`}
                aria-controls={`panel-${tab.key}`}
                aria-selected={activeTab === tab.key}
                className={`bottom-nav-item ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span aria-hidden="true">{tab.icon}</span>
                <strong>{tab.label}</strong>
              </button>
            ))}
          </div>
        </nav>
      </div>
      {showOnboarding ? (
        <PermissionOnboarding
          service={permissionService}
          voice={voice}
          onVoiceChange={(v) => {
            setVoice(v);
          }}
          onVoiceRateChange={(r) => {
            setVoiceRate(r);
          }}
          testVoice={() => {
            const phrase = getVoiceTestPhrase(voice);
            speak(phrase, 4, 'test-voice-btn', voiceRate);
          }}
          speak={speak as (text: string, priority?: number, dedupeKey?: string, rate?: number) => void}
          onComplete={(result: OnboardingResult) => {
            localStorage.setItem(onboardingKey, '1');
            setVoiceRate(result.speechRate);
            const chosenVoice = result.selectedVoice || voice;
            if (result.selectedVoice) setVoice(result.selectedVoice);
            setHapticSettings({
              hapticsEnabled: result.hapticsEnabled,
              toneEnabled: result.toneEnabled,
              intensity: result.intensity,
            });
            setShowOnboarding(false);
            const msg = getStepSpeech('summary', chosenVoice);
            announce(msg || 'Setup complete.', 'online');
            speak(msg || 'Setup complete.', 5, undefined, result.speechRate);
          }}
        />
      ) : null}

      {showPermissions ? (
        <div className="modal-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowPermissions(false)}>
          <PermissionCenter service={permissionService} onClose={() => setShowPermissions(false)} />
        </div>
      ) : null}
    </>
  );
}

function PlacesTab({
  places,
  onCreated,
  onDeleted,
  announce,
}: {
  places: SavedPlace[] | null;
  onCreated: (place: SavedPlace) => void;
  onDeleted: (id: string) => void;
  announce: (message: string, tone?: Tone) => void;
}) {
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<Coordinates | null>(null);
  const [locating, setLocating] = useState(false);
  const [newPlaceCoords, setNewPlaceCoords] = useState<Coordinates | null>(null);

  async function addPlace() {
    if (!label.trim()) {
      announce('Enter a name for this place.', 'warning');
      return;
    }
    setSaving(true);
    try {
      const { place } = await api.createPlace({
        label: label.trim(),
        address: address.trim() || undefined,
        notes: notes.trim() || undefined,
        latitude: newPlaceCoords?.latitude,
        longitude: newPlaceCoords?.longitude,
      });
      onCreated(place);
      setLabel('');
      setAddress('');
      setNotes('');
      setNewPlaceCoords(null);
      announce('Place saved.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not save this place.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function useCurrentLocationForNewPlace() {
    setLocating(true);
    try {
      const coords = await getCurrentPosition();
      setNewPlaceCoords(coords);
      announce('Current location captured for this place.', 'online');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not get your location.', 'error');
    } finally {
      setLocating(false);
    }
  }

  async function locateMe() {
    setLocating(true);
    try {
      const coords = await getCurrentPosition();
      setCurrentPosition(coords);
      announce('Location updated. Distances below are relative to where you are now.', 'online');
    } catch (error) {
      announce(error instanceof Error ? error.message : 'Could not get your location.', 'error');
    } finally {
      setLocating(false);
    }
  }

  async function removePlace(id: string) {
    try {
      await api.deletePlace(id);
      onDeleted(id);
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not delete this place.', 'error');
    }
  }

  return (
    <div className="screen-grid routes-grid">
      <section className="panel list-panel">
        <div className="section-head">
          <h2>Saved places</h2>
          <button className="ghost-btn" onClick={locateMe} disabled={locating}>
            {locating ? 'Locating…' : currentPosition ? <><span aria-hidden="true">📍</span> Update my location</> : <><span aria-hidden="true">📍</span> Use my location</>}
          </button>
        </div>
        {places === null ? (
          <p className="soft-note" role="status" aria-live="polite">Loading…</p>
        ) : places.length === 0 ? (
          <p className="soft-note" role="status" aria-live="polite">No saved places yet. Add one below.</p>
        ) : (
          <div className="route-list">
            {places.map((place) => {
              const hasCoords = place.latitude != null && place.longitude != null;
              const relative =
                currentPosition && hasCoords
                  ? describeRelativePosition(currentPosition, { latitude: place.latitude!, longitude: place.longitude! })
                  : null;
              return (
                <div key={place.id} className="route-card">
                  <div>
                    <strong>{place.label}</strong>
                    <div className="route-meta">{place.address || place.notes || 'No details added'}</div>
                    {relative ? <div className="route-distance">{relative}</div> : null}
                    {!hasCoords ? <div className="route-meta route-meta-muted">No location saved for this place.</div> : null}
                  </div>
                  <button className="ghost-btn" onClick={() => removePlace(place.id)}>
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <section className="panel detail-panel">
        <div className="section-head">
          <h2>Add a place</h2>
        </div>
        <div className="form-stack">
          <label>
            <span>Name</span>
            <input aria-label="Name" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Pharmacy" />
          </label>
          <label>
            <span>Address (optional)</span>
            <input aria-label="Address (optional)" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Street address" />
          </label>
          <label>
            <span>Notes (optional)</span>
            <textarea aria-label="Notes (optional)" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Anything worth remembering" />
          </label>
          <button className="secondary-btn" onClick={useCurrentLocationForNewPlace} disabled={locating}>
            {newPlaceCoords ? <><span aria-hidden="true">📍</span> Location captured</> : locating ? 'Locating…' : <><span aria-hidden="true">📍</span> Save my current location with this place</>}
          </button>
          <button className="primary-btn" onClick={addPlace} disabled={saving}>
            {saving ? 'Saving…' : '＋ Save place'}
          </button>
        </div>
      </section>
    </div>
  );
}

function SosTab({
  contacts,
  assistanceRequests,
  onContactCreated,
  onContactDeleted,
  onRequestCreated,
  onRequestResolved,
  announce,
  speak,
}: {
  contacts: TrustedContact[] | null;
  assistanceRequests: AssistanceRequest[] | null;
  onContactCreated: (contact: TrustedContact) => void;
  onContactDeleted: (id: string) => void;
  onRequestCreated: (request: AssistanceRequest) => void;
  onRequestResolved: (request: AssistanceRequest) => void;
  announce: (message: string, tone?: Tone) => void;
  speak: (text: string, priority?: SpeechPriority, dedupeKey?: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [sosMessage, setSosMessage] = useState('I need help. Please check on me.');
  const [sending, setSending] = useState(false);
  const [shareLocOnAdd, setShareLocOnAdd] = useState(false);

  async function addContact() {
    if (!name.trim()) {
      announce('Enter a contact name.', 'warning');
      return;
    }
    try {
      const { contact } = await api.createContact({
        name: name.trim(),
        phone: phone.trim() || undefined,
        relationship: relationship.trim() || undefined,
        canSeeLocation: shareLocOnAdd,
      });
      onContactCreated(contact);
      setName('');
      setPhone('');
      setRelationship('');
      setShareLocOnAdd(false);
      announce('Contact added.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not add this contact.', 'error');
    }
  }

  async function removeContact(id: string) {
    try {
      await api.deleteContact(id);
      onContactDeleted(id);
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not remove this contact.', 'error');
    }
  }

  async function toggleLocationConsent(contact: TrustedContact) {
    try {
      const { contact: updated } = await api.updateContact(contact.id, { canSeeLocation: !contact.canSeeLocation });
      onContactCreated(updated); // same shape; replace in list
      announce(
        updated.canSeeLocation
          ? `${contact.name} can now see your live location during safe journeys.`
          : `Live location sharing with ${contact.name} is off.`,
        'online',
      );
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not update location sharing.', 'error');
    }
  }

  async function triggerSOS() {
    const proceed = window.confirm('Send an SOS request? This records an emergency request for your trusted contacts to see.');
    if (!proceed) return;

    setSending(true);
    try {
      const { request } = await api.createAssistanceRequest({ message: sosMessage.trim() || 'I need help.', locationShare: true });
      onRequestCreated(request);
      // Record an explicit location-sharing consent grant for this SOS (privacy trail).
      api
        .grantConsent({ scope: 'LOCATION_SHARING', metadata: { source: 'sos', assistanceRequestId: request.id } })
        .catch(() => {});
      announce('SOS request recorded.', 'error');
      speak('S O S request sent.', 1, 'sos-sent');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not send the SOS request.', 'error');
    } finally {
      setSending(false);
    }
  }

  async function resolveRequest(id: string) {
    try {
      const { request } = await api.resolveAssistanceRequest(id);
      onRequestResolved(request);
      announce('Marked as resolved.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not update this request.', 'error');
    }
  }

  return (
    <div className="screen-grid sos-grid">
      <section className="panel sos-hero">
        <div className="section-head">
          <h2>SOS center</h2>
          <button className="sos-button" onClick={triggerSOS} disabled={sending}>
            {sending ? 'Sending…' : <><span aria-hidden="true">🚨</span> Send SOS</>}
          </button>
        </div>
        <div className="form-stack">
          <label>
            <span>Message sent with the SOS</span>
            <textarea aria-label="Message sent with the SOS" rows={2} value={sosMessage} onChange={(event) => setSosMessage(event.target.value)} />
          </label>
        </div>

        <div className="sos-contacts">
          <h3>Emergency contacts</h3>
          {contacts === null ? (
            <p className="soft-note" role="status" aria-live="polite">Loading…</p>
          ) : contacts.length === 0 ? (
            <p className="soft-note" role="status" aria-live="polite">No emergency contacts yet.</p>
          ) : (
            contacts.map((contact, index) => (
              <div className="contact-row" key={contact.id} style={{ flexWrap: 'wrap' }}>
                <span>
                  {index + 1}. {contact.name} {contact.relationship ? `(${contact.relationship})` : ''}
                </span>
                <span>{contact.phone || contact.email || '—'}</span>
                <button
                  className="ghost-btn"
                  aria-pressed={contact.canSeeLocation}
                  onClick={() => toggleLocationConsent(contact)}
                  title="Let this contact see your live location during safe journeys"
                >
                  {contact.canSeeLocation ? <><span aria-hidden="true">📍</span> Location on</> : <><span aria-hidden="true">📍</span> Location off</>}
                </button>
                <button className="ghost-btn" onClick={() => removeContact(contact.id)}>
                  Remove
                </button>
              </div>
            ))
          )}
          <div className="form-stack" style={{ marginTop: 12 }}>
            <label>
              <span>Contact name</span>
              <input aria-label="Contact name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" />
            </label>
            <label>
              <span>Relationship (optional)</span>
              <input aria-label="Relationship (optional)" value={relationship} onChange={(event) => setRelationship(event.target.value)} placeholder="e.g. Daughter" />
            </label>
            <label>
              <span>Phone (optional)</span>
              <input aria-label="Phone (optional)" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone number" />
            </label>
            <label className="settings-row">
              <span>Share live location with this contact</span>
              <button className="ghost-btn" aria-pressed={shareLocOnAdd} onClick={() => setShareLocOnAdd(!shareLocOnAdd)}>
                {shareLocOnAdd ? 'On' : 'Off'}
              </button>
            </label>
            <button className="secondary-btn" onClick={addContact}>
              ＋ Add contact
            </button>
          </div>
        </div>
      </section>

      <section className="panel sos-flow">
        <div className="section-head">
          <h2>SOS history</h2>
        </div>
        {assistanceRequests === null ? (
          <p className="soft-note" role="status" aria-live="polite">Loading…</p>
        ) : assistanceRequests.length === 0 ? (
          <p className="soft-note" role="status" aria-live="polite">No SOS requests yet.</p>
        ) : (
          <div className="sos-timeline">
            {assistanceRequests.map((req) => (
              <div className="timeline-item" key={req.id}>
                <div>
                  <strong>{new Date(req.createdAt).toLocaleString()}</strong> — {req.message}
                </div>
                <div>
                  <span className={`pill ${req.status === 'RESOLVED' ? 'pill-success' : 'pill-danger'}`}>{req.status}</span>
                  {req.status !== 'RESOLVED' ? (
                    <button className="ghost-btn" onClick={() => resolveRequest(req.id)}>
                      Mark resolved
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CommunityTab({
  incidents,
  onCreated,
  announce,
}: {
  incidents: IncidentReport[] | null;
  onCreated: (incident: IncidentReport) => void;
  announce: (message: string, tone?: Tone) => void;
}) {
  const [category, setCategory] = useState('Sidewalk');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<IncidentReport['severity']>('MEDIUM');
  const [saving, setSaving] = useState(false);

  async function addReport() {
    if (!description.trim()) {
      announce('Describe the hazard before submitting.', 'warning');
      return;
    }
    setSaving(true);
    try {
      const { incident } = await api.createIncident({ category: category.trim() || 'General', description: description.trim(), severity });
      onCreated(incident);
      setDescription('');
      announce('Report submitted.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not submit this report.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="screen-grid community-grid">
      <section className="panel community-feed">
        <div className="section-head">
          <h2>Community reports</h2>
        </div>
        {incidents === null ? (
          <p className="soft-note" role="status" aria-live="polite">Loading…</p>
        ) : incidents.length === 0 ? (
          <p className="soft-note" role="status" aria-live="polite">No reports yet. Be the first to add one.</p>
        ) : (
          <div className="feed-list">
            {incidents.map((incident) => (
              <div className={`feed-card tone-${incident.severity === 'LOW' ? 'success' : incident.severity === 'MEDIUM' ? 'warning' : 'danger'}`} key={incident.id}>
                <div className="feed-head">
                  <strong>{incident.category}</strong>
                  <span>{new Date(incident.createdAt).toLocaleDateString()}</span>
                </div>
                <p>{incident.description}</p>
                <div className="feed-footer">
                  <span>{incident.severity}</span>
                  <span>Reported by {incident.reporter.fullName}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel community-form">
        <div className="section-head">
          <h2>Add a report</h2>
        </div>
        <div className="form-stack">
          <label>
            <span>Report type</span>
            <select aria-label="Report type" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="Sidewalk">Sidewalk obstacle</option>
              <option value="Crosswalk">Crosswalk / intersection</option>
              <option value="Construction">Construction / roadwork</option>
              <option value="Lighting">Poor lighting</option>
              <option value="Signage">Missing or unclear signage</option>
              <option value="Transit">Public transit access</option>
              <option value="Other">Other</option>
            </select>
          </label>
          <label>
            <span>Severity</span>
            <select aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value as IncidentReport['severity'])}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </label>
          <label>
            <span>Details</span>
            <textarea aria-label="Details" rows={5} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the hazard or safety note here." />
          </label>
          <button className="primary-btn" onClick={addReport} disabled={saving}>
            {saving ? 'Sending…' : <><span aria-hidden="true">📤</span> Send report</>}
          </button>
        </div>
      </section>
    </div>
  );
}

function CaregiverTab({ announce }: { announce: (message: string, tone?: Tone) => void }) {
  const [overview, setOverview] = useState<CaregiverOverview | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [locData, setLocData] = useState<Record<string, CaregiverLiveLocation | null>>({});
  const [locLoading, setLocLoading] = useState(false);

  useEffect(() => {
    api
      .caregiverOverview()
      .then((res) => setOverview(res))
      .catch(() => announce('Could not load your caregiver overview.', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleLocation(userId: string) {
    if (expandedUserId === userId) {
      setExpandedUserId(null);
      return;
    }
    setExpandedUserId(userId);
    setLocLoading(true);
    try {
      const res = await api.caregiverUserLocation(userId);
      setLocData((prev) => ({ ...prev, [userId]: res }));
      if (res.journey) {
        announce(`Live location shared for this user's active journey.`);
      } else {
        announce(res.consent ? 'No active journey sharing location right now.' : 'This user has not granted live location access.');
      }
    } catch {
      setLocData((prev) => ({ ...prev, [userId]: null }));
      announce('Could not load live location for this user.', 'warning');
    } finally {
      setLocLoading(false);
    }
  }

  if (!overview) {
    return (
      <div className="screen-grid">
        <section className="panel">
          <p className="muted-note" role="status" aria-live="polite">Loading your caregiver overview…</p>
        </section>
      </div>
    );
  }

  return (
    <div className="screen-grid caregiver-grid">
      <section className="panel">
        <div className="section-head">
          <div>
            <p className="topbar-kicker">caregiver</p>
            <h2>People you support</h2>
          </div>
        </div>
        {overview.blindUsers.length === 0 ? (
          <p className="muted-note">
            No one has listed you as a trusted contact yet. When a blind user adds your email as a trusted contact, they appear here.
          </p>
        ) : (
          <ul className="settings-list">
            {overview.blindUsers.map((u) => {
              const loc = locData[u.id];
              const expanded = expandedUserId === u.id;
              return (
                <li key={u.id} className="settings-list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div className="min-w-0">
                      <p className="settings-list-title">{u.fullName}</p>
                      <p className="settings-list-sub">{u.email}</p>
                    </div>
                    <button className="ghost-btn" onClick={() => toggleLocation(u.id)} aria-expanded={expanded}>
                      {expanded ? 'Hide location' : <><span aria-hidden="true">📍</span> Live location</>}
                    </button>
                  </div>
                  {expanded && (
                    <div style={{ marginTop: 12 }}>
                      {locLoading ? (
                        <p className="muted-note" role="status" aria-live="polite">Loading live location…</p>
                      ) : loc && loc.journey ? (
                        <>
                          <MapView
                            userLat={loc.journey.lastLat}
                            userLng={loc.journey.lastLng}
                            trail={loc.trail}
                            height="260px"
                          />
                          <p className="muted-note" style={{ marginTop: 8 }}>
                            {u.fullName} → {loc.journey.destination} · Last update {loc.journey.lastLocationAt ? new Date(loc.journey.lastLocationAt).toLocaleTimeString() : 'unknown'}
                          </p>
                        </>
                      ) : (
                        <p className="muted-note">
                          {loc && !loc.consent
                            ? 'This user has not granted you live location access.'
                            : 'No active journey is sharing live location right now.'}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="topbar-kicker">assistance</p>
            <h2>Open SOS requests</h2>
          </div>
        </div>
        {overview.openAssistance.length === 0 ? (
          <p className="muted-note" role="status" aria-live="polite">No open SOS requests right now.</p>
        ) : (
          <ul className="settings-list">
            {overview.openAssistance.map((r) => (
              <li key={r.id} className="settings-list-item">
                <div className="min-w-0">
                  <p className="settings-list-title">{r.user.fullName} — {new Date(r.createdAt).toLocaleString()}</p>
                  <p className="settings-list-sub">{r.message}{r.locationShare ? ' · location shared' : ''}</p>
                </div>
                <span className="pill pill-danger">OPEN</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="topbar-kicker">activity</p>
            <h2>Recent journeys</h2>
          </div>
        </div>
        {overview.recentJourneys.length === 0 ? (
          <p className="muted-note" role="status" aria-live="polite">No recent journeys.</p>
        ) : (
          <ul className="settings-list">
            {overview.recentJourneys.map((j) => (
              <li key={j.id} className="settings-list-item">
                <div className="min-w-0">
                  <p className="settings-list-title">{j.user.fullName} → {j.destination}</p>
                  <p className="settings-list-sub">{new Date(j.startedAt).toLocaleString()} · {j.mode}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SafeJourneyTab({
  contacts,
  onNeedContacts,
  announce,
  speak,
  permissionService,
}: {
  contacts: TrustedContact[] | null;
  onNeedContacts: () => void;
  announce: (message: string, tone?: Tone) => void;
  speak: (text: string, priority?: SpeechPriority, dedupeKey?: string) => void;
  permissionService: PermissionService;
}) {
  const [journey, setJourney] = useState<SafeJourney | null>(null);
  const [destination, setDestination] = useState('');
  const [eta, setEta] = useState('');
  const [contactId, setContactId] = useState('');
  const [intervalMin, setIntervalMin] = useState(15);
  const [shareLive, setShareLive] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [battery, setBattery] = useState<number | null>(null);
  const [livePos, setLivePos] = useState<{ lat: number; lng: number } | null>(null);
  const locRef = useRef<{ watchId: number; timer: ReturnType<typeof setInterval> | null } | null>(null);

  const loadActive = useCallback(() => {
    api
      .activeJourney()
      .then((res) => {
        setJourney(res.journey);
        // This tab unmounts on tab switch, which clears the geolocation watch.
        // If we come back to an in-flight journey, the watch MUST restart —
        // otherwise monitoring silently stops while the UI implies otherwise.
        if (res.journey && !locRef.current) beginLocation(res.journey.id);
      })
      .catch(() => setJourney(null));
  }, []);

  useEffect(() => {
    loadActive();
    // Battery level: only read if user has explicitly granted battery permission.
    if (permissionService.get('battery').state === 'allowed') {
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
      nav.getBattery?.().then((b) => setBattery(Math.round(b.level * 100))).catch(() => {});
    }
    return () => {
      if (locRef.current) {
        navigator.geolocation.clearWatch(locRef.current.watchId);
        if (locRef.current.timer) clearInterval(locRef.current.timer);
        locRef.current = null;
      }
    };
  }, [loadActive, permissionService]);

  async function start() {
    if (!destination.trim()) {
      announce('Enter a destination to start a safe journey.', 'warning');
      return;
    }
    setStarting(true);
    setError('');
    try {
      const res = await api.startJourney({
        destination: destination.trim(),
        eta: eta || undefined,
        trustedContactId: contactId || undefined,
        checkInIntervalMinutes: intervalMin,
        shareLive,
      });
      setJourney(res.journey);
      speak(`Safe journey started to ${res.journey.destination}. I will monitor your progress.`, 5, 'journey-start');
      beginLocation(res.journey.id);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not start journey.';
      setError(message);
      announce(message, 'error');
    } finally {
      setStarting(false);
    }
  }

  // Reports location periodically + checks deviation while the journey is active.
  function beginLocation(jid: string) {
    if (!('geolocation' in navigator)) return;
    if (locRef.current) navigator.geolocation.clearWatch(locRef.current.watchId);
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setLivePos({ lat: latitude, lng: longitude });
        api.journeyLocation(jid, { lat: latitude, lng: longitude, accuracy, battery: battery ?? undefined }).catch(() => {});
        api.journeyDeviation(jid, latitude, longitude).then((d) => {
          if (d.action === 'prompt') {
            announce(`You have moved about ${d.deviationMeters} metres off your route. Are you safe?`, 'warning');
            speak(`You have moved about ${d.deviationMeters} metres off your route. Are you safe?`, 3, `deviation-${Math.floor(d.deviationMeters / 100)}`);
          } else if (d.action === 'escalate') {
            announce('No response received. Your trusted contact has been alerted.', 'error');
            speak('No response received. Your trusted contact has been alerted.', 1, 'escalated');
          }
        }).catch(() => {});
      },
      (err) => announce(`Location error: ${err.message}`, 'warning'),
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    const timer = setInterval(() => {
      api.activeJourney().then((res) => {
        setJourney(res.journey);
        if (res.journey?.missedArrival) {
          announce(`Your expected arrival time has passed. Are you safe?`, 'warning');
          speak(`Your expected arrival time has passed. Are you safe?`, 3, 'missed-arrival');
        } else if (res.journey?.promptDue) {
          announce(`Check-in due. Are you safe?`, 'warning');
          speak(`Check-in due. Are you safe?`, 3, 'checkin-due');
        }
      }).catch(() => {});
    }, 60_000);
    locRef.current = { watchId, timer };
  }

  async function checkIn() {
    if (!journey) return;
    await api.journeyCheckIn(journey.id);
    announce('Checked in. I will keep monitoring.', 'online');
    speak('Checked in. I will keep monitoring.');
    loadActive();
  }

  async function lost() {
    if (!journey) return;
    await api.journeyLost(journey.id);
    announce('Help requested. Your trusted contact has been notified.', 'error');
    speak('Help requested. Your trusted contact has been notified.');
  }

  async function end() {
    if (!journey) return;
    await api.endJourney(journey.id);
    if (locRef.current) {
      navigator.geolocation.clearWatch(locRef.current.watchId);
      if (locRef.current.timer) clearInterval(locRef.current.timer);
      locRef.current = null;
    }
    announce('Journey ended. You are safe.', 'online');
    speak('Journey ended. You are safe.');
    setLivePos(null);
    setJourney(null);
  }

  return (
    <div className="screen-grid journey-grid">
      <section className="panel">
        <div className="section-head">
          <div>
            <p className="topbar-kicker">safe journey</p>
            <h2>{journey ? 'Journey in progress' : 'Start a safe journey'}</h2>
          </div>
        </div>

        {journey ? (
          <div className="journey-active">
            <MapView
              userLat={livePos?.lat ?? journey.lastLat}
              userLng={livePos?.lng ?? journey.lastLng}
              height="320px"
            />
            <div className="settings-row">
              <span>Destination</span>
              <strong>{journey.destination}</strong>
            </div>
            <div className="settings-row">
              <span>Status</span>
              <strong>{journey.status}</strong>
            </div>
            {journey.trustedContact && (
              <div className="settings-row">
                <span>Monitored by</span>
                <strong>{journey.trustedContact.name}</strong>
              </div>
            )}
            {journey.eta && (
              <div className="settings-row">
                <span>Expected arrival</span>
                <strong>{new Date(journey.eta).toLocaleTimeString()}</strong>
              </div>
            )}
            {journey.missedArrival && (
              <p role="alert" style={{ color: 'var(--danger)' }}>
                Your expected arrival time has passed.
              </p>
            )}
            <div className="control-inline" style={{ marginTop: 16 }}>
              <button className="secondary-btn" onClick={checkIn}>
                <span aria-hidden="true">✅</span> I'm safe (check-in)
              </button>
              <button className="secondary-btn" onClick={lost} style={{ background: 'var(--danger)', color: '#fff' }}>
                <span aria-hidden="true">🆘</span> I'm lost
              </button>
              <button className="ghost-btn" onClick={end}>
                End journey
              </button>
            </div>
            <p className="muted-note" style={{ marginTop: 12 }}>
              {journey.shareLive ? 'Live location sharing is on for your trusted contact.' : 'Live location sharing is off.'} · Check-in every {journey.checkInIntervalMinutes} min
            </p>
          </div>
        ) : (
          <div className="form-stack">
            <label>
              <span>Destination</span>
              <input aria-label="Destination" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Home, Hospital, Work" />
            </label>
            <label>
              <span>Expected arrival (optional)</span>
              <input aria-label="Expected arrival (optional)" type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} />
            </label>
            <label>
              <span>Trusted contact (optional)</span>
              {contacts && contacts.length > 0 ? (
                <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
                  <option value="">No contact</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <button className="ghost-btn" onClick={onNeedContacts}>
                  Add a trusted contact in SOS first
                </button>
              )}
            </label>
            <label>
              <span>Check-in every (minutes)</span>
              <select aria-label="Check-in every (minutes)" value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))}>
                {[5, 10, 15, 30, 60].map((n) => (
                  <option key={n} value={n}>{n} minutes</option>
                ))}
              </select>
            </label>
            <label className="settings-row">
              <span>Share live location</span>
              <button className="ghost-btn" aria-pressed={shareLive} onClick={() => setShareLive(!shareLive)}>
                {shareLive ? 'On' : 'Off'}
              </button>
            </label>
            {error && (
              <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>
            )}
            <button className="primary-btn" onClick={start} disabled={starting}>
              {starting ? 'Starting…' : <><span aria-hidden="true">🛡️</span> Start safe journey</>}
            </button>
            <p className="muted-note">
              Watchora will ask you if you deviate from your route or miss your arrival, and alert your trusted contact if you do not respond.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsTab({
  user,
  language,
  themeMode,
  onThemeChange,
  voiceRate,
  onVoiceRateChange,
  voice,
  voices,
  onVoiceChange,
  onTestVoice,
  hapticSettings,
  onHapticSettingsChange,
  onTestHaptic,
  voiceSettings,
  onVoiceSettingsChange,
  onLogout,
  readingEntries,
  onDeleteReading,
}: {
  user: PublicUser;
  language: string;
  themeMode: 'Light' | 'Dark';
  onThemeChange: (mode: 'Light' | 'Dark') => void;
  voiceRate: number;
  onVoiceRateChange: (updater: (current: number) => number) => void;
  voice: string;
  voices: TtsVoice[] | null;
  onVoiceChange: (voice: string) => void;
  onTestVoice: () => void;
  hapticSettings: HapticSettings;
  onHapticSettingsChange: (updater: (current: HapticSettings) => HapticSettings) => void;
  onTestHaptic: () => void;
  voiceSettings: VoiceSettings;
  onVoiceSettingsChange: (patch: Partial<VoiceSettings>) => void;
  onLogout: () => void;
  readingEntries: ReadingEntry[] | null;
  onDeleteReading: (id: string) => void;
}) {
  // Group voices by language so the picker reads naturally (e.g. हिन्दी).
  const voiceGroups: Array<[string, TtsVoice[]]> = [];
  if (voices) {
    const byLang = new Map<string, TtsVoice[]>();
    for (const v of voices) {
      const key = `${v.language} · ${v.native}`;
      const arr = byLang.get(key) ?? [];
      arr.push(v);
      byLang.set(key, arr);
    }
    for (const [lang, list] of byLang) voiceGroups.push([lang, list]);
    voiceGroups.sort((a, b) => a[0].localeCompare(b[0]));
  }

  return (
    <div className="screen-grid settings-grid">
      <section className="panel settings-profile-panel">
        <div className="settings-profile">
          <div className="settings-avatar">👤</div>
          <div>
            <h2>{user.fullName}</h2>
            <p>{user.email}</p>
          </div>
        </div>
        <div className="settings-section">
          <h3>Voice & audio</h3>
          <div className="settings-row">
            <span>Language</span>
            <strong>{language}</strong>
          </div>
          <div className="settings-row">
            <span>Neural voice</span>
            <select
              value={voice}
              onChange={(event) => onVoiceChange(event.target.value)}
              aria-label="Neural voice"
              style={{ maxWidth: '100%' }}
            >
              {voiceGroups.length === 0 ? (
                <option value={voice}>{voice}</option>
              ) : (
                voiceGroups.map(([lang, list]) => (
                  <optgroup key={lang} label={lang}>
                    {list.map((v) => (
                      <option key={v.shortName} value={v.shortName}>
                        {v.gender === 'Female' ? '👩' : '👨'} {v.shortName.replace(/-Neural$/, '')}
                      </option>
                    ))}
                  </optgroup>
                ))
              )}
            </select>
          </div>
          <div className="settings-row">
            <span>Reading speed</span>
            <div className="control-inline">
              <button className="ghost-btn" aria-label="Slower" onClick={() => onVoiceRateChange((current) => Math.max(0.7, Number((current - 0.1).toFixed(2))))}>
                -
              </button>
              <strong>{voiceRate.toFixed(2)}x</strong>
              <button className="ghost-btn" aria-label="Faster" onClick={() => onVoiceRateChange((current) => Math.min(1.5, Number((current + 0.1).toFixed(2))))}>
                +
              </button>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!voiceSettings.pushToTalk}
            className={`toggle-row ${!voiceSettings.pushToTalk ? 'on' : 'off'}`}
            onClick={() => onVoiceSettingsChange({ pushToTalk: !voiceSettings.pushToTalk })}
          >
            <span>
              <strong>Hands-free voice control</strong>
              <p>Watchora listens continuously so you can speak commands without touching the screen. Say "Hey Watchora", then your command.</p>
            </span>
            <span aria-hidden="true">{!voiceSettings.pushToTalk ? 'On' : 'Off'}</span>
          </button>
          {!voiceSettings.pushToTalk && (
            <button
              type="button"
              role="switch"
              aria-checked={voiceSettings.wakePhraseEnabled}
              className={`toggle-row ${voiceSettings.wakePhraseEnabled ? 'on' : 'off'}`}
              onClick={() => onVoiceSettingsChange({ wakePhraseEnabled: !voiceSettings.wakePhraseEnabled })}
            >
              <span>
                <strong>Wake phrase</strong>
                <p>Only act after hearing "Hey Watchora". Keeps casual conversation private. Turn off to respond to every command directly.</p>
              </span>
              <span aria-hidden="true">{voiceSettings.wakePhraseEnabled ? 'On' : 'Off'}</span>
            </button>
          )}
          <button className="secondary-btn" onClick={onTestVoice}>
            <span aria-hidden="true">🔊</span> Test voice
          </button>
        </div>
        <div className="settings-section">
          <h3>Hazard alerts</h3>
          <p className="settings-hint">
            Controls for the local, camera-based hazard layer (Assist tab). Follows a
            fail-silent design: when detection confidence is low, nothing fires rather
            than guessing — see the audit notes in docs/yolo-ocr-slam-plan.md.
          </p>
          <div className="settings-row">
            <span>Vibration</span>
            <button
              className="ghost-btn"
              aria-pressed={hapticSettings.hapticsEnabled}
              onClick={() => onHapticSettingsChange((current) => ({ ...current, hapticsEnabled: !current.hapticsEnabled }))}
            >
              {hapticSettings.hapticsEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-row">
            <span>Alert tones</span>
            <button
              className="ghost-btn"
              aria-pressed={hapticSettings.toneEnabled}
              onClick={() => onHapticSettingsChange((current) => ({ ...current, toneEnabled: !current.toneEnabled }))}
            >
              {hapticSettings.toneEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-row">
            <span>Intensity</span>
            <div className="control-inline">
              {(['low', 'medium', 'high'] as const).map((level) => (
                <button
                  key={level}
                  className={`ghost-btn ${hapticSettings.intensity === level ? 'active' : ''}`}
                  aria-pressed={hapticSettings.intensity === level}
                  onClick={() => onHapticSettingsChange((current) => ({ ...current, intensity: level }))}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>
          <button className="secondary-btn" onClick={onTestHaptic}>
            <span aria-hidden="true">📳</span> Test hazard alert
          </button>
        </div>
      </section>
      <section className="panel settings-panel-stack">
        <div className="settings-section">
          <h3>Interface</h3>
          <button className="ghost-btn" onClick={() => onThemeChange(themeMode === 'Light' ? 'Dark' : 'Light')}>
            Theme: {themeMode}
          </button>
        </div>
        <div className="settings-section">
          <h3>Account</h3>
          <div className="settings-row">
            <span>Role</span>
            <strong>{user.role}</strong>
          </div>
          <button className="secondary-btn" onClick={onLogout}>
            Log out
          </button>
        </div>
        <div className="settings-section">
          <h3>Reading history</h3>
          {readingEntries === null ? (
            <p className="muted-note" role="status" aria-live="polite">Loading…</p>
          ) : readingEntries.length === 0 ? (
            <p className="muted-note" role="status" aria-live="polite">No saved readings yet. In Assist mode, switch to Reading and use “Save to reading history”.</p>
          ) : (
            <ul className="settings-list">
              {readingEntries.slice(0, 10).map((entry) => (
                <li key={entry.id} className="settings-list-item">
                  <div className="min-w-0">
                    <p className="settings-list-title">{entry.source}</p>
                    <p className="settings-list-sub">{new Date(entry.createdAt).toLocaleString()}</p>
                  </div>
                  <button className="ghost-btn" onClick={() => onDeleteReading(entry.id)} aria-label="Delete reading entry">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function AdminTab({ announce }: { announce: (message: string, tone?: Tone) => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [incidents, setIncidents] = useState<AdminIncident[] | null>(null);
  const [assistanceRequests, setAssistanceRequests] = useState<AdminAssistanceRequest[] | null>(null);
  const [aiStats, setAiStats] = useState<AiStats | null>(null);
  const [prompts, setPrompts] = useState<PromptVersion[] | null>(null);
  const [promptMode, setPromptMode] = useState<PromptVersion['mode']>('NAVIGATION');
  const [promptText, setPromptText] = useState('');
  const [section, setSection] = useState<'users' | 'incidents' | 'sos' | 'ai' | 'prompts'>('users');

  useEffect(() => {
    api
      .adminListUsers()
      .then((res) => setUsers(res.users))
      .catch(() => announce('Could not load users.', 'error'));
    api
      .adminListIncidents()
      .then((res) => setIncidents(res.incidents))
      .catch(() => announce('Could not load incidents.', 'error'));
    api
      .adminListAssistanceRequests()
      .then((res) => setAssistanceRequests(res.requests))
      .catch(() => announce('Could not load SOS requests.', 'error'));
    api
      .adminAiStats()
      .then(setAiStats)
      .catch(() => announce('Could not load AI usage stats.', 'error'));
    api
      .adminListPrompts()
      .then((res) => setPrompts(res.prompts))
      .catch(() => announce('Could not load prompts.', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setRole(id: string, role: AdminUser['role']) {
    try {
      const { user } = await api.adminSetUserRole(id, role);
      setUsers((prev) => (prev ?? []).map((u) => (u.id === id ? user : u)));
      announce('Role updated.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not update role.', 'error');
    }
  }

  async function setActive(id: string, isActive: boolean) {
    try {
      const { user } = await api.adminSetUserActive(id, isActive);
      setUsers((prev) => (prev ?? []).map((u) => (u.id === id ? user : u)));
      announce(isActive ? 'User reactivated.' : 'User deactivated.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not update user.', 'error');
    }
  }

  async function removeIncident(id: string) {
    try {
      await api.adminDeleteIncident(id);
      setIncidents((prev) => (prev ?? []).filter((i) => i.id !== id));
      announce('Incident removed.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not remove incident.', 'error');
    }
  }

  async function setIncidentStatus(id: string, status: 'OPEN' | 'REVIEWED' | 'REMOVED') {
    try {
      await api.adminSetIncidentStatus(id, status);
      announce(`Incident marked ${status.toLowerCase()}.`, 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not update incident status.', 'error');
    }
  }

  async function createPrompt() {
    if (!promptText.trim()) {
      announce('Enter a prompt first.', 'warning');
      return;
    }
    try {
      await api.adminCreatePrompt({ mode: promptMode, prompt: promptText.trim() });
      setPromptText('');
      const res = await api.adminListPrompts();
      setPrompts(res.prompts);
      announce('Prompt version created.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not create prompt.', 'error');
    }
  }

  async function activatePrompt(id: string) {
    try {
      await api.adminActivatePrompt(id);
      const res = await api.adminListPrompts();
      setPrompts(res.prompts);
      announce('Prompt activated.', 'online');
    } catch (error) {
      announce(error instanceof ApiError ? error.message : 'Could not activate prompt.', 'error');
    }
  }

  return (
    <div className="screen-grid settings-grid">
      <section className="panel list-panel">
        <div className="section-head">
          <h2>Admin</h2>
        </div>
        <div className="analysis-mode-row" role="tablist" aria-label="Admin sections">
          {(['users', 'incidents', 'sos', 'ai', 'prompts'] as const).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={section === key}
              className={`ghost-btn ${section === key ? 'active' : ''}`}
              onClick={() => setSection(key)}
            >
              {key === 'users' ? 'Users' : key === 'incidents' ? 'Incidents' : key === 'sos' ? 'SOS' : key === 'ai' ? 'AI usage' : 'Prompts'}
            </button>
          ))}
        </div>

        {section === 'users' &&
          (users === null ? (
            <p className="soft-note" role="status" aria-live="polite">Loading…</p>
          ) : (
            <div className="route-list">
              {users.map((u) => (
                <div key={u.id} className="route-card">
                  <div>
                    <strong>{u.fullName}</strong>
                    <div className="route-meta">
                      {u.email} · {u.isActive ? 'Active' : 'Deactivated'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select value={u.role} onChange={(event) => setRole(u.id, event.target.value as AdminUser['role'])}>
                      <option value="BLIND_USER">Blind user</option>
                      <option value="CAREGIVER">Caregiver</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                    <button className="ghost-btn" onClick={() => setActive(u.id, !u.isActive)}>
                      {u.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}

        {section === 'incidents' &&
          (incidents === null ? (
            <p className="soft-note" role="status" aria-live="polite">Loading…</p>
          ) : (
            <div className="feed-list">
              {incidents.map((incident) => (
                <div className="feed-card" key={incident.id}>
                  <div className="feed-head">
                    <strong>{incident.category}</strong>
                    <span>{incident.severity}</span>
                  </div>
                  <p>{incident.description}</p>
                  <div className="feed-footer">
                    <span>
                      {incident.reporter.fullName} ({incident.reporter.email})
                    </span>
                    <button className="ghost-btn" onClick={() => removeIncident(incident.id)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}

        {section === 'sos' &&
          (assistanceRequests === null ? (
            <p className="soft-note" role="status" aria-live="polite">Loading…</p>
          ) : (
            <div className="sos-timeline">
              {assistanceRequests.map((req) => (
                <div className="timeline-item" key={req.id}>
                  <div>
                    <strong>{req.user.fullName}</strong> ({req.user.email}) — {new Date(req.createdAt).toLocaleString()}
                  </div>
                  <div>{req.message}</div>
                  <span className={`pill ${req.status === 'RESOLVED' ? 'pill-success' : 'pill-danger'}`}>{req.status}</span>
                </div>
              ))}
            </div>
          ))}

        {section === 'ai' &&
          (aiStats === null ? (
            <p className="soft-note" role="status" aria-live="polite">Loading…</p>
          ) : (
            <div className="stats-cards">
              <div className="metric-card stat-big">
                <span>Total requests</span>
                <strong>{aiStats.total}</strong>
              </div>
              <div className="metric-card stat-big">
                <span>Success rate</span>
                <strong>{aiStats.total ? Math.round((aiStats.successCount / aiStats.total) * 100) : 0}%</strong>
              </div>
              <div className="metric-card stat-big">
                <span>Live vs demo</span>
                <strong>
                  {aiStats.liveCount} / {aiStats.demoCount}
                </strong>
              </div>
              <div className="metric-card stat-big">
                <span>Avg latency</span>
                <strong>{aiStats.averageLatencyMs ?? '—'} ms</strong>
              </div>
              <div className="panel" style={{ gridColumn: '1 / -1', padding: 16 }}>
                <h3>By mode</h3>
                {aiStats.byMode.map((entry) => (
                  <div className="settings-row" key={entry.mode}>
                    <span>{entry.mode}</span>
                    <strong>{entry.count}</strong>
                  </div>
                ))}
                {aiStats.recentErrors.length > 0 ? (
                  <>
                    <h3>Recent errors</h3>
                    {aiStats.recentErrors.map((err) => (
                      <div className="settings-row" key={err.id}>
                        <span>
                          {err.mode} · {new Date(err.createdAt).toLocaleString()}
                        </span>
                        <span>{err.errorMessage}</span>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            </div>
          ))}

        {section === 'prompts' && (
          <div className="panel" style={{ padding: 16 }}>
            <h3>Prompt versions</h3>
            <p className="muted-note">
              Active prompts are used by /api/ai/generate for their mode. Safety teams can tune each mode and activate a version.
            </p>
            <div className="form-stack">
              <label>
                <span>Mode</span>
                <select aria-label="Mode" value={promptMode} onChange={(event) => setPromptMode(event.target.value as PromptVersion['mode'])}>
                  <option value="NAVIGATION">Navigation</option>
                  <option value="ENVIRONMENT">Environment</option>
                  <option value="READING">Reading</option>
                  <option value="ASSISTANT">Assistant</option>
                </select>
              </label>
              <label>
                <span>Prompt</span>
                <textarea aria-label="Prompt" rows={5} value={promptText} onChange={(event) => setPromptText(event.target.value)} placeholder="Write the system prompt for this mode…" />
              </label>
              <button className="primary-btn" onClick={createPrompt}>
                Create version
              </button>
            </div>
            {prompts === null ? (
              <p className="muted-note" role="status" aria-live="polite">Loading…</p>
            ) : prompts.length === 0 ? (
              <p className="muted-note" role="status" aria-live="polite">No prompt versions yet. Create one above.</p>
            ) : (
              <ul className="settings-list">
                {prompts.map((p) => (
                  <li key={p.id} className="settings-list-item">
                    <div className="min-w-0">
                      <p className="settings-list-title">
                        {p.mode} v{p.version} {p.isActive ? <span className="pill pill-success">ACTIVE</span> : null}
                      </p>
                      <p className="settings-list-sub">{p.prompt.slice(0, 120)}{p.prompt.length > 120 ? '…' : ''}</p>
                    </div>
                    {!p.isActive && (
                      <button className="ghost-btn" onClick={() => activatePrompt(p.id)}>
                        Activate
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
