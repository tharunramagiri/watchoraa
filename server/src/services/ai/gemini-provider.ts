import { z } from 'zod';
import { safeFetch } from '../../lib/safe-url.js';
import { buildPrompt } from './prompt-builder.js';
import { AiProviderError, type AiProvider, type AiRequest, type AiResult } from './types.js';

const modelResponseSchema = z.object({
  summary: z.string().min(1).max(600),
  details: z.array(z.string().max(400)).max(5).default([]),
  warnings: z.array(z.string().max(400)).max(5).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('low'),
  shouldStop: z.boolean().default(false),
});

const GEMINI_TIMEOUT_MS = 15_000;

export class GeminiProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async generate(request: AiRequest, signal: AbortSignal): Promise<AiResult> {
    if (request.mode === 'emergency') {
      throw new AiProviderError('AI is not used for emergency mode', 'unsupported');
    }

    const prompt = request.promptOverride ?? buildPrompt(request.mode, request.prompt);
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];

    if (request.imageBase64 && request.imageMimeType) {
      parts.push({
        inline_data: {
          mime_type: request.imageMimeType,
          data: request.imageBase64,
        },
      });
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), GEMINI_TIMEOUT_MS);
    const onExternalAbort = () => timeoutController.abort();
    signal.addEventListener('abort', onExternalAbort);

    let response: Response;
    try {
      response = await safeFetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.4,
            },
          }),
          signal: timeoutController.signal,
        },
      );
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new AiProviderError('Gemini request timed out', 'timeout');
      }
      throw new AiProviderError(error instanceof Error ? error.message : 'Gemini request failed', 'provider_error');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onExternalAbort);
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AiProviderError('Gemini rejected the request (invalid API key or malformed request)', 'invalid_key');
    }

    if (!response.ok) {
      throw new AiProviderError(`Gemini provider error (status ${response.status})`, 'provider_error');
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new AiProviderError('Gemini returned an empty response', 'provider_error');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      throw new AiProviderError('Gemini returned a non-JSON response', 'provider_error');
    }

    const parsed = modelResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new AiProviderError('Gemini response did not match the expected shape', 'provider_error');
    }

    return {
      mode: request.mode,
      summary: parsed.data.summary,
      details: parsed.data.details,
      warnings: parsed.data.warnings,
      confidence: parsed.data.confidence,
      shouldStop: parsed.data.shouldStop,
    };
  }
}
