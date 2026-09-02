// Barcode product scan (groceries/medication): detect a barcode on the
// existing camera stream, validate its checksum, look the product up through
// our server proxy (/api/products — OpenFoodFacts, user IP never exposed),
// and produce a short spoken summary. Pure logic (validation, formatting,
// cache) is unit-tested; the detection loop is thin glue over BarcodeDetector
// with a ZXing fallback for browsers without the API (iOS Safari).

export interface ProductLookupResult {
  found: boolean;
  name?: string;
  brand?: string;
  quantity?: string;
  ingredientsText?: string;
  nutriments?: Record<string, unknown>;
  allergens?: string[];
}

// ── GTIN checksum (EAN-8, UPC-A/EAN-12, EAN-13, GTIN-14) ──
export function gtinValid(code: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop() as number;
  // GS1: weight 3 on every digit whose distance from the check digit is odd.
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === check;
}

// ── Spoken summary (blind-first: name, brand, size, allergens, sugar/salt) ──
function allergenWords(tags: string[] | undefined): string[] {
  return (tags ?? [])
    .filter((t) => typeof t === 'string' && t.length > 3)
    .map((t) =>
      t
        .replace(/^[a-z]{2}:/, '')
        .replace(/-/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 3);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function formatProductSpeech(p: ProductLookupResult): string {
  if (!p.found) {
    return 'That barcode is not in the open product database yet. You can say read this to have the label read aloud instead.';
  }
  const parts: string[] = [];
  parts.push(p.name ? p.name : 'Unknown product');
  if (p.brand) parts.push(`by ${p.brand}`);
  if (p.quantity) parts.push(`${p.quantity} package`);

  const sentences: string[] = [parts.join(', ') + '.'];

  const allergens = allergenWords(p.allergens);
  if (allergens.length) sentences.push(`Contains ${allergens.join(', ')}.`);

  const n = p.nutriments ?? {};
  const sugar = num(n.sugars_100g);
  const salt = num(n.salt_100g);
  const nutrition: string[] = [];
  if (sugar != null) nutrition.push(`sugar ${Math.round(sugar * 10) / 10} grams`);
  if (salt != null) nutrition.push(`salt ${Math.round(salt * 100) / 100} grams`);
  if (nutrition.length) sentences.push(`Per 100 grams: ${nutrition.join(', ')}.`);

  return sentences.join(' ');
}

// ── Offline cache (scanned products are stable; cap to 100 entries) ──
// Storage is injectable (same pattern as voiceSettingsStorage) so tests can
// pass a stub; production uses localStorage when available.
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const CACHE_KEY = 'watchora_product_cache';
const CACHE_MAX = 100;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readCache(storage: StorageLike | null): Record<string, { at: number; product: ProductLookupResult }> {
  if (!storage) return {};
  try {
    return JSON.parse(storage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function cachedProduct(code: string, storage: StorageLike | null = defaultStorage()): ProductLookupResult | null {
  const entry = readCache(storage)[code];
  return entry ? entry.product : null;
}

export function rememberProduct(code: string, product: ProductLookupResult, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const cache = readCache(storage);
    cache[code] = { at: Date.now(), product };
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].at - cache[b].at);
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    storage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full/blocked: cache is best-effort.
  }
}

// ── Detection loop ──
export interface ScanHandle {
  stop: () => void;
}

interface MinimalBarcodeDetector {
  detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>;
}

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => MinimalBarcodeDetector;

const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'];

/**
 * Watches a live <video> for a barcode. Requires the SAME code to be read
 * twice consecutively (single-frame misreads are common), validates the GTIN
 * checksum, then fires onDetected exactly once. Times out after `timeoutMs`.
 * Uses the native BarcodeDetector when available; falls back to ZXing.
 */
export async function scanBarcode(
  video: HTMLVideoElement,
  onDetected: (code: string) => void,
  timeoutMs = 25_000,
): Promise<ScanHandle> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  const finish = (code: string) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    onDetected(code);
  };

  const deadline = Date.now() + timeoutMs;
  let lastRead = '';
  let lastReadCount = 0;

  const detectOnce = async (detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>>) => {
    if (stopped) return;
    if (video.readyState < 2) return;
    let codes: string[] = [];
    try {
      codes = (await detect(video)).map((r) => r.rawValue).filter(Boolean);
    } catch {
      return; // transient decode error; keep scanning
    }
    for (const code of codes) {
      if (code === lastRead) lastReadCount += 1;
      else {
        lastRead = code;
        lastReadCount = 1;
      }
      if (lastReadCount >= 2 && gtinValid(code)) {
        finish(code);
        return;
      }
    }
  };

  const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (Ctor) {
    const detector = new Ctor({ formats: SCAN_FORMATS });
    timer = setInterval(() => void detectOnce((v) => detector.detect(v)), 300) as unknown as ReturnType<typeof setTimeout>;
  } else {
    // iOS Safari etc.: ZXing fallback, loaded lazily so it stays out of the
    // main bundle for the Chrome/Android majority. decodeFromVideoElement
    // resolves per-frame here (it throws ReadPercent-typed NotFound errors
    // when no code is in frame — caught inside detectOnce).
    const { BrowserMultiFormatReader } = await import('@zxing/library');
    const reader = new BrowserMultiFormatReader();
    timer = setInterval(
      () =>
        void detectOnce(async (v) => {
          try {
            const result = await reader.decodeFromVideoElement(v);
            return [{ rawValue: result.getText() }];
          } catch {
            return [];
          }
        }),
      400,
    ) as unknown as ReturnType<typeof setTimeout>;
  }

  timer = setTimeout(() => {
    if (!stopped) stop();
  }, deadline);

  return { stop };
}
