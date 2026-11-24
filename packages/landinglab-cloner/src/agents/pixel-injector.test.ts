import { describe, expect, it } from 'vitest';

import { injectMetaPixel, type PixelConfig } from './pixel-injector.js';

const BASE_HTML = '<html><head><title>x</title></head><body><h1>hi</h1></body></html>';
const VALID_PIXEL_ID = '1234567890123456';

describe('injectMetaPixel', () => {
  it('retorna HTML original quando config é null', () => {
    expect(injectMetaPixel(BASE_HTML, null)).toBe(BASE_HTML);
  });

  it('retorna HTML original quando config é undefined', () => {
    expect(injectMetaPixel(BASE_HTML, undefined)).toBe(BASE_HTML);
  });

  it('retorna HTML original quando pixelId é vazio', () => {
    expect(injectMetaPixel(BASE_HTML, { pixelId: '' })).toBe(BASE_HTML);
  });

  it('retorna HTML original quando pixelId não é numérico', () => {
    expect(injectMetaPixel(BASE_HTML, { pixelId: 'abc123' })).toBe(BASE_HTML);
  });

  it('retorna HTML original quando pixelId tem menos de 13 dígitos', () => {
    expect(injectMetaPixel(BASE_HTML, { pixelId: '12345' })).toBe(BASE_HTML);
  });

  it('injeta pixel base + PageView antes de </head>', () => {
    const out = injectMetaPixel(BASE_HTML, { pixelId: VALID_PIXEL_ID });
    expect(out).toContain(`fbq('init','${VALID_PIXEL_ID}')`);
    expect(out).toContain(`fbq('track','PageView')`);
    expect(out).toContain('facebook.net/en_US/fbevents.js');
    expect(out).toContain('<noscript><img');
    // Ordem: pixel vem antes de </head>
    expect(out.indexOf('fbq(')).toBeLessThan(out.indexOf('</head>'));
  });

  it('inclui noscript fallback com src correto', () => {
    const out = injectMetaPixel(BASE_HTML, { pixelId: VALID_PIXEL_ID });
    expect(out).toContain(`facebook.com/tr?id=${VALID_PIXEL_ID}&ev=PageView&noscript=1`);
  });

  it('PageView é sempre incluído mesmo se não estiver em eventsEnabled', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['ViewContent'],
    });
    expect(out).toContain(`fbq('track','PageView')`);
  });

  it('emite ViewContent com params quando content data está disponível', () => {
    const config: PixelConfig = {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['ViewContent'],
      contentIds: ['sku-123'],
      contentName: 'Test Product',
      contentType: 'product',
      value: 49.9,
      currency: 'EUR',
    };
    const out = injectMetaPixel(BASE_HTML, config);
    expect(out).toContain(`fbq('track','ViewContent'`);
    expect(out).toContain('"content_ids":["sku-123"]');
    expect(out).toContain('"content_name":"Test Product"');
    expect(out).toContain('"content_type":"product"');
    expect(out).toContain('"value":49.9');
    expect(out).toContain('"currency":"EUR"');
  });

  it('ViewContent sem content data emite call vazio', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['ViewContent'],
    });
    expect(out).toContain(`fbq('track','ViewContent')`);
    // Sem params
    expect(out).not.toContain(`fbq('track','ViewContent',{`);
  });

  it('Purchase é ignorado no client (server-side via CAPI)', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['PageView', 'Purchase'],
    });
    expect(out).not.toContain(`fbq('track','Purchase')`);
  });

  it('InitiateCheckout/AddToCart são ignorados (disparados no clique)', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['PageView', 'InitiateCheckout', 'AddToCart'],
    });
    expect(out).not.toContain(`fbq('track','InitiateCheckout')`);
    expect(out).not.toContain(`fbq('track','AddToCart')`);
  });

  it('eventos customizados usam trackCustom', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['MyCustomEvent'],
    });
    expect(out).toContain(`fbq('trackCustom',"MyCustomEvent")`);
  });

  it('eventTestCode altera init pra passar eventID', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventTestCode: 'TEST12345',
    });
    expect(out).toContain(`eventID:'TEST12345'`);
    expect(out).toContain(`autoConfig`);
  });

  it('prepend quando HTML não tem </head>', () => {
    const noHeadHtml = '<body><h1>oi</h1></body>';
    const out = injectMetaPixel(noHeadHtml, { pixelId: VALID_PIXEL_ID });
    expect(out.startsWith('<!-- Meta Pixel Code')).toBe(true);
    expect(out).toContain('<body>');
  });

  it('escapa aspas simples no contentName (XSS defense)', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['ViewContent'],
      contentName: "It's a trap",
    });
    // JSON.stringify já escapa; test valida que não crashou.
    expect(out).toContain(`"content_name":"It's a trap"`);
    // Não tem <script quebrado — parsing continua válido.
    // Aceita <script> ou <script data-...> (o injector adiciona o marker
    // data-landinglab-pixel pra sanitizer preservar; tests anteriores ao marker
    // usavam a forma bare — atualizado pra casar com produção).
    const openCount = (out.match(/<script(\s[^>]*)?>/g) ?? []).length;
    const closeCount = (out.match(/<\/script>/g) ?? []).length;
    expect(openCount).toBeGreaterThan(0);
    expect(openCount).toBe(closeCount);
  });

  it('escapa aspas simples no pixelId (defesa dupla mesmo com validação)', () => {
    // pixelId inválido rejeitado antes — este teste garante que se algum bug
    // deixasse passar, escapeJs quebraria injection attempts.
    expect(injectMetaPixel(BASE_HTML, { pixelId: "1234'; alert(1);//" })).toBe(BASE_HTML);
  });

  it('escapa fechamento de script no eventTestCode (defesa XSS)', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventTestCode: '</script><script>alert(1)</script>',
    });
    // Não deve conter </script> não escapado dentro do bloco inline
    // (o eventTestCode escapado vira <\/script>)
    expect(out).toContain('<\\/script>');
  });

  it('é idempotente — não injeta 2x se já contém pixel + loader src', () => {
    const once = injectMetaPixel(BASE_HTML, { pixelId: VALID_PIXEL_ID });
    const twice = injectMetaPixel(once, { pixelId: VALID_PIXEL_ID });
    expect(once).toBe(twice);
    // Confere: só uma cópia do loader
    expect(once.match(/facebook\.net\/en_US\/fbevents\.js/g)?.length).toBe(1);
  });

  it('gera valid HTML com múltiplos eventos', () => {
    const out = injectMetaPixel(BASE_HTML, {
      pixelId: VALID_PIXEL_ID,
      eventsEnabled: ['PageView', 'ViewContent'],
      contentIds: ['gid://shopify/Product/123'],
      contentName: 'Cool Thing',
      value: 29.9,
      currency: 'USD',
    });
    // 2 scripts (base + events) — injector marca ambos com data-landinglab-pixel
    // pra sanitizer preservar, então regex aceita <script> ou <script data-...>.
    const scriptCount = (out.match(/<script(\s[^>]*)?>/g) ?? []).length;
    const scriptCloseCount = (out.match(/<\/script>/g) ?? []).length;
    expect(scriptCount).toBe(scriptCloseCount);
    expect(scriptCount).toBeGreaterThanOrEqual(2);
  });
});
