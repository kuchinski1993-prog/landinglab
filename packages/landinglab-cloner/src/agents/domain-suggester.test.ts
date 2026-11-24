import { describe, expect, it } from 'vitest';

import { extractCoreName, slugifyForDomain, suggestDomains } from './domain-suggester.js';

describe('slugifyForDomain', () => {
  it('normaliza texto padrão em kebab-case ASCII', () => {
    expect(slugifyForDomain('Vigoraxi Cayenne')).toBe('vigoraxi-cayenne');
  });

  it('remove acentos (NFD)', () => {
    expect(slugifyForDomain('Ação Rápida')).toBe('acao-rapida');
  });

  it('remove caracteres especiais mantendo hífens', () => {
    expect(slugifyForDomain('Vigor & Axi — Cayenne!')).toBe('vigor-axi-cayenne');
  });

  it('remove stop words comuns', () => {
    expect(slugifyForDomain('The Best Product for Men')).toBe('best-product-men');
  });

  it('limita a 3 palavras (skip stop words)', () => {
    const out = slugifyForDomain('Peperoncino di Cayenna Softgel Premium Advanced');
    // "peperoncino", "cayenna", "softgel" (di é stop word)
    expect(out?.split('-').length).toBeLessThanOrEqual(3);
  });

  it('trunca em maxLen preservando estrutura', () => {
    const out = slugifyForDomain('Um Nome Muito Muito Muito Longo Aqui Para Teste', 15);
    expect(out?.length).toBeLessThanOrEqual(15);
    expect(out).not.toMatch(/-$/); // sem hífen no fim
  });

  it('retorna null pra string vazia ou só símbolos', () => {
    expect(slugifyForDomain('')).toBeNull();
    expect(slugifyForDomain('!!!')).toBeNull();
    expect(slugifyForDomain('   ')).toBeNull();
  });
});

describe('extractCoreName', () => {
  it('pega primeira palavra significativa como núcleo', () => {
    expect(extractCoreName('Vigoraxi Peperoncino di Cayenna Softgel')).toBe('vigoraxi');
  });

  it('fallback para slug completo se primeira palavra for muito curta', () => {
    // "Ax" tem só 2 chars, deve fallback pro slug inteiro
    const out = extractCoreName('Ax Premium');
    expect(out).toBe('ax-premium');
  });

  it('retorna null pra input inválido', () => {
    expect(extractCoreName('')).toBeNull();
  });
});

describe('suggestDomains', () => {
  it('gera sugestões básicas em .com/.store/.shop', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(6);
    // Primeira deve ser o nome direto em .com (mais legível)
    expect(suggestions[0]!.domain).toBe('vigoraxi-cayenne.com');
    // Deve incluir .store e .shop
    expect(suggestions.some((s) => s.tld === '.store')).toBe(true);
  });

  it('respeita limit', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne', { limit: 3 });
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('respeita TLDs customizados', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne', { tlds: ['.io'] });
    expect(suggestions.every((s) => s.tld === '.io')).toBe(true);
  });

  it('gera sugestões com sufixos comerciais (-store, -oficial)', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne', { limit: 10 });
    expect(suggestions.some((s) => s.domain.includes('-store'))).toBe(true);
  });

  it('tem preço estimado por TLD', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne');
    const com = suggestions.find((s) => s.tld === '.com');
    expect(com?.estimatedPriceUsd).toBeGreaterThan(0);
  });

  it('retorna array vazio pra produto inválido', () => {
    expect(suggestDomains('')).toEqual([]);
    expect(suggestDomains('!!!')).toEqual([]);
  });

  it('deduplica sugestões (nunca retorna mesmo domain 2x)', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne', { limit: 20 });
    const domains = suggestions.map((s) => s.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it('respeita limites DNS (3-63 chars por label)', () => {
    const suggestions = suggestDomains('Vigoraxi Cayenne');
    for (const s of suggestions) {
      const label = s.domain.split('.')[0]!;
      expect(label.length).toBeGreaterThanOrEqual(3);
      expect(label.length).toBeLessThanOrEqual(63);
    }
  });
});
