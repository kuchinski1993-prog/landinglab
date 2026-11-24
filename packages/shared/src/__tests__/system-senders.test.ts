import { describe, expect, it } from 'vitest';

import { isTransactionalSender } from '../inbound/system-senders.js';

describe('isTransactionalSender', () => {
  it('shopify.com direto', () => {
    expect(isTransactionalSender('noreply@shopify.com')).toBe(true);
  });

  it('shopify subdomain (mailer3.shopify.com — o caso real do dono)', () => {
    expect(isTransactionalSender('noreply@mailer3.shopify.com')).toBe(true);
  });

  it('shopifyemail.com', () => {
    expect(isTransactionalSender('info@shopifyemail.com')).toBe(true);
  });

  it('myshopify.com (loja)', () => {
    expect(isTransactionalSender('billing@myshopify.com')).toBe(true);
  });

  it('stripe.com', () => {
    expect(isTransactionalSender('receipts@stripe.com')).toBe(true);
  });

  it('cloudflare.com', () => {
    expect(isTransactionalSender('security@cloudflare.com')).toBe(true);
  });

  it('domínio de cliente real → false', () => {
    expect(isTransactionalSender('customer@gmail.com')).toBe(false);
    expect(isTransactionalSender('user@outlook.com')).toBe(false);
  });

  it('sem @ → false', () => {
    expect(isTransactionalSender('nothing-here')).toBe(false);
    expect(isTransactionalSender('')).toBe(false);
    expect(isTransactionalSender(null)).toBe(false);
    expect(isTransactionalSender(undefined)).toBe(false);
  });

  it('não confunde subdomínio ambíguo (shopify.com.evil.io)', () => {
    // "shopify.com.evil.io" NÃO deve casar (nosso match usa .endsWith('.' + allow))
    expect(isTransactionalSender('a@shopify.com.evil.io')).toBe(false);
  });
});
