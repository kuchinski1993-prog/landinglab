import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchPolicyPage,
  fetchPublishedPolicies,
  normalizeHost,
  normalizeLookupInput,
  requestContext,
  validLandingPageId,
} from '../post-sale-api';

const LP = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ctx = { host: 'shop.example.it', clientIp: '203.0.113.7', userAgent: 'UA' };

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function call(fn: { mock: { calls: unknown[][] } }) {
  const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
  return { url: new URL(url), headers: init.headers as Record<string, string>, init };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeHost / requestContext', () => {
  it('remove porta e www, minúsculas (mesma regra do middleware)', () => {
    expect(normalizeHost('WWW.Shop.Example.it:3011')).toBe('shop.example.it');
    expect(normalizeHost(null)).toBe('');
  });

  it('prefere x-forwarded-host e pega o primeiro IP do x-forwarded-for', () => {
    const h = new Headers({
      host: 'internal:3011',
      'x-forwarded-host': 'www.loja.it',
      'x-forwarded-for': '198.51.100.1, 10.0.0.1',
      'user-agent': 'Mozilla',
    });
    expect(requestContext(h)).toEqual({ host: 'loja.it', clientIp: '198.51.100.1', userAgent: 'Mozilla' });
  });

  it('landingPageId só aceita uuid', () => {
    expect(validLandingPageId(LP)).toBe(LP);
    expect(validLandingPageId('x')).toBeUndefined();
    expect(validLandingPageId(['a'])).toBeUndefined();
  });
});

describe('normalizeLookupInput', () => {
  it('trima e remove # do número do pedido', () => {
    expect(normalizeLookupInput({ orderNumber: '  #LL-1001 ', email: ' A@B.it ' })).toEqual({
      orderNumber: 'LL-1001',
      email: 'A@B.it',
    });
  });

  it.each([
    null,
    'x',
    {},
    { orderNumber: 'LL-1', email: '' },
    { orderNumber: '', email: 'a@b.it' },
    { orderNumber: 'X'.repeat(41), email: 'a@b.it' },
    { orderNumber: 'LL-1', email: `${'a'.repeat(250)}@b.it` },
    { orderNumber: 1001, email: 'a@b.it' },
  ])('entrada inválida → null (%#)', (body) => {
    expect(normalizeLookupInput(body)).toBeNull();
  });
});

describe('fetchPublishedPolicies', () => {
  it('chama /landing-policies com host + landingPageId e repassa o IP do cliente', async () => {
    const fn = mockFetch(200, {
      locale: 'it',
      policies: [
        { slug: 'refund-policy', title: 'Politica di rimborso' },
        { slug: 'evil', title: 'x' },
        { slug: 'privacy-policy', title: '' },
      ],
    });
    const result = await fetchPublishedPolicies(ctx, LP);
    expect(result).toEqual({ locale: 'it', policies: [{ slug: 'refund-policy', title: 'Politica di rimborso' }] });
    const { url, headers } = call(fn);
    expect(url.pathname).toBe('/landing-policies');
    expect(url.searchParams.get('host')).toBe('shop.example.it');
    expect(url.searchParams.get('landingPageId')).toBe(LP);
    expect(headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('landingPageId inválido não é enviado', async () => {
    const fn = mockFetch(200, { locale: null, policies: [] });
    await fetchPublishedPolicies(ctx, 'not-a-uuid');
    expect(call(fn).url.searchParams.has('landingPageId')).toBe(false);
  });

  it('falha da API ou rede → lista vazia (rodapé omitido)', async () => {
    mockFetch(500, {});
    expect(await fetchPublishedPolicies(ctx)).toEqual({ locale: null, policies: [] });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    expect(await fetchPublishedPolicies(ctx)).toEqual({ locale: null, policies: [] });
  });

  it('sem host não chama a API', async () => {
    const fn = mockFetch(200, {});
    expect(await fetchPublishedPolicies({ ...ctx, host: '' })).toEqual({ locale: null, policies: [] });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('fetchPolicyPage', () => {
  it('política publicada → HTML (sanitizado de novo por defesa em profundidade)', async () => {
    const fn = mockFetch(200, {
      slug: 'shipping-policy',
      title: 'Politica di spedizione',
      locale: 'it',
      html: '<p>Ok</p><script>alert(1)</script><a href="javascript:x()">y</a>',
    });
    const page = await fetchPolicyPage('shipping-policy', ctx, LP);
    expect(page?.title).toBe('Politica di spedizione');
    expect(page?.html).toContain('<p>Ok</p>');
    expect(page?.html).not.toContain('<script');
    expect(page?.html).not.toContain('javascript:');
    const { url } = call(fn);
    expect(url.pathname).toBe('/landing-policies/shipping-policy');
    expect(url.searchParams.get('landingPageId')).toBe(LP);
  });

  it('draft/inexistente (404 da API) → null', async () => {
    mockFetch(404, { code: 'not_found' });
    expect(await fetchPolicyPage('refund-policy', ctx)).toBeNull();
  });

  it('slug desconhecido → null sem chamar a API', async () => {
    const fn = mockFetch(200, {});
    expect(await fetchPolicyPage('reembolso', ctx)).toBeNull();
    expect(await fetchPolicyPage('../admin', ctx)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
