// Story 17.6c · AC3/AC10 — resolveAtendimentoConfig, completude, merge parcial e modos de falha.
import { describe, expect, it } from 'vitest';

import {
  atendimentoSendFields,
  buildAtendimentoPromptContext,
  mergeAtendimentoPatch,
  parseAtendimentoSettings,
  resolveAtendimentoConfig,
} from '../atendimento/config.js';

// Constantes extraídas do código antigo (analyze-inbound.processor.ts:724-728 e
// inbound-response-guard.ts DEFAULT_ALLOWED_HOSTS) — o padrão da `default` tem de ser idêntico.
const OLD_LITERALS = {
  name: 'AuthenLondon',
  supportEmail: 'support@authenlondon.com',
  postalAddress: '35 Weir Rd, London SW12 0NU, United Kingdom',
  hosts: ['authenlondon.com', 'blackshop-storefront.vercel.app'],
};

const FULL_PT = {
  language: 'pt-BR',
  tone: 'friendly',
  brand: { name: 'Loja Bela', supportEmail: 'contato@lojabela.com.br', postalAddress: 'Rua A, 10, São Paulo' },
  sender: { fromName: 'Loja Bela', fromAddress: 'contato@lojabela.com.br', replyTo: 'atendimento@lojabela.com.br' },
  signature: 'Equipe Loja Bela',
  refundPolicy: { facts: { return_window: '7 dias corridos.' } },
  allowedLinkHosts: ['lojabela.com.br'],
};

describe('resolveAtendimentoConfig · default', () => {
  it('sem config → literais de hoje (igualdade profunda), caminho literal, sem remetente', () => {
    for (const settings of [{}, null, undefined, { policies: { x: 1 } }, { atendimento: null }]) {
      const eff = resolveAtendimentoConfig('default', settings);
      expect(eff).toEqual({
        storeId: 'default',
        isDefault: true,
        configured: true,
        missing: [],
        invalid: false,
        usesDefaultLiterals: true,
        language: 'en-GB',
        tone: 'default',
        toneNotes: null,
        brand: { name: OLD_LITERALS.name, supportEmail: OLD_LITERALS.supportEmail, postalAddress: OLD_LITERALS.postalAddress },
        sender: null,
        signature: null,
        refundPolicyFacts: {},
        allowedLinkHosts: OLD_LITERALS.hosts,
      });
      expect(buildAtendimentoPromptContext(eff)).toBeUndefined();
      expect(atendimentoSendFields(eff)).toEqual({});
    }
  });

  it('config parcial → campo a campo (o resto continua literal)', () => {
    const eff = resolveAtendimentoConfig('default', { atendimento: { signature: 'The AuthenLondon care team' } });
    expect(eff.usesDefaultLiterals).toBe(false);
    expect(eff.brand.name).toBe('AuthenLondon');
    expect(eff.language).toBe('en-GB');
    expect(eff.signature).toBe('The AuthenLondon care team');
    expect(buildAtendimentoPromptContext(eff)).toMatchObject({ brandName: 'AuthenLondon', market: 'UK', inheritDefaultPolicy: true });
  });

  it('config corrompida ou idioma desconhecido → padrão (invalid sinalizado, nunca exceção)', () => {
    for (const atendimento of ['texto', 42, [], { language: 'es-ES' }, { brand: 'x' }]) {
      const eff = resolveAtendimentoConfig('default', { atendimento });
      expect(eff.invalid).toBe(true);
      expect(eff.usesDefaultLiterals).toBe(true);
      expect(eff.language).toBe('en-GB');
    }
  });
});

