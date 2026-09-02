import { describe, expect, it } from 'vitest';
import { formatProductSpeech, gtinValid, cachedProduct, rememberProduct, type StorageLike } from '../productScan';

function makeStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
  };
}

describe('gtinValid (GS1 checksum)', () => {
  it('accepts valid EAN-13 / EAN-8 / UPC-A codes', () => {
    expect(gtinValid('3017620422003')).toBe(true); // Nutella EAN-13
    expect(gtinValid('4006381333931')).toBe(true); // EAN-13
    expect(gtinValid('73513537')).toBe(true); // EAN-8
    expect(gtinValid('036000291452')).toBe(true); // UPC-A
  });

  it('rejects checksum failures, wrong lengths, and non-digits', () => {
    expect(gtinValid('3017620422004')).toBe(false);
    expect(gtinValid('1234567890129')).toBe(false); // valid would end in 8
    expect(gtinValid('123')).toBe(false);
    expect(gtinValid('')).toBe(false);
    expect(gtinValid('30176204220a3')).toBe(false);
  });
});

describe('formatProductSpeech', () => {
  it('is honest when the product is not in the database and offers the label-reading fallback', () => {
    const speech = formatProductSpeech({ found: false });
    expect(speech).toContain('not in the open product database');
    expect(speech).toContain('read this');
  });

  it('speaks name, brand, size, allergens and per-100g nutrition', () => {
    const speech = formatProductSpeech({
      found: true,
      name: 'Dark chocolate bar',
      brand: 'TestCo',
      quantity: '100 g',
      allergens: ['en:milk', 'en:nuts'],
      nutriments: { sugars_100g: 24, salt_100g: 0.08 },
    });
    expect(speech).toContain('Dark chocolate bar, by TestCo, 100 g package.');
    expect(speech).toContain('Contains milk, nuts.');
    expect(speech).toContain('sugar 24 grams');
    expect(speech).toContain('salt 0.08 grams');
  });

  it('omits sections it has no data for instead of saying unknown', () => {
    const speech = formatProductSpeech({ found: true, name: 'Plain rice' });
    expect(speech).toBe('Plain rice.');
    expect(speech).not.toContain('undefined');
    expect(speech).not.toContain('unknown');
  });
});

describe('offline product cache', () => {
  it('round-trips a product and evicts oldest beyond 100 entries', () => {
    const storage = makeStorage();
    rememberProduct('111', { found: true, name: 'A' }, storage);
    expect(cachedProduct('111', storage)?.name).toBe('A');
    for (let i = 0; i < 105; i++) rememberProduct(String(1000 + i), { found: true, name: `P${i}` }, storage);
    const raw = JSON.parse(storage.getItem('watchora_product_cache') || '{}');
    expect(Object.keys(raw).length).toBeLessThanOrEqual(100);
    expect(cachedProduct('111', storage)).toBeNull(); // oldest evicted
  });

  it('tolerates missing storage (returns nothing, never throws)', () => {
    rememberProduct('222', { found: true, name: 'B' }, null);
    expect(cachedProduct('222', null)).toBeNull();
  });
});
