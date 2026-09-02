import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl } from '../safe-url.js';

describe('assertPublicHttpUrl (SSRF guard)', () => {
  it('accepts public https URLs', async () => {
    await expect(assertPublicHttpUrl('https://generativelanguage.googleapis.com/v1beta/models')).resolves.toBeInstanceOf(URL);
  });

  it('rejects non-http schemes', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/http\/https/);
    await expect(assertPublicHttpUrl('ftp://example.com')).rejects.toThrow(/http\/https/);
  });

  it('rejects localhost and internal hostnames', async () => {
    await expect(assertPublicHttpUrl('http://localhost:4000/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://api.localhost/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://db.internal/')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://printer.local/')).rejects.toThrow();
  });

  it('rejects loopback and private IP literals', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:4000/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://10.0.0.5/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://172.16.0.9/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://192.168.1.1/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://0.0.0.0/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://[fd00::1]/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/not allowed/);
  });
});
