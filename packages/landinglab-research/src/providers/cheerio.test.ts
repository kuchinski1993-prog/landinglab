import { describe, expect, it, vi } from 'vitest';

import { createCheerioClient } from './cheerio.js';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeFetch(html: string, opts?: { status?: number; contentType?: string }): typeof fetch {
  const status = opts?.status ?? 200;
  const contentType = opts?.contentType ?? 'text/html; charset=utf-8';
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => html,
  }) as unknown as typeof fetch;
}

// Padding pra passar o filtro MIN_HTML_BYTES (500).
const PAD = `<!-- ${'x'.repeat(600)} -->`;

// ─────────────────────────────────────────────────────────────────────────
// Cases
// ─────────────────────────────────────────────────────────────────────────

describe('createCheerioClient — extractFromUrl', () => {
  it('extracts Product JSON-LD from Shopify-like HTML', async () => {
    const html = `
      <html><head>
        <title>Loja</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Cuban Shirt Wrinkle Textured",
          "image": ["https://cdn.shop/1.jpg", "https://cdn.shop/2.jpg"],
          "description": "Camisa jacquard premium",
          "brand": { "@type": "Brand", "name": "Parijan" },
          "sku": "PRJ-001",
          "offers": {
            "@type": "AggregateOffer",
            "price": 89.00,
            "priceCurrency": "EUR"
          },
          "additionalProperty": [
            { "@type": "PropertyValue", "name": "Material", "value": "100% Linen" },
            { "@type": "PropertyValue", "name": "Fit", "value": "Regular" }
          ]
        }
        </script>
      </head><body>${PAD}<h1>Loja</h1></body></html>`;

    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/product', { fetchImpl: makeFetch(html) });

    expect(res.status).toBe('ok');
    expect(res.source).toBe('json-ld');
    expect(res.identity.name).toBe('Cuban Shirt Wrinkle Textured');
    expect(res.identity.brand).toBe('Parijan');
    expect(res.identity.price).toBe(89);
    expect(res.identity.currency).toBe('EUR');
    expect(res.identity.images).toEqual(['https://cdn.shop/1.jpg', 'https://cdn.shop/2.jpg']);
    expect(res.identity.description).toBe('Camisa jacquard premium');
    expect(res.specs['Material']).toBe('100% Linen');
    expect(res.specs['sku']).toBe('PRJ-001');
    expect(res.cost_usd).toBe(0);
  });

  it('falls back to Open Graph when JSON-LD absent', async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Amazing Widget" />
        <meta property="og:image" content="https://cdn.example.com/widget.jpg" />
        <meta property="og:description" content="The best widget for widgeting" />
        <meta property="product:price:amount" content="49.99" />
        <meta property="product:price:currency" content="USD" />
        <meta property="product:brand" content="WidgetCo" />
      </head><body>${PAD}<div>page</div></body></html>`;

    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/widget', { fetchImpl: makeFetch(html) });

    expect(res.status).toBe('ok');
    expect(res.source).toBe('open-graph');
    expect(res.identity.name).toBe('Amazing Widget');
    expect(res.identity.price).toBe(49.99);
    expect(res.identity.currency).toBe('USD');
    expect(res.identity.brand).toBe('WidgetCo');
    expect(res.identity.images).toContain('https://cdn.example.com/widget.jpg');
  });

  it('returns partial with title only when no structured data', async () => {
    const html = `
      <html><head><title>Plain Page</title></head>
      <body>${PAD}<h1>Product Only Has H1</h1><p>Nothing else useful</p></body></html>`;

    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/plain', { fetchImpl: makeFetch(html) });

    expect(res.status).toBe('partial');
    expect(res.source).toBe('html-fallback');
    expect(res.identity.name).toBe('Product Only Has H1');
    expect(res.identity.price).toBeNull();
  });

  it('returns failed on 500 response', async () => {
    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/x', {
      fetchImpl: makeFetch('server error', { status: 500 }),
    });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('http_500');
  });

  it('returns failed on non-html content-type', async () => {
    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/j', {
      fetchImpl: makeFetch('{"x":1}', { contentType: 'application/json' }),
    });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('non_html_content_type');
  });

  it('handles multiple JSON-LD scripts and prioritizes Product', async () => {
    const html = `
      <html><head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Organization",
          "name": "My Store",
          "url": "https://mystore.com"
        }
        </script>
        <script type="application/ld+json">
        [
          { "@type": "BreadcrumbList" },
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Real Product",
            "image": "https://cdn.x/1.jpg",
            "offers": { "@type": "Offer", "price": "19.90", "priceCurrency": "usd" }
          }
        ]
        </script>
      </head><body>${PAD}</body></html>`;

    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/multi', { fetchImpl: makeFetch(html) });

    expect(res.status).toBe('ok');
    expect(res.identity.name).toBe('Real Product');
    expect(res.identity.price).toBe(19.9);
    expect(res.identity.currency).toBe('USD');
    expect(res.identity.images).toContain('https://cdn.x/1.jpg');
  });

  it('merges JSON-LD + OG when JSON-LD lacks description', async () => {
    const html = `
      <html><head>
        <meta property="og:description" content="OG description takes over" />
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Merged Product",
          "offers": { "price": 10, "priceCurrency": "EUR" }
        }
        </script>
      </head><body>${PAD}</body></html>`;

    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/merge', { fetchImpl: makeFetch(html) });

    expect(res.status).toBe('ok');
    expect(res.identity.name).toBe('Merged Product');
    expect(res.identity.description).toBe('OG description takes over');
    expect(res.source).toBe('mixed');
  });

  it('returns failed when HTML too small (redirect page)', async () => {
    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/tiny', {
      fetchImpl: makeFetch('<html></html>'),
    });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('html_too_small');
  });

  it('handles fetch network errors gracefully', async () => {
    const brokenFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = createCheerioClient();
    const res = await client.extractFromUrl('https://example.com/net', {
      fetchImpl: brokenFetch as unknown as typeof fetch,
    });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('fetch_error');
    expect(res.error).toContain('ECONNREFUSED');
  });
});
