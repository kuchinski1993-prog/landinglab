// Tests de extractProductFromHtml.
// Cobre: título por prioridade (schema.org → og:title → h1 → title),
// descrição, variantes (schema.org offers + buttons regex), preços multi-
// locale (¥7,120, €79,90, $79.00), imagens filtradas, warnings por moeda.

import { describe, expect, it } from 'vitest';

import { extractProductFromHtml } from './product-extractor.js';

describe('extractProductFromHtml — título', () => {
  it('prioriza schema.org Product name sobre og:title', () => {
    const html = `<html>
      <head>
        <meta property="og:title" content="OG title">
        <script type="application/ld+json">
          {"@type":"Product","name":"Schema Name"}
        </script>
      </head>
      <body><h1>H1 title</h1></body>
    </html>`;
    const p = extractProductFromHtml(html);
    expect(p.title).toBe('Schema Name');
    expect(p.titleConfidence).toBe('high');
  });

  it('fallback pra og:title quando não tem schema', () => {
    const html = `<html>
      <head><meta property="og:title" content="OG title"></head>
      <body><h1>H1 title</h1></body>
    </html>`;
    const p = extractProductFromHtml(html);
    expect(p.title).toBe('OG title');
    expect(p.titleConfidence).toBe('high');
  });

  it('fallback pra h1 quando não tem meta', () => {
    const html = `<html><body><h1>H1 title</h1></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.title).toBe('H1 title');
    expect(p.titleConfidence).toBe('medium');
  });

  it('retorna missing quando não acha nada', () => {
    const html = `<html><body><p>Só texto</p></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.title).toBe('');
    expect(p.titleConfidence).toBe('missing');
  });

  it('gera handle slugificado do título', () => {
    const html = `<html><body><h1>Vigoraxi Cayenne — 60 caps</h1></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.handle).toBe('vigoraxi-cayenne-60-caps');
  });
});

describe('extractProductFromHtml — variantes', () => {
  it('extrai variantes de schema.org offers', () => {
    const html = `<html>
      <head>
        <script type="application/ld+json">
          {"@type":"Product","name":"X","offers":[
            {"@type":"Offer","name":"60 caps","price":"39.00","priceCurrency":"EUR"},
            {"@type":"Offer","name":"180 caps","price":"79.00","priceCurrency":"EUR"}
          ]}
        </script>
      </head>
      <body></body>
    </html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants.length).toBe(2);
    expect(p.variants[0]!.priceOriginal).toBe(39);
    expect(p.variants[0]!.currency).toBe('EUR');
    expect(p.variantsConfidence).toBe('high');
  });

  it('extrai variantes de buttons com regex multi-idioma (Acquista + JPY)', () => {
    const html = `<html><body>
      <button>Acquista 1 confezione ¥7,120 ¥8,900</button>
      <button>Acquista 3 confezione ¥13,520 ¥44,500</button>
    </body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants.length).toBe(2);
    expect(p.sourceCurrency).toBe('JPY');
    expect(p.variants[0]!.priceOriginal).toBe(7120);
    expect(p.variants[0]!.compareAtOriginal).toBe(8900);
  });

  it('ordena variantes por preço ascendente', () => {
    const html = `<html><body>
      <button>Buy 3 packs €109</button>
      <button>Buy 1 pack €39</button>
      <button>Buy 2 packs €79</button>
    </body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants[0]!.priceOriginal).toBe(39);
    expect(p.variants[1]!.priceOriginal).toBe(79);
    expect(p.variants[2]!.priceOriginal).toBe(109);
  });

  it('deduplica variantes iguais (nome+preço+moeda)', () => {
    const html = `<html><body>
      <button>Buy 1 pack €39</button>
      <button>Buy 1 pack €39</button>
    </body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants.length).toBe(1);
  });
});

describe('extractProductFromHtml — parse de preços multi-locale', () => {
  it('parse JPY sem decimais "¥7,120"', () => {
    const html = `<html><body><button>Buy 1 pack ¥7,120</button></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants[0]!.priceOriginal).toBe(7120);
    expect(p.variants[0]!.currency).toBe('JPY');
  });

  it('parse EUR formato europeu "€79,90"', () => {
    const html = `<html><body><button>Buy 1 pack €79,90</button></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants[0]!.priceOriginal).toBe(79.9);
    expect(p.variants[0]!.currency).toBe('EUR');
  });

  it('parse USD formato americano "$1,234.56"', () => {
    const html = `<html><body><button>Buy 1 pack $1,234.56</button></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants[0]!.priceOriginal).toBe(1234.56);
    expect(p.variants[0]!.currency).toBe('USD');
  });

  it('parse BRL "R$79,90"', () => {
    const html = `<html><body><button>Comprar 1 pack R$79,90</button></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.variants[0]!.priceOriginal).toBe(79.9);
    expect(p.variants[0]!.currency).toBe('BRL');
  });
});

describe('extractProductFromHtml — imagens', () => {
  it('prioriza og:image e depois product-related imgs', () => {
    const html = `<html>
      <head><meta property="og:image" content="https://cdn.com/hero.jpg"></head>
      <body>
        <img src="https://cdn.com/product-1.jpg">
        <img src="https://cdn.com/product-2.jpg">
      </body>
    </html>`;
    const p = extractProductFromHtml(html);
    expect(p.imageUrls[0]).toBe('https://cdn.com/hero.jpg');
    expect(p.imageUrls).toContain('https://cdn.com/product-1.jpg');
    expect(p.imagesConfidence).toBe('high');
  });

  it('filtra logos, ícones, badges, favicons e pagamento', () => {
    const html = `<html><body>
      <img src="https://cdn.com/logo.png">
      <img src="https://cdn.com/favicon.ico">
      <img src="https://cdn.com/icons/visa.svg">
      <img src="https://cdn.com/guarantee-seal.png">
      <img src="https://cdn.com/product-1.jpg">
      <img src="https://cdn.com/product-2.jpg">
    </body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.imageUrls.length).toBe(2);
    expect(p.imageUrls.every((u) => !u.includes('logo') && !u.includes('favicon'))).toBe(true);
  });

  it('limita em 12 imagens máximo', () => {
    const imgs = Array.from({ length: 20 }, (_, i) => `<img src="https://cdn.com/p-${i}.jpg">`).join('');
    const html = `<html><body>${imgs}</body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.imageUrls.length).toBeLessThanOrEqual(12);
  });

  it('ignora data: URIs', () => {
    const html = `<html><body>
      <img src="data:image/png;base64,iVBORw0KGgo">
      <img src="https://cdn.com/real.jpg">
    </body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.imageUrls.every((u) => !u.startsWith('data:'))).toBe(true);
  });
});

describe('extractProductFromHtml — warnings', () => {
  it('avisa quando não detecta variantes', () => {
    const html = `<html><body><h1>Produto sem variante detectável</h1></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.warnings.some((w) => w.includes('variante'))).toBe(true);
  });

  it('avisa quando moeda é JPY', () => {
    const html = `<html><body><button>Buy 1 pack ¥7,120</button></body></html>`;
    const p = extractProductFromHtml(html);
    expect(p.warnings.some((w) => w.includes('JPY'))).toBe(true);
  });

  it('avisa quando domínio é asiático (.jp)', () => {
    const html = `<html><body><h1>X</h1><button>Buy 1 pack $1</button></body></html>`;
    const p = extractProductFromHtml(html, { sourceUrl: 'https://example.jp/product' });
    expect(p.warnings.some((w) => w.includes('asiático'))).toBe(true);
  });
});
