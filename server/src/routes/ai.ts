import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { safeFetch } from '../lib/safe-url.js';
import { requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { getAiProvider, AiProviderError, type AiMode } from '../services/ai/ai-provider.js';
import { buildPrompt, buildPromptWithOverride } from '../services/ai/prompt-builder.js';

export const aiRouter = Router();

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB decoded
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png']);
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/;

const generateSchema = z.object({
  mode: z.enum(['navigation', 'assistant', 'reading', 'environment', 'emergency']),
  prompt: z.string().min(1).max(2000),
  imageDataUrl: z.string().max(9_000_000).optional(),
  demo: z.boolean().optional(),
});

const aiRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analysis requests. Please wait a moment and try again.' },
});

function decodeImage(imageDataUrl: string): { base64: string; mimeType: string } {
  const match = DATA_URL_PATTERN.exec(imageDataUrl);
  if (!match) {
    throw new AiProviderError('Image must be a base64 data URL with mime type image/jpeg or image/png', 'unsupported');
  }

  const [, mimeType, base64] = match;
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
    throw new AiProviderError('Unsupported image type', 'unsupported');
  }

  const decodedBytes = Math.floor((base64.length * 3) / 4);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw new AiProviderError('Image is too large. Maximum decoded size is 6MB.', 'unsupported');
  }

  return { base64, mimeType };
}

function statusForError(error: AiProviderError): number {
  switch (error.kind) {
    case 'invalid_key':
      return 502;
    case 'timeout':
      return 504;
    case 'unsupported':
      return 400;
    default:
      return 502;
  }
}

function logAiRequest(entry: {
  userId?: string;
  mode: AiMode;
  provider: string;
  model: string;
  latencyMs: number;
  success: boolean;
  redactedInput: string;
  redactedOutput?: string;
  errorMessage?: string;
  promptVersion?: number;
}) {
  prisma.aIRequestLog
    .create({
      data: {
        userId: entry.userId,
        mode: entry.mode.toUpperCase() as 'NAVIGATION' | 'ASSISTANT' | 'READING' | 'ENVIRONMENT' | 'EMERGENCY',
        provider: entry.provider,
        model: entry.model,
        latencyMs: entry.latencyMs,
        success: entry.success,
        redactedInput: entry.redactedInput,
        redactedOutput: entry.redactedOutput,
        errorMessage: entry.errorMessage,
        promptVersion: entry.promptVersion,
      },
    })
    .catch(() => {
      // Logging is best-effort; never let it break the AI response path.
    });
}

const intentSchema = z.object({
  transcript: z.string().min(1).max(500),
});

// Safety-limited AI intent parsing (v0.4 voice-first): only non-safety-critical
// intents are allowed. Emergency/journey cancellation commands are locked to the
// deterministic router and never delegated here. Server-side so no API key is
// ever exposed to the frontend. Exported for tests that enforce the allow-list.
export const SAFE_AI_INTENTS = [
  'describe_scene',
  'read_text',
  'start_navigation',
  'start_safe_journey',
  'check_journey',
  'change_setting',
  'open_tab',
  'report_hazard',
  'list_places',
  'save_place',
  'shopping',
  'identify_color',
  'identify_currency',
  'read_expiry',
  'help',
];

const INTENT_PROMPT = `You are the intent parser for Watchora, an assistive app for blind and low-vision people.
Parse the user's spoken command into a single JSON object:
{"intent": string, "parameters": {string: string|number|boolean}, "confidence": number, "requiresConfirmation": boolean}
Allowed intents: ${SAFE_AI_INTENTS.join(', ')}.
Never invent emergency, cancellation, or safety-critical intents. If the command is unsafe, unsupported, or unclear, return {"intent":"unknown","parameters":{},"confidence":0,"requiresConfirmation":false}.
Respond with ONLY the JSON object, no markdown.`;

