// Testes puros do threading (funções sem I/O). Testes que exigem o
// Database do drizzle vivem em apps/api/src/__tests__/inbox.routes.test.ts
// e apps/worker/src/__tests__/analyze-inbound.processor.test.ts.

import { describe, expect, it } from 'vitest';

import {
  extractMessageIds,
  extractThreadCandidates,
  normalizeSubjectForMatch,
} from '../inbound/threading.js';

describe('extractMessageIds', () => {
  it('extrai um único Message-ID do formato RFC 5322', () => {
    const result = extractMessageIds('<abc@example.com>');
    expect(result).toEqual(['<abc@example.com>']);
  });

  it('extrai múltiplos IDs separados por espaço', () => {
    const result = extractMessageIds('<a@x.com> <b@y.com>');
    expect(result).toEqual(['<a@x.com>', '<b@y.com>']);
  });

  it('extrai IDs em References com CRLF e vírgulas', () => {
    const result = extractMessageIds('<a@x.com>,\r\n <b@y.com>\t<c@z.com>');
    expect(result).toEqual(['<a@x.com>', '<b@y.com>', '<c@z.com>']);
  });

  it('retorna vazio quando não há match', () => {
    expect(extractMessageIds('nothing here')).toEqual([]);
  });
});

describe('extractThreadCandidates', () => {
  it('In-Reply-To primeiro, depois References (mais recente primeiro)', () => {
    const result = extractThreadCandidates({
      inReplyTo: '<reply@x.com>',
      references: '<oldest@x.com> <middle@x.com> <newest@x.com>',
    });
    // Ordem: In-Reply-To, depois References invertido (newest → oldest).
    expect(result).toEqual([
      '<reply@x.com>',
      '<newest@x.com>',
      '<middle@x.com>',
      '<oldest@x.com>',
    ]);
  });

  it('remove duplicatas', () => {
    const result = extractThreadCandidates({
      inReplyTo: '<a@x.com>',
      references: '<a@x.com> <b@x.com>',
    });
    expect(result).toEqual(['<a@x.com>', '<b@x.com>']);
  });

  it('lida com só In-Reply-To', () => {
    const result = extractThreadCandidates({ inReplyTo: '<only@x.com>' });
    expect(result).toEqual(['<only@x.com>']);
  });

  it('lida com só References', () => {
    const result = extractThreadCandidates({ references: '<a@x.com> <b@x.com>' });
    // References é invertido: newest primeiro.
    expect(result).toEqual(['<b@x.com>', '<a@x.com>']);
  });

  it('lida com ambos ausentes', () => {
    expect(extractThreadCandidates({})).toEqual([]);
  });
});

describe('normalizeSubjectForMatch', () => {
  it('remove Re:', () => {
    expect(normalizeSubjectForMatch('Re: hello')).toBe('hello');
  });

  it('remove Fwd:', () => {
    expect(normalizeSubjectForMatch('Fwd: order status')).toBe('order status');
  });

  it('remove Fw: (variação)', () => {
    expect(normalizeSubjectForMatch('Fw: refund')).toBe('refund');
  });

  it('lida com case insensitive', () => {
    expect(normalizeSubjectForMatch('RE: LOUD')).toBe('loud');
  });

  it('colapsa whitespace múltiplo', () => {
    expect(normalizeSubjectForMatch('  Re:   my    ticket  ')).toBe('my ticket');
  });

  it('retorna vazio para null/undefined', () => {
    expect(normalizeSubjectForMatch(null)).toBe('');
    expect(normalizeSubjectForMatch(undefined)).toBe('');
  });
});
