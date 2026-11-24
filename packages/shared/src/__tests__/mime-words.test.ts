import { describe, expect, it } from 'vitest';

import { decodeMimeWords } from '../inbound/mime-words.js';

describe('decodeMimeWords', () => {
  it('mantém texto comum e nulos', () => {
    expect(decodeMimeWords('Hello there')).toBe('Hello there');
    expect(decodeMimeWords(null)).toBeNull();
    expect(decodeMimeWords(undefined)).toBeNull();
    expect(decodeMimeWords('')).toBe('');
  });

  it('decodifica base64 (B) misturado com texto', () => {
    expect(decodeMimeWords('=?UTF-8?B?Q29uZmlndXJhw6fDtWVz?= de pagamento alteradas')).toBe(
      'Configurações de pagamento alteradas',
    );
  });

  it('decodifica quoted-printable (Q) com underscore como espaço', () => {
    expect(
      decodeMimeWords('=?UTF-8?q?Voc=C3=AA_se_qualifica_para_pagamentos_mais_r=C3=A1pidos?='),
    ).toBe('Você se qualifica para pagamentos mais rápidos');
  });

  it('junta encoded-words adjacentes sem o espaço entre elas', () => {
    expect(
      decodeMimeWords(
        '=?UTF-8?q?As_configura=C3=A7=C3=B5es_foram_alteradas_para_tiraky-zq.mysho?= =?UTF-8?q?pify.com?=',
      ),
    ).toBe('As configurações foram alteradas para tiraky-zq.myshopify.com');
  });

  it('suporta charsets latinos', () => {
    expect(decodeMimeWords('=?ISO-8859-1?Q?Ol=E1?=')).toBe('Olá');
  });

  it('mantém trecho malformado como veio', () => {
    expect(decodeMimeWords('=?UTF-8?X?abc?= ok')).toBe('=?UTF-8?X?abc?= ok');
  });
});
