// Story 18.2 · AC8 — safe-fetch unificado (movido de packages/vsl-hosting; mesmas expectativas + casos novos).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isPrivateAddress, parsePublicHttpUrl, safeFetch, SafeFetchError, type SafeFetchOptions } from '../http/safe-fetch.js';

let server: Server;
let port: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const hop = Number(url.searchParams.get('n') ?? 0);
    if (url.pathname === '/ok') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(`h1{} /* host=${req.headers.host} */`); return; }
    if (url.pathname === '/chain') { res.writeHead(302, { location: hop >= 4 ? '/ok' : `/chain?n=${hop + 1}` }); res.end(); return; }
    if (url.pathname === '/to-private') { res.writeHead(301, { location: `http://evil.example.com:${port}/ok` }); res.end(); return; }
    if (url.pathname === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (url.pathname === '/to-metadata-host') { res.writeHead(302, { location: `http://metadata.example.com:${port}/ok` }); res.end(); return; }
    if (url.pathname === '/big') { res.writeHead(200, { 'content-type': 'image/webp' }); res.end(Buffer.alloc(5000)); return; }
    if (url.pathname === '/slow') return; // nunca responde
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = String((server.address() as AddressInfo).port);
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

/** Resolve hostnames de teste: cdn.example.com → servidor local; evil.example.com → IP privado. */
const options = (extra: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  maxBytes: 1024, timeoutMs: 2000, allowedPorts: [port],
  resolve: async (host) => [{ address: host === 'evil.example.com' ? '10.0.0.7' : '127.0.0.1', family: 4 }],
  isBlockedAddress: (address) => address.startsWith('10.'),
  ...extra,
});

describe('safeFetch', () => {
  it('rejects non-public URLs before any connection', () => {
    for (const raw of ['ftp://cdn.example.com/a', 'http://user:pw@cdn.example.com/', 'http://localhost/', 'http://intranet/', 'http://cdn.example.com:8080/',
      'http://servidor.local/', 'javascript:alert(1)', 'nada'])
      expect(() => parsePublicHttpUrl(raw), raw).toThrow(expect.objectContaining({ reason: 'invalid_url' }));
    for (const raw of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://10.1.2.3/', 'http://192.168.0.1/'])
      expect(() => parsePublicHttpUrl(raw), raw).toThrow(expect.objectContaining({ reason: 'private_address' }));
    expect(parsePublicHttpUrl('https://cdn.example.com/a.css#x').href).toBe('https://cdn.example.com/a.css');
  });

  it('blocks hostnames that resolve to private addresses (default blocklist)', async () => {
    await expect(safeFetch('http://metadata.example.com/', { maxBytes: 10, timeoutMs: 1000, resolve: async () => [{ address: '169.254.169.254', family: 4 }] }))
      .rejects.toMatchObject({ reason: 'private_address' });
    await expect(safeFetch('http://mixed.example.com/', { maxBytes: 10, timeoutMs: 1000,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }] }))
      .rejects.toMatchObject({ reason: 'private_address' });
  });

  it('fetches through the pinned address with the original Host header', async () => {
    const result = await safeFetch(`http://cdn.example.com:${port}/ok`, options());
    expect(result).toMatchObject({ status: 200, contentType: 'text/css' });
    expect(result.bytes.toString()).toContain(`host=cdn.example.com:${port}`);
  });

  it('follows at most 3 redirects and revalidates every hop', async () => {
    await expect(safeFetch(`http://cdn.example.com:${port}/chain?n=2`, options())).resolves.toMatchObject({ status: 200 });
    expect((await safeFetch(`http://cdn.example.com:${port}/chain?n=2`, options())).url.pathname).toBe('/ok');
    await expect(safeFetch(`http://cdn.example.com:${port}/chain?n=0`, options())).rejects.toMatchObject({ reason: 'too_many_redirects' });
    await expect(safeFetch(`http://cdn.example.com:${port}/to-private`, options())).rejects.toMatchObject({ reason: 'private_address' });
  });

  it('enforces size, status and timeout', async () => {
    await expect(safeFetch(`http://cdn.example.com:${port}/big`, options())).rejects.toMatchObject({ reason: 'too_large' });
    await expect(safeFetch(`http://cdn.example.com:${port}/nope`, options())).rejects.toMatchObject({ reason: 'http_status', status: 404 });
    await expect(safeFetch(`http://cdn.example.com:${port}/slow`, options({ timeoutMs: 300 }))).rejects.toMatchObject({ reason: 'timeout' });
  });
});

describe('safeFetch — casos da story 18.2 (AC8)', () => {
  it('isPrivateAddress cobre loopback, privadas, metadados, IPv6 e IPv4 mapeado; texto não-IP é bloqueado', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'nao-e-ip'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('IPv4 mapeado em IPv6 literal na URL é bloqueado antes de conectar', () => {
    expect(() => parsePublicHttpUrl('http://[::ffff:127.0.0.1]/')).toThrow(expect.objectContaining({ reason: 'private_address' }));
    expect(() => parsePublicHttpUrl('http://[::ffff:a9fe:a9fe]/')).toThrow(expect.objectContaining({ reason: 'private_address' }));
  });

  it('credenciais e portas fora de 80/443 são inválidas', () => {
    expect(() => parsePublicHttpUrl('https://user@cdn.example.com/')).toThrow(expect.objectContaining({ reason: 'invalid_url' }));
    expect(() => parsePublicHttpUrl('https://cdn.example.com:8443/')).toThrow(expect.objectContaining({ reason: 'invalid_url' }));
    expect(parsePublicHttpUrl('https://cdn.example.com:443/a').href).toBe('https://cdn.example.com/a');
  });

  it('hostname com qualquer endereço privado entre vários é bloqueado (lista padrão)', async () => {
    await expect(safeFetch('http://multi.example.com/', { maxBytes: 10, timeoutMs: 1000,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '8.8.8.8', family: 4 }, { address: '10.9.8.7', family: 4 }] }))
      .rejects.toMatchObject({ reason: 'private_address' });
  });

  it('redirect para o IP de metadados é bloqueado no salto (nenhuma conexão ao destino)', async () => {
    const blocked = (address: string) => address !== '127.0.0.1' && isPrivateAddress(address);
    await expect(safeFetch(`http://cdn.example.com:${port}/to-metadata`, options({ isBlockedAddress: blocked })))
      .rejects.toMatchObject({ reason: 'private_address' });
  });

  it('redirect para hostname que resolve para metadados é bloqueado no salto', async () => {
    const resolve = async (host: string) => [{ address: host === 'metadata.example.com' ? '169.254.169.254' : '127.0.0.1', family: 4 }];
    const blocked = (address: string) => address !== '127.0.0.1' && isPrivateAddress(address);
    await expect(safeFetch(`http://cdn.example.com:${port}/to-metadata-host`, options({ resolve, isBlockedAddress: blocked })))
      .rejects.toMatchObject({ reason: 'private_address' });
  });

  it('falhas saem como SafeFetchError com reason', async () => {
    const err = await safeFetch('http://cdn.example.com/', { maxBytes: 10, timeoutMs: 1000, resolve: async () => [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err).toMatchObject({ reason: 'dns_failed' });
  });
});
