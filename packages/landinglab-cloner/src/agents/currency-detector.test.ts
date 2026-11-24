import { describe, expect, it } from 'vitest';

import { detectSourceCurrency } from './currency-detector.js';

describe('detectSourceCurrency', () => {
  it('lê a moeda ativa da sessão Shopify', () => {
    const html = `<script>Shopify.currency = {"active":"EUR","rate":"1.0"};</script>
      <script type="application/ld+json">{"offers":{"priceCurrency":"USD"}}</script>`;
    expect(detectSourceCurrency(html)).toBe('EUR');
  });

  it('aceita a forma com atribuição direta e aspas simples', () => {
    expect(detectSourceCurrency(`<script>Shopify.currency.active = 'jpy';</script>`)).toBe('JPY');
  });

  it('lê marketCurrencyCode cru e HTML-escaped', () => {
    expect(detectSourceCurrency(`{"moneyFormat":"€{{amount}}","marketCurrencyCode":"EUR"}`)).toBe('EUR');
    expect(detectSourceCurrency(`data-x="{&quot;marketCurrencyCode&quot;:&quot;GBP&quot;}"`)).toBe('GBP');
  });

  it('lê og:price:currency em qualquer ordem de atributos', () => {
    expect(detectSourceCurrency(`<meta property="og:price:currency" content="CHF">`)).toBe('CHF');
    expect(detectSourceCurrency(`<meta content="SEK" property="product:price:currency">`)).toBe('SEK');
  });

  it('cai para o JSON-LD', () => {
    expect(detectSourceCurrency(`{"@type":"Offer","price":"29.90","priceCurrency":"PLN"}`)).toBe('PLN');
  });

  it('não adivinha pelo símbolo e ignora códigos inválidos', () => {
    expect(detectSourceCurrency(`<span class="money">$29.90</span>`)).toBeNull();
    expect(detectSourceCurrency(`{"priceCurrency":"123"}`)).toBeNull();
  });
});
