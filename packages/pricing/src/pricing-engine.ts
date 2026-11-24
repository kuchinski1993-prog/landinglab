import { Decimal } from 'decimal.js';

import { formatPrice } from './format-price.js';
import { validateRate } from './fx-guard.js';

export type RoundingStrategy = 'ceil' | 'round' | 'floor' | 'none';

export interface PriceRuleInput {
  exchangeRate: string | number;
  markupPercent: string | number;
  rounding: string;
}

export interface PricingResult {
  // Bloco A · o nome do campo é histórico (priceBrl). O VALOR
  // agora representa "preço convertido na moeda-alvo" — vale para
  // qualquer moeda (GBP/EUR/USD/BRL). Dívida técnica: renomear
  // para `price` quando houver janela segura.
  priceBrl: number;
  priceFormatted: string;
}

/**
 * Story 0.7 · taxa de câmbio inválida (0, negativa, NaN, Infinity, texto).
 * Antes, taxa 0 virava preço 0.00 enviado à Shopify.
 */
export class InvalidExchangeRateError extends Error {
  readonly code = 'FX_RATE_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExchangeRateError';
  }
}

export class PricingEngine {
  apply(
    rawPrice: string | number,
    _currency: string,
    rule: PriceRuleInput,
    // Bloco A · moeda-alvo controla APENAS a formatação — o cálculo
    // numérico é sempre o mesmo (rawPrice × exchangeRate × markup).
    // Default 'BRL' preserva o comportamento pré-Bloco A.
    targetCurrency: string = 'BRL',
  ): PricingResult {
    const rateCheck = validateRate(rule.exchangeRate);
    if (!rateCheck.ok) {
      throw new InvalidExchangeRateError(`FX_RATE_INVALID: ${rateCheck.message}`);
    }
    const price = new Decimal(rawPrice);
    const rate = rateCheck.rate;
    const markupFactor = new Decimal(rule.markupPercent).div(100).plus(1);

    let result = price.mul(rate).mul(markupFactor);

    const rounding = rule.rounding as RoundingStrategy;
    if (rounding === 'ceil') {
      result = result.ceil();
    } else if (rounding === 'round') {
      result = result.toDecimalPlaces(2);
    } else if (rounding === 'floor') {
      result = result.floor();
    }
    // 'none' — no rounding applied

    const priceBrl = result.toNumber();
    const priceFormatted = formatPrice(priceBrl, targetCurrency);

    return { priceBrl, priceFormatted };
  }
}
