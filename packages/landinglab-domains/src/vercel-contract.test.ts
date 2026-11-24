// Story 18.2 · T1/AC11 — caracterização do contrato público do cliente Vercel (escrita ANTES da
// troca da cópia local de fetchWithTimeout pelo cliente de @blackshop/shared/http).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVercelDomainsClient, VercelDomainsHttpError } from './vercel.js';

function status(code: number, body = ''): Response {
  return { ok: code >= 200 && code < 300, status: code, json: async () => ({}), text: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Vercel — contrato preservado (caracterização)', () => {
  it('mensagem, status e body do VercelDomainsHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(status(403, 'forbidden')));
    const err = (await createVercelDomainsClient()
      .addDomainToProject('x.com', 'prj', 'tk')
      .catch((e: unknown) => e)) as VercelDomainsHttpError;
    expect(err).toBeInstanceOf(VercelDomainsHttpError);
    expect(err.name).toBe('VercelDomainsHttpError');
    expect(err.message).toBe('Vercel API POST https://api.vercel.com/v10/projects/prj/domains failed with 403');
    expect(err).toMatchObject({ status: 403, body: 'forbidden' });
  });

  it('GET (getDomainStatus) com 503 persistente → 3 tentativas e VercelDomainsHttpError 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(503, 'down'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVercelDomainsClient().getDomainStatus('x.com', 'prj', 'tk')).rejects.toMatchObject({
      name: 'VercelDomainsHttpError',
      status: 503,
      body: 'down',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('DELETE (removeDomain) com 500 é repetido como hoje', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(status(500)).mockResolvedValueOnce(status(200));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVercelDomainsClient().removeDomain('x.com', 'prj', 'tk')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429 persistente → 3 tentativas e VercelDomainsHttpError 429 com o corpo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(429, 'rate'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createVercelDomainsClient().getDomainStatus('x.com', 'prj', 'tk')).rejects.toMatchObject({
      status: 429,
      body: 'rate',
      message: 'Vercel API GET https://api.vercel.com/v9/projects/prj/domains/x.com/config failed with 429',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('falha de rede propaga o erro original (mesma mensagem), sem retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const err = (await createVercelDomainsClient()
      .addDomainToProject('x.com', 'prj', 'tk')
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Authorization Bearer e Content-Type JSON em toda chamada', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ verified: true }), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    await createVercelDomainsClient().addDomainToProject('x.com', 'prj', 'tk');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tk', 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ name: 'x.com' }));
  });
});
