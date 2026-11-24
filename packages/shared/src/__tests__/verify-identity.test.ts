// Testes da política DMARC-relaxed de verify-identity + normalize-email.

import { describe, expect, it } from 'vitest';

import { emailsMatch, normalizeEmailForMatch } from '../inbound/normalize-email.js';
import {
  verifyIdentity,
  type VerifyIdentityInput,
} from '../inbound/verify-identity.js';

function vi(partial: Partial<VerifyIdentityInput> = {}): VerifyIdentityInput {
  return {
    fromAddress: 'customer@example.com',
    spfResult: 'pass',
    dkimResult: 'pass',
    ordersMatchingFrom: [],
    claimedOrderId: null,
    claimedOrderCustomerEmail: null,
    ...partial,
  };
}

describe('normalizeEmailForMatch', () => {
  it('lowercase geral', () => {
    expect(normalizeEmailForMatch('JOHN@Example.COM')).toBe('john@example.com');
  });

  it('gmail: remove +tag do local-part', () => {
    expect(normalizeEmailForMatch('john+shopping@gmail.com')).toBe('john@gmail.com');
  });

  it('gmail: remove pontos do local-part', () => {
    expect(normalizeEmailForMatch('john.doe@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('gmail: dot + plus juntos', () => {
    expect(normalizeEmailForMatch('john.doe+tag@gmail.com')).toBe('johndoe@gmail.com');
  });

  it('googlemail vira gmail', () => {
    expect(normalizeEmailForMatch('john@googlemail.com')).toBe('john@gmail.com');
  });

  it('NÃO aplica dot-strip em outlook/yahoo/domínio corporativo', () => {
    // Outlook trata dot como significativo — não pode juntar contas.
    expect(normalizeEmailForMatch('john.doe@outlook.com')).toBe('john.doe@outlook.com');
    expect(normalizeEmailForMatch('john.doe@authenlondon.com')).toBe('john.doe@authenlondon.com');
    expect(normalizeEmailForMatch('john.doe@yahoo.com')).toBe('john.doe@yahoo.com');
  });

  it('emailsMatch: gmail equivalências batem', () => {
    expect(emailsMatch('kuchinski1993@gmail.com', 'kuchinski.1993@gmail.com')).toBe(true);
    expect(emailsMatch('john+a@gmail.com', 'john+b@gmail.com')).toBe(true);
    expect(emailsMatch('john@gmail.com', 'john@googlemail.com')).toBe(true);
  });

  it('emailsMatch: outros domínios exigem literal', () => {
    expect(emailsMatch('a.b@outlook.com', 'ab@outlook.com')).toBe(false);
    expect(emailsMatch('a@x.com', 'b@x.com')).toBe(false);
  });

  it('null/undefined/vazio retorna vazio (não bate com nada)', () => {
    expect(normalizeEmailForMatch(null)).toBe('');
    expect(normalizeEmailForMatch(undefined)).toBe('');
    expect(normalizeEmailForMatch('')).toBe('');
    expect(emailsMatch(null, 'a@x.com')).toBe(false);
    expect(emailsMatch('', '')).toBe(false);
  });
});

describe('verifyIdentity — DMARC-relaxed', () => {
  it('CASO REAL do dono: DKIM=pass, SPF=none, email bate → verified_match', () => {
    const r = verifyIdentity(
      vi({
        fromAddress: 'kuchinski1993@gmail.com',
        spfResult: 'none',
        dkimResult: 'pass',
        ordersMatchingFrom: [
          { id: 'order-1002', customerEmail: 'kuchinski1993@gmail.com' },
        ],
      }),
    );
    expect(r.state).toBe('verified_match');
    expect(r.associatedOrderId).toBe('order-1002');
    expect(r.reason).toBe('match');
  });

  it('SPF=pass + DKIM=none → verified_match (basta um)', () => {
    const r = verifyIdentity(
      vi({
        spfResult: 'pass',
        dkimResult: 'none',
        ordersMatchingFrom: [{ id: 'o1', customerEmail: 'customer@example.com' }],
      }),
    );
    expect(r.state).toBe('verified_match');
  });

  it('SPF=fail + DKIM=fail → unknown_sender', () => {
    const r = verifyIdentity(
      vi({
        spfResult: 'fail',
        dkimResult: 'fail',
        ordersMatchingFrom: [{ id: 'o1', customerEmail: 'customer@example.com' }],
      }),
    );
    expect(r.state).toBe('unknown_sender');
    expect(r.reason).toBe('no_auth');
  });

  it('SPF=none + DKIM=none → unknown_sender (sem sinal)', () => {
    const r = verifyIdentity(vi({ spfResult: 'none', dkimResult: 'none' }));
    expect(r.state).toBe('unknown_sender');
    expect(r.reason).toBe('no_auth');
  });

  it('auth OK mas sem pedido → unknown_sender / no_match', () => {
    const r = verifyIdentity(vi({ spfResult: 'pass', dkimResult: 'pass' }));
    expect(r.state).toBe('unknown_sender');
    expect(r.reason).toBe('no_match');
  });

  it('gmail plus/dot normalizado → verified_match', () => {
    // Order gravado como "john.doe@gmail.com", cliente escreve de "johndoe+news@gmail.com"
    const r = verifyIdentity(
      vi({
        fromAddress: 'johndoe+news@gmail.com',
        spfResult: 'pass',
        dkimResult: 'pass',
        ordersMatchingFrom: [{ id: 'o1', customerEmail: 'john.doe@gmail.com' }],
      }),
    );
    expect(r.state).toBe('verified_match');
  });

  it('claimed_order.email != from → suspicious_claim (spoof)', () => {
    const r = verifyIdentity(
      vi({
        fromAddress: 'attacker@evil.com',
        spfResult: 'pass',
        dkimResult: 'pass',
        claimedOrderId: 'o1',
        claimedOrderCustomerEmail: 'victim@example.com',
      }),
    );
    expect(r.state).toBe('suspicious_claim');
    expect(r.associatedOrderId).toBe('o1');
    expect(r.reason).toBe('cross_check_failed');
  });

  it('claimed_order.email == from com auth OK → verified_via_order', () => {
    const r = verifyIdentity(
      vi({
        fromAddress: 'customer@example.com',
        spfResult: 'pass',
        dkimResult: 'pass',
        claimedOrderId: 'o1',
        claimedOrderCustomerEmail: 'customer@example.com',
      }),
    );
    expect(r.state).toBe('verified_via_order');
    expect(r.associatedOrderId).toBe('o1');
  });

  it('claimed_order gmail-normalizado bate → verified_via_order', () => {
    const r = verifyIdentity(
      vi({
        fromAddress: 'john.doe+support@gmail.com',
        spfResult: 'pass',
        dkimResult: 'pass',
        claimedOrderId: 'o1',
        claimedOrderCustomerEmail: 'johndoe@gmail.com',
      }),
    );
    expect(r.state).toBe('verified_via_order');
  });

  it('SPF=none + DKIM=pass + claim válido → verified_via_order', () => {
    // Cenário Gmail forward: SPF quebra, DKIM sobrevive.
    const r = verifyIdentity(
      vi({
        fromAddress: 'customer@gmail.com',
        spfResult: 'none',
        dkimResult: 'pass',
        claimedOrderId: 'o1',
        claimedOrderCustomerEmail: 'customer@gmail.com',
      }),
    );
    expect(r.state).toBe('verified_via_order');
  });

  it('SPF=fail + DKIM=fail + claim válido → unknown com vínculo NÃO (sinal negativo real)', () => {
    // Cenário raro: ambos fail. Regra "no_auth" tem precedência quando não
    // há suspicious. Não vincula orderId (segurança).
    const r = verifyIdentity(
      vi({
        fromAddress: 'customer@example.com',
        spfResult: 'fail',
        dkimResult: 'fail',
        ordersMatchingFrom: [],
      }),
    );
    expect(r.state).toBe('unknown_sender');
    expect(r.reason).toBe('no_auth');
  });
});
