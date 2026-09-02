import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for every server-side outbound fetch: only http/https, and the
 * host must resolve to a public address. Blocks localhost, loopback, private,
 * link-local, CGNAT and other reserved ranges — including via DNS, so a
 * hostname that rebinding-resolves to 169.254.169.254 or 127.0.0.1 is
 * rejected before any request is made.
 */

const BLOCKED_HOSTNAMES = new Set(['localhost']);

function isReservedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    if (lower.startsWith('::ffff:')) return isReservedIp(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return true;
}

/**
 * Validates a URL for outbound fetching. Throws with a generic reason on any
 * violation. Returns the parsed URL on success.
 */
export async function assertPublicHttpUrl(rawUrl: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Host is not allowed');
  }
  // IP literals are checked directly; hostnames must resolve to public IPs
  // (defeats DNS rebinding into private space).
  if (isIP(host)) {
    if (isReservedIp(host)) throw new Error('Address is not allowed');
    return url;
  }
  const records = await lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new Error('Could not resolve host');
  });
  for (const record of records) {
    if (isReservedIp(record.address)) throw new Error('Address is not allowed');
  }
  return url;
}

/** fetch() with the SSRF guard. Drop-in for outbound server requests. */
export async function safeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const validated = await assertPublicHttpUrl(url);
  return fetch(validated, init);
}
