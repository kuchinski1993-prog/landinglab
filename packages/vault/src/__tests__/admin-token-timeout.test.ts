// Story 0.8 · AC7/AC8 — renovação do token Admin com servidor lento e com 5xx.
import { UpstreamTimeoutError } from '@blackshop/shared/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHOPIFY_TOKEN_TIMEOUT_MS, VaultService } from '../vault.js';

const CLIENT_SECRET = 'shpss_SEGREDO_CLIENT_SECRET';

function vaultWith(values: Record<string, string | null>) {
  const vault = new VaultService({} as never, 'x'.repeat(40));
  const stored = { ...values };
  const set = vi.fn(async (key: string, value: string) => {
    stored[key] = value;
  });
  Object.assign(vault, {
    getRaw: vi.fn(async (key: string) => stored[key] ?? null),
    set,
    delete: vi.fn(async () => undefined),
  });
  return { vault, set, stored };
}

const EXPIRED = {
  'shopify.admin_api_token': 'shpat_ANTIGO',
  'shopify.admin_api_token_expires_at': String(Date.now() - 1_000),
  'shopify.client_id': 'cid',
  'shopify.client_secret': CLIENT_SECRET,
  'shopify.store_domain': 'loja.myshopify.com',
};

describe('VaultService.getAdminToken (Story 0.8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SHOPIFY_TOKEN_TIMEOUT_MS'];
  });

  it('prazo padrão de 10 s', () => expect(SHOPIFY_TOKEN_TIMEOUT_MS).toBe(10_000));

  it('servidor lento → UpstreamTimeoutError (uncertain=false), token antigo preservado, sem client_secret', async () => {
    process.env['SHOPIFY_TOKEN_TIMEOUT_MS'] = '40';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const { vault, set, stored } = vaultWith(EXPIRED);
    const t0 = Date.now();
    const err = (await vault.getAdminToken().catch((e: unknown) => e)) as UpstreamTimeoutError;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err).toMatchObject({ code: 'UPSTREAM_TIMEOUT', label: 'shopify-oauth-token', uncertain: false, timeoutMs: 40 });
    expect(err.message).not.toContain(CLIENT_SECRET);
    expect(set).not.toHaveBeenCalled();
    expect(stored['shopify.admin_api_token']).toBe('shpat_ANTIGO');
  });

  it('5xx → erro sem corpo bruto nem segredo; token antigo preservado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`erro interno ${CLIENT_SECRET}`, { status: 503 })),
    );
    const { vault, set } = vaultWith(EXPIRED);
    const err = (await vault.getAdminToken().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('Falha ao renovar token Admin Shopify (HTTP 503)');
    expect(err.message).not.toContain(CLIENT_SECRET);
    expect(set).not.toHaveBeenCalled();
  });

  it('401 com JSON da Shopify → inclui só o campo error (enum), nunca o resto do corpo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_client', error_description: `segredo ${CLIENT_SECRET}` }), {
            status: 401,
          }),
      ),
    );
    const { vault } = vaultWith(EXPIRED);
    const err = (await vault.getAdminToken().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('Falha ao renovar token Admin Shopify (HTTP 401: invalid_client)');
  });

  it('campo error fora do formato esperado é ignorado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: `x ${CLIENT_SECRET}` }), { status: 400 })));
    const { vault } = vaultWith(EXPIRED);
    const err = (await vault.getAdminToken().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('Falha ao renovar token Admin Shopify (HTTP 400)');
  });

  it('servidor rápido → renova e grava o token novo (regressão)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_NOVO', expires_in: 86_400 }), { status: 200 })),
    );
    const { vault, stored } = vaultWith(EXPIRED);
    await expect(vault.getAdminToken()).resolves.toBe('shpat_NOVO');
    expect(stored['shopify.admin_api_token']).toBe('shpat_NOVO');
  });
});
