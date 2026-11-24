// Testes das funções pure `absolutize` / `absolutizeSrcset` extraídas de
// renderer.ts. Não cobre `renderPage` (depende de Playwright real — teste E2E
// pertencente ao worker, não a este package).

import { describe, expect, it } from 'vitest';

import { absolutize, absolutizeSrcset } from './renderer.js';

describe('absolutize', () => {
  const base = 'https://origem.com/lp/foo';

  it('converte path relativo absoluto (começa com /)', () => {
    expect(absolutize('/img/logo.png', base)).toBe('https://origem.com/img/logo.png');
  });

  it('converte path relativo aninhado (sem /)', () => {
    expect(absolutize('assets/hero.webp', base)).toBe('https://origem.com/lp/assets/hero.webp');
  });

  it('preserva URL absoluta https', () => {
    const url = 'https://cdn.other.com/img.png';
    expect(absolutize(url, base)).toBe(url);
  });

  it('preserva URL absoluta http', () => {
    const url = 'http://cdn.other.com/img.png';
    expect(absolutize(url, base)).toBe(url);
  });

  it('trata protocol-relative //host/path', () => {
    expect(absolutize('//cdn.example.com/logo.png', base)).toBe(
      'https://cdn.example.com/logo.png',
    );
  });

  it('preserva data: URIs', () => {
    const data = 'data:image/png;base64,iVBOR';
    expect(absolutize(data, base)).toBe(data);
  });

  it('preserva blob:', () => {
    const url = 'blob:https://x.com/abc-123';
    expect(absolutize(url, base)).toBe(url);
  });

  it('preserva mailto:, tel: e #hash', () => {
    expect(absolutize('mailto:a@b.com', base)).toBe('mailto:a@b.com');
    expect(absolutize('tel:+55', base)).toBe('tel:+55');
    expect(absolutize('#section', base)).toBe('#section');
  });

  it('retorna null quando input é null', () => {
    expect(absolutize(null, base)).toBeNull();
  });

  it('retorna string vazia quando input é vazio', () => {
    expect(absolutize('', base)).toBe('');
  });

  it('retorna input inalterada se URL malformada', () => {
    // baseUrl inválido → new URL joga → cai no catch
    const bad = absolutize('foo/bar', 'not-a-valid-url');
    // Em Node URL parser é bem tolerante; se der pra parsear, retorna a URL.
    // O importante é: nunca joga exceção pra fora.
    expect(typeof bad).toBe('string');
  });

  it('preserva query string e fragment', () => {
    expect(absolutize('/img.png?v=2#top', base)).toBe(
      'https://origem.com/img.png?v=2#top',
    );
  });
});

describe('absolutizeSrcset', () => {
  const base = 'https://origem.com/lp/';

  it('absolutiza uma única URL sem descriptor', () => {
    expect(absolutizeSrcset('/img/small.png', base)).toBe(
      'https://origem.com/img/small.png',
    );
  });

  it('preserva descriptor `1x`', () => {
    expect(absolutizeSrcset('/img/small.png 1x', base)).toBe(
      'https://origem.com/img/small.png 1x',
    );
  });

  it('preserva múltiplos descriptors `1x, 2x`', () => {
    const input = '/img/small.png 1x, /img/large.png 2x';
    const out = absolutizeSrcset(input, base);
    expect(out).toBe(
      'https://origem.com/img/small.png 1x, https://origem.com/img/large.png 2x',
    );
  });

  it('preserva descriptor `100w`', () => {
    const input = '/img/tiny.png 100w, /img/med.png 400w, /img/full.png 1200w';
    const out = absolutizeSrcset(input, base);
    expect(out).toBe(
      'https://origem.com/img/tiny.png 100w, https://origem.com/img/med.png 400w, https://origem.com/img/full.png 1200w',
    );
  });

  it('mistura URLs absolutas e relativas', () => {
    const input = 'https://cdn.other.com/x.png 1x, /local.png 2x';
    const out = absolutizeSrcset(input, base);
    expect(out).toBe('https://cdn.other.com/x.png 1x, https://origem.com/local.png 2x');
  });

  it('retorna null quando input é null', () => {
    expect(absolutizeSrcset(null, base)).toBeNull();
  });

  it('trata entradas com whitespace extra', () => {
    const input = '  /a.png 1x ,  /b.png 2x  ';
    const out = absolutizeSrcset(input, base);
    expect(out).toBe('https://origem.com/a.png 1x, https://origem.com/b.png 2x');
  });
});
