// Product lookup by barcode (EAN/UPC/GTIN), served through our server so the
// strict CSP holds and the user's IP never reaches third-party APIs.
// Provider: OpenFoodFacts (open database, no key). The provider is injectable
// for tests. Responses are cached in-process (products rarely change).

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../lib/auth.js';
import { safeFetch } from '../lib/safe-url.js';
import { recordAudit } from '../lib/audit.js';

export interface ProductInfo {
  found: boolean;
  name?: string;
  brand?: string;
  quantity?: string;
  ingredientsText?: string;
  nutriments?: Record<string, unknown>;
  labels?: string[];
  allergens?: string[];
}

type ProductProvider = (barcode: string) => Promise<ProductInfo>;

const OFF_BASE = process.env.OFF_BASE_URL ?? 'https://world.openfoodfacts.org';

/** OpenFoodFacts v2 product API. Missing fields are normalized away. */
export const openFoodFactsProvider: ProductProvider = async (barcode) => {
  const url = `${OFF_BASE}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,quantity,ingredients_text,nutriments,label_tags,allergens_tags`;
  const res = await safeFetch(url, {
    headers: { 'User-Agent': 'Watchora/1.0 (assistive app; contact: operator@watchora.app)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { found: false };
  const body = (await res.json()) as {
    status?: number;
    product?: {
      product_name?: string;
      brands?: string;
      quantity?: string;
      ingredients_text?: string;
      nutriments?: Record<string, unknown>;
      label_tags?: string[];
      allergens_tags?: string[];
    };
  };
  if (body.status !== 1 || !body.product) return { found: false };
  const p = body.product;
  return {
    found: true,
    name: p.product_name?.slice(0, 200) || undefined,
    brand: p.brands?.split(',')[0]?.trim().slice(0, 100) || undefined,
    quantity: p.quantity?.slice(0, 50) || undefined,
    ingredientsText: p.ingredients_text?.slice(0, 1000) || undefined,
    nutriments: p.nutriments ?? {},
    labels: (p.label_tags ?? []).slice(0, 8),
    allergens: (p.allergens_tags ?? []).slice(0, 8),
  };
};

// Small LRU cache: Map insertion order as recency; products are stable.
const cache = new Map<string, ProductInfo>();
const CACHE_MAX = 500;

const lookupLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many product lookups. Please wait a moment.' },
});

const barcodeSchema = z.string().regex(/^\d{8,14}$/, 'Barcode must be 8-14 digits');

export function makeProductsRouter(provider: ProductProvider = openFoodFactsProvider): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/:barcode',
    lookupLimiter,
    asyncHandler(async (request, response) => {
      const parsed = barcodeSchema.safeParse(String(request.params.barcode));
      if (!parsed.success) {
        response.status(400).json({ error: 'Barcode must be 8-14 digits' });
        return;
      }
      const barcode = parsed.data;

      const cached = cache.get(barcode);
      if (cached) {
        cache.delete(barcode);
        cache.set(barcode, cached);
        response.json({ barcode, product: cached, cached: true });
        return;
      }

      let product: ProductInfo;
      try {
        product = await provider(barcode);
      } catch {
        // Upstream down/timeout: fail honestly, do not cache.
        response.status(502).json({ error: 'Product database is not reachable right now.' });
        return;
      }

      cache.set(barcode, product);
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }

      await recordAudit({
        actorId: request.userId,
        action: 'product.lookup',
        entityType: 'Product',
        entityId: barcode,
        metadata: { found: product.found, cached: false },
      });

      response.json({ barcode, product, cached: false });
    }),
  );

  return router;
}

export const productsRouter: Router = makeProductsRouter();
