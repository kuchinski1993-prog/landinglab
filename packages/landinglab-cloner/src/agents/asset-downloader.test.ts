// Testes de `asset-downloader.ts`:
// - `downloadAssets` — dedup por URL, hash SHA256 no filename (mesma URL 2x = 1 file),
//   captura falhas sem abortar batch, urlMap correto.
// - `rewriteUrls` — coberto em `orchestrator.test.ts`.
//
// NOTA: o package NÃO implementa retry-on-429 hoje. `downloadOne` joga direto
// em qualquer status !res.ok. Se retry for requisito de negócio, deve ser
// adicionado como camada extra. Teste de erro HTTP abaixo documenta o
// comportamento atual (a URL vai pra `failed[]`, batch continua).

import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadAssets } from './asset-downloader.js';

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000d49444154789c626000000000050001aa0d20e50000000049454e44ae426082',
  'hex',
);

describe('downloadAssets', () => {
  let tmpRoot: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'cloner-test-'));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('dedupa URLs repetidas — 1 fetch por URL única', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await downloadAssets({
      landingId: 'lp-1',
      urls: [
        'https://cdn.com/a.png',
        'https://cdn.com/a.png', // duplicada
        'https://cdn.com/a.png', // duplicada
        'https://cdn.com/b.png',
      ],
      storageRoot: tmpRoot,
      publicPathPrefix: '/static/cloned',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // dedupa pra 2 únicos
    expect(result.assets).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.urlMap.size).toBe(2);
  });

  it('gera filename baseado em SHA256 estável (mesma URL = mesmo hash)', async () => {
    globalThis.fetch = (async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;

    const r1 = await downloadAssets({
      landingId: 'lp-A',
      urls: ['https://cdn.com/logo.png'],
      storageRoot: tmpRoot,
      publicPathPrefix: '/s',
    });

    const tmpRoot2 = await mkdtemp(join(tmpdir(), 'cloner-test-'));
    try {
      const r2 = await downloadAssets({
        landingId: 'lp-B',
        urls: ['https://cdn.com/logo.png'],
        storageRoot: tmpRoot2,
        publicPathPrefix: '/s',
      });

      const name1 = r1.assets[0]!.localPath.split('/').pop();
      const name2 = r2.assets[0]!.localPath.split('/').pop();
      // Filenames iguais pra mesma URL (deterministic hash), mas dirs
      // (landingId) diferentes — dedup cross-landing via cache seria upstream.
      expect(name1).toBe(name2);
      expect(name1).toMatch(/^[a-f0-9]{16}\.png$/);
    } finally {
      await rm(tmpRoot2, { recursive: true, force: true });
    }
  });

  it('deriva extensão do content-type (image/webp → .webp)', async () => {
    globalThis.fetch = (async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      })) as unknown as typeof fetch;

    const result = await downloadAssets({
      landingId: 'lp-1',
      urls: ['https://cdn.com/hero'],
      storageRoot: tmpRoot,
      publicPathPrefix: '/s',
    });
    expect(result.assets[0]!.localPath).toMatch(/\.webp$/);
    expect(result.assets[0]!.publicUrl).toMatch(/\.webp$/);
  });

  it('falha uma URL específica sem abortar o batch inteiro', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('bad')) {
        return new Response('nope', { status: 404 });
      }
      return new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as unknown as typeof fetch;

    const result = await downloadAssets({
      landingId: 'lp-1',
      urls: [
        'https://cdn.com/good1.png',
        'https://cdn.com/bad.png',
        'https://cdn.com/good2.png',
      ],
      storageRoot: tmpRoot,
      publicPathPrefix: '/s',
    });

    expect(result.assets).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.url).toContain('bad.png');
    expect(result.failed[0]!.error).toMatch(/HTTP 404/);
  });

  it('propaga 429 pra `failed` (NÃO retenta — comportamento atual)', async () => {
    // Documenta: o downloader não faz backoff de 429. Task esperava retry;
    // gap é registrado no relatório final. Se adicionarmos retry, este teste
    // muda pra assertar Nx retentativas antes de gastar o failed slot.
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;

    const result = await downloadAssets({
      landingId: 'lp-1',
      urls: ['https://cdn.com/x.png'],
      storageRoot: tmpRoot,
      publicPathPrefix: '/s',
    });
    expect(result.assets).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/HTTP 429/);
  });

  it('ignora URLs data: (não faz fetch, não cria asset)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await downloadAssets({
      landingId: 'lp-1',
      urls: [
        'data:image/png;base64,iVBOR',
        'https://cdn.com/real.png',
      ],
      storageRoot: tmpRoot,
      publicPathPrefix: '/s',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.assets).toHaveLength(1);
  });

  it('escreve arquivo real no disco em {storageRoot}/{landingId}/', async () => {
    globalThis.fetch = (async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;

    await downloadAssets({
      landingId: 'my-lp',
      urls: ['https://cdn.com/img.png'],
      storageRoot: tmpRoot,
      publicPathPrefix: '/s',
    });
    const files = await readdir(join(tmpRoot, 'my-lp'));
    expect(files).toHaveLength(1);
    const st = await stat(join(tmpRoot, 'my-lp', files[0]!));
    expect(st.size).toBeGreaterThan(0);
  });

  it('publicUrl inclui prefix + landingId + filename', async () => {
    globalThis.fetch = (async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;

    const result = await downloadAssets({
      landingId: 'lp-1',
      urls: ['https://cdn.com/x.png'],
      storageRoot: tmpRoot,
      publicPathPrefix: '/static/cloned/', // com trailing slash — deve ser normalizado
    });
    expect(result.assets[0]!.publicUrl).toMatch(/^\/static\/cloned\/lp-1\/[a-f0-9]{16}\.png$/);
    // urlMap deve conter mapeamento original → public
    expect(result.urlMap.get('https://cdn.com/x.png')).toBe(result.assets[0]!.publicUrl);
  });
});