describe('resolveAtendimentoConfig · outra loja', () => {
  it('sem config → não configurado com a lista de faltantes; nada herda a AuthenLondon', () => {
    const eff = resolveAtendimentoConfig('loja-b', {});
    expect(eff.configured).toBe(false);
    expect(eff.missing).toEqual(['language', 'brand.name', 'brand.supportEmail', 'brand.postalAddress', 'sender.fromAddress']);
    expect(JSON.stringify(eff)).not.toMatch(/AuthenLondon|authenlondon|Weir/);
    expect(atendimentoSendFields(eff)).toEqual({});
  });

  it('leitura falhou (settings null) → não configurado', () => {
    expect(resolveAtendimentoConfig('loja-b', null).configured).toBe(false);
  });

  it('completa → configurada; remetente "Nome <endereço>" + replyTo; contexto pt-BR sem herança', () => {
    const eff = resolveAtendimentoConfig('loja-b', { atendimento: FULL_PT });
    expect(eff.configured).toBe(true);
    expect(eff.missing).toEqual([]);
    expect(atendimentoSendFields(eff)).toEqual({ from: 'Loja Bela <contato@lojabela.com.br>', replyTo: 'atendimento@lojabela.com.br' });
    expect(buildAtendimentoPromptContext(eff)).toEqual({
      brandName: 'Loja Bela',
      market: 'Brazil',
      language: 'pt-BR',
      tone: 'friendly',
      toneNotes: null,
      signature: 'Equipe Loja Bela',
      policyFacts: { return_window: '7 dias corridos.' },
      inheritDefaultPolicy: false,
    });
  });

  it('postalAddress cai em settings.contactAddress', () => {
    const { brand, ...rest } = FULL_PT;
    const eff = resolveAtendimentoConfig('loja-b', {
      contactAddress: 'Av. B, 20',
      atendimento: { ...rest, brand: { name: brand.name, supportEmail: brand.supportEmail } },
    });
    expect(eff.brand.postalAddress).toBe('Av. B, 20');
    expect(eff.configured).toBe(true);
  });

  it('hosts: domínio da loja quando não configurado; authenlondon.com nunca entra', () => {
    expect(resolveAtendimentoConfig('loja-b', {}, { storeDomain: 'https://LojaBela.com.br/' }).allowedLinkHosts).toEqual(['lojabela.com.br']);
    expect(
      resolveAtendimentoConfig('loja-b', { atendimento: { allowedLinkHosts: ['authenlondon.com', 'x.authenlondon.com', 'ok.com'] } })
        .allowedLinkHosts,
    ).toEqual(['ok.com']);
  });

  it('config corrompida ou idioma desconhecido → não configurado (nunca exceção)', () => {
    for (const atendimento of ['texto', { ...FULL_PT, language: 'es-ES' }, { ...FULL_PT, extra: true }]) {
      const eff = resolveAtendimentoConfig('loja-b', { atendimento });
      expect(eff.invalid).toBe(true);
      expect(eff.configured).toBe(false);
    }
  });
});

describe('validação (Zod)', () => {
  const invalid: Array<[string, unknown]> = [
    ['idioma fora de en-GB|pt-BR', { language: 'fr-FR' }],
    ['e-mail inválido', { brand: { supportEmail: 'não-é-email' } }],
    ['toneNotes acima de 400', { toneNotes: 'a'.repeat(401) }],
    ['assinatura acima de 300', { signature: 'a'.repeat(301) }],
    ['host com esquema', { allowedLinkHosts: ['https://lojabela.com.br'] }],
    ['host com caminho', { allowedLinkHosts: ['lojabela.com.br/trocas'] }],
    ['fato de política desconhecido', { refundPolicy: { facts: { inventado: 'x' } } }],
    ['nome do remetente com <>', { sender: { fromName: 'A <b>', fromAddress: 'a@b.com' } }],
  ];
  for (const [name, atendimento] of invalid) {
    it(`rejeita: ${name}`, () => {
      expect(parseAtendimentoSettings({ atendimento }).invalid).toBe(true);
    });
  }
});

describe('mergeAtendimentoPatch', () => {
  it('merge parcial campo a campo; null remove', () => {
    const r1 = mergeAtendimentoPatch({}, { language: 'pt-BR', brand: { name: 'Loja Bela' } });
    expect(r1).toEqual({ ok: true, config: { language: 'pt-BR', brand: { name: 'Loja Bela' } } });
    if (!r1.ok) throw new Error('unreachable');
    const r2 = mergeAtendimentoPatch(r1.config, {
      brand: { supportEmail: 'Contato@LojaBela.com.br' },
      refundPolicy: { facts: { return_window: '7 dias.' } },
    });
    expect(r2).toEqual({
      ok: true,
      config: {
        language: 'pt-BR',
        brand: { name: 'Loja Bela', supportEmail: 'contato@lojabela.com.br' },
        refundPolicy: { facts: { return_window: '7 dias.' } },
      },
    });
    if (!r2.ok) throw new Error('unreachable');
    const r3 = mergeAtendimentoPatch(r2.config, { language: null, brand: { name: null }, refundPolicy: { facts: { return_window: null } } });
    expect(r3).toEqual({ ok: true, config: { brand: { supportEmail: 'contato@lojabela.com.br' }, refundPolicy: { facts: {} } } });
  });

  it('erro aponta o campo', () => {
    expect(mergeAtendimentoPatch({}, { language: 'xx' })).toMatchObject({ ok: false, field: 'language' });
    expect(mergeAtendimentoPatch({}, { brand: { supportEmail: 'x' } })).toMatchObject({ ok: false, field: 'brand.supportEmail' });
    expect(mergeAtendimentoPatch({}, { foo: 1 })).toMatchObject({ ok: false, field: 'foo', reason: 'unexpected_field' });
    expect(mergeAtendimentoPatch({}, 'x')).toMatchObject({ ok: false, field: '(body)' });
    expect(mergeAtendimentoPatch({}, { brand: 'x' })).toMatchObject({ ok: false, field: 'brand' });
  });
});