aiRouter.post(
  '/intent',
  aiRateLimiter,
  requireAuth,
  asyncHandler(async (request, response) => {
    const parsed = intentSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    if (!env.GEMINI_API_KEY) {
      // No AI configured: deterministic router alone is enough for safety commands.
      response.json({ intent: 'unknown', parameters: {}, confidence: 0, requiresConfirmation: false });
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await safeFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${INTENT_PROMPT}\n\nUser command: "${parsed.data.transcript}"` }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);
      if (!res.ok) {
        response.json({ intent: 'unknown', parameters: {}, confidence: 0, requiresConfirmation: false });
        return;
      }
      const payload = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      let obj: Record<string, unknown> = {};
      try {
        obj = text ? (JSON.parse(text.replace(/```json|```/g, '').trim()) as Record<string, unknown>) : {};
      } catch {
        obj = {};
      }
      const intent = String(obj.intent ?? 'unknown');
      if (!SAFE_AI_INTENTS.includes(intent)) {
        response.json({ intent: 'unknown', parameters: {}, confidence: 0, requiresConfirmation: false });
        return;
      }
      response.json({
        intent,
        parameters: typeof obj.parameters === 'object' && obj.parameters !== null ? obj.parameters : {},
        confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
        requiresConfirmation: obj.requiresConfirmation === true,
      });
    } catch {
      response.json({ intent: 'unknown', parameters: {}, confidence: 0, requiresConfirmation: false });
    }
  }),
);

// ── Prompt versioning fallback (kept) ──
aiRouter.post(
  '/generate',
  aiRateLimiter,
  requireAuth, // account-gated: AI analysis is only for signed-in users (roadmap: RBAC first)
  asyncHandler(async (request, response) => {
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const { mode, prompt, imageDataUrl, demo } = parsed.data;

    if (mode === 'emergency') {
      response.status(400).json({
        error: 'AI scene analysis is not used for emergency mode. Use the SOS workflow instead.',
      });
      return;
    }

    // Prompt versioning: if an admin activated a custom prompt for this mode,
    // use it as the instruction block — but ALWAYS composed with the safety
    // contract and response shape (buildPromptWithOverride appends them after
    // the override, so an admin prompt can never remove the guardrails).
    let resolvedPrompt = buildPrompt(mode, prompt);
    let promptVersion: number | null = null;
    try {
      const active = await prisma.promptVersion.findFirst({
        where: { mode: mode.toUpperCase() as 'NAVIGATION' | 'ASSISTANT' | 'READING' | 'ENVIRONMENT' | 'EMERGENCY', isActive: true },
        orderBy: { version: 'desc' },
      });
      if (active) {
        resolvedPrompt = buildPromptWithOverride(mode, prompt, active.prompt);
        promptVersion = active.version;
      }
    } catch {
      // Fall back to the built-in prompt if the lookup fails.
    }

    let image: { base64: string; mimeType: string } | undefined;
    try {
      if (imageDataUrl) {
        image = decodeImage(imageDataUrl);
      }
    } catch (error) {
      if (error instanceof AiProviderError) {
        response.status(statusForError(error)).json({ error: error.message });
        return;
      }
      throw error;
    }

    const forceDemo = demo === true || !env.GEMINI_API_KEY;
    const provider = forceDemo ? getAiProvider(undefined, env.GEMINI_MODEL) : getAiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);

    const controller = new AbortController();
    const onClientDisconnect = () => controller.abort();
    request.on('close', onClientDisconnect);

    const startedAt = Date.now();
    const redactedInput = JSON.stringify({ promptLength: prompt.length, hasImage: Boolean(image) });

    try {
      const result = await provider.generate(
        {
          mode: mode as AiMode,
          prompt,
          promptOverride: promptVersion != null ? resolvedPrompt : undefined,
          imageBase64: image?.base64,
          imageMimeType: image?.mimeType,
        },
        controller.signal,
      );

      logAiRequest({
        userId: request.userId,
        mode: mode as AiMode,
        provider: forceDemo ? 'demo' : 'gemini',
        model: forceDemo ? 'demo' : env.GEMINI_MODEL,
        latencyMs: Date.now() - startedAt,
        success: true,
        redactedInput,
        redactedOutput: result.summary.slice(0, 500),
        promptVersion: promptVersion ?? undefined,
      });

      response.json({ ...result, demo: forceDemo });
    } catch (error) {
      const errorMessage = error instanceof AiProviderError ? error.message : error instanceof Error ? error.message : 'Unknown error';
      logAiRequest({
        userId: request.userId,
        mode: mode as AiMode,
        provider: forceDemo ? 'demo' : 'gemini',
        model: forceDemo ? 'demo' : env.GEMINI_MODEL,
        latencyMs: Date.now() - startedAt,
        success: false,
        redactedInput,
        errorMessage,
      });

      if (error instanceof AiProviderError) {
        response.status(statusForError(error)).json({ error: error.message, kind: error.kind });
        return;
      }
      throw error;
    } finally {
      request.off('close', onClientDisconnect);
    }
  }),
);
