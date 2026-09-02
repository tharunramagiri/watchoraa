// Free, no-key neural text-to-speech via Microsoft Edge's online TTS service
// (edge-tts). 400+ neural voices across ~140 locales, including all major
// Indian languages. No API key, no quota. Uses the same endpoint Edge's Read
// Aloud uses, with the Sec-MS-GEC token generated exactly like the maintained
// python `edge-tts` package (rany2/edge-tts, MIT) — see
// https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py

import { createHash, randomUUID } from 'node:crypto';
import { safeFetch } from '../../lib/safe-url.js';
import WebSocket from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0`;
const WIN_EPOCH = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const SYNTH_TIMEOUT_MS = 30_000;

export interface EdgeVoice {
  Name: string;
  ShortName: string;
  FriendlyName: string;
  Gender: 'Male' | 'Female';
  Locale: string;
}

export function generateSecMsGec(nowMs: number = Date.now()): string {
  // Windows FILETIME ticks (100ns since 1601) rounded down to 5 minutes,
  // concatenated with the trusted client token, then SHA-256 uppercased.
  let ticks = nowMs / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300; // round down to the nearest 5-minute boundary
  ticks *= 1e9 / 100; // seconds -> 100-nanosecond intervals
  const strToHash = `${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  return createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

// The endpoint rejects requests whose Sec-MS-GEC (derived from the clock) is
// outside the current 5-minute window. If the host clock is skewed, the server
// returns 403 with a Date header — we correct and retry once, like the python
// edge-tts package (DRM.clock_skew_seconds).
let clockSkewSeconds = 0;

function nowMs(): number {
  return Date.now() + clockSkewSeconds * 1000;
}

function parseRfc2616Date(date: string): number | null {
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

const VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

export async function fetchVoiceList(): Promise<EdgeVoice[]> {
  const res = await safeFetch(VOICE_LIST_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'Sec-MS-GEC': generateSecMsGec(nowMs()),
      'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`voice list ${res.status}`);
  const json = (await res.json()) as EdgeVoice[];
  return json.map((v) => ({
    Name: v.Name,
    ShortName: v.ShortName,
    FriendlyName: v.FriendlyName,
    Gender: v.Gender,
    Locale: v.Locale,
  }));
}

function wssUrl(): string {
  const gec = generateSecMsGec(nowMs());
  return (
    `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${randomUUID().replaceAll('-', '')}`
  );
}

function wsHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Sec-MS-GEC': generateSecMsGec(nowMs()),
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function escXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Splits long text into sentence-bounded chunks (edge handles each easily). */
export function chunkText(text: string, maxLen = 1500): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxLen, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('. ', end);
      const nl = clean.lastIndexOf('\n', end);
      const cut = Math.max(boundary, nl);
      if (cut > start + maxLen * 0.4) end = cut + 1;
    }
    out.push(clean.slice(start, end).trim());
    start = end;
  }
  return out.filter(Boolean);
}

export interface SynthOptions {
  voice: string;
  rate?: number; // 1 = normal, 1.05 = +5%
  pitch?: string;
  volume?: string;
}

function rateToSsml(rate: number): string {
  const clamped = Math.min(2, Math.max(0.5, rate));
  const pct = Math.round((clamped - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** Synthesizes text to an MP3 Buffer via the free Edge endpoint. */
export async function synthesize(text: string, options: SynthOptions): Promise<Buffer> {
  const chunks = chunkText(text);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parts: Buffer[] = [];
      for (const chunk of chunks) {
        parts.push(await synthesizeChunk(chunk, options));
      }
      return Buffer.concat(parts);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // 403 (skew) already corrected inside synthesizeChunk; retry fresh.
      if (!String(lastError.message).includes('403')) break;
    }
  }
  throw lastError ?? new Error('TTS synthesis failed');
}

function synthesizeChunk(text: string, options: SynthOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wssUrl(), { headers: wsHeaders() });
    const audio: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error('TTS synthesis timed out'));
      }
    }, SYNTH_TIMEOUT_MS);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(Buffer.concat(audio));
    };

    // 403 from the server: the Sec-MS-GEC token drifted (clock skew). Read the
    // server Date header, correct the skew, and reject so synthesize() retries.
    ws.on('unexpected-response', (_request, response) => {
      const dateHeader = response.headers['date'];
      const serverTime = typeof dateHeader === 'string' ? parseRfc2616Date(dateHeader) : null;
      if (serverTime != null) {
        clockSkewSeconds = serverTime - Date.now() / 1000;
      }
      response.resume();
      finish(new Error(`TTS 403 (skew corrected to ${clockSkewSeconds.toFixed(1)}s)`));
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const s = data.toString('utf8');
        if (s.includes('turn.end')) finish();
        return;
      }
      const buf = data as Buffer;
      // Edge frames are `Path:audio\r\n<bytes>` — no blank line between the
      // header and the audio payload.
      const marker = Buffer.from('Path:audio\r\n');
      const idx = buf.indexOf(marker);
      if (idx === -1) return;
      audio.push(buf.subarray(idx + marker.length));
    });
    ws.on('error', (e: Error) => finish(e instanceof Error ? e : new Error(String(e))));
    ws.on('close', () => {
      // Close without turn.end (error path) — resolve with what we have if any.
      if (!settled && audio.length > 0) finish();
      else if (!settled) finish(new Error('TTS connection closed unexpectedly'));
    });

    ws.on('open', () => {
      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: OUTPUT_FORMAT,
            },
          },
        },
      });
      ws.send(`X-Timestamp:${new Date().toUTCString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${config}`, { compress: true });
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${escXml(options.voice)}'>` +
        `<prosody pitch='${options.pitch ?? '+0Hz'}' rate='${rateToSsml(options.rate ?? 1)}' volume='${options.volume ?? '+0%'}'>` +
        `${escXml(text)}</prosody></voice></speak>`;
      const reqId = randomUUID().replaceAll('-', '');
      ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toUTCString()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
        { compress: true },
      );
    });
  });
}
