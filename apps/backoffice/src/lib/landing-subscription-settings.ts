// Story 15.6 (AC2) — assinatura (Subscribe & Save) em landing com checkout
// Stripe: validação dos campos subs_* e preview do preço recorrente.
// Módulo puro: usado pela rota checkout-settings (fonte da verdade) e pelo
// editor (preview). O preço recorrente usa a MESMA função do servidor da API
// (recurringUnitAmount) — o que o editor mostra é o que a Stripe cobra.

import { maxIntervalCount, recurringUnitAmount } from '@blackshop/payments/checkout';

import { SUBSCRIPTION_INTERVALS, type SubscriptionInterval } from './landing-orders';

export const SUBS_INTERVAL_COUNT_MIN = 1;
export const SUBS_INTERVAL_COUNT_MAX = 12;

/** QA 15.6 REQ-001 — maior frequência aceita pela Stripe para o intervalo (ano → 1). */
export function subsIntervalCountMax(interval: string | null | undefined): number {
  return maxIntervalCount(interval);
}

export const YEARLY_COUNT_MESSAGE = 'Com intervalo anual a frequência deve ser 1 (a Stripe cobra no máximo a cada 1 ano).';

export interface StripeSubscriptionSettings {
  enabled: boolean;
  preselected: boolean;
  /** 0–99; null = sem desconto. Vale em todas as faturas (1ª e renovações). */
  discountPercent: number | null;
  interval: SubscriptionInterval | null;
  intervalCount: number;
}

export interface OfferForPreview {
  id: string;
  position: number;
  title: string;
  qty: number;
  priceCents: number;
}

export interface RecurringPreviewRow {
  offerId: string;
  position: number;
  title: string;
  qty: number;
  priceMinor: number;
  /** null quando a oferta não tem preço ou o desconto zera o valor. */
  recurringMinor: number | null;
}

export type ParseResult =
  | { ok: true; value: StripeSubscriptionSettings }
  | { ok: false; message: string };

function isInterval(value: unknown): value is SubscriptionInterval {
  return typeof value === 'string' && (SUBSCRIPTION_INTERVALS as readonly string[]).includes(value);
}

/** Valida o corpo `subscription` (snake_case) enviado pelo editor. */
export function parseStripeSubscriptionInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'Configuração de assinatura inválida.' };
  const b = raw as Record<string, unknown>;

  let discountPercent: number | null = null;
  if (b['discount_percent'] !== undefined && b['discount_percent'] !== null && b['discount_percent'] !== '') {
    const n = Number(b['discount_percent']);
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      return { ok: false, message: 'O desconto da assinatura deve ser um número inteiro de 0 a 99.' };
    }
    discountPercent = n;
  }

  let interval: SubscriptionInterval | null = null;
  if (b['interval'] !== undefined && b['interval'] !== null && b['interval'] !== '') {
    if (!isInterval(b['interval'])) return { ok: false, message: 'Intervalo inválido (dia, semana, mês ou ano).' };
    interval = b['interval'];
  }

  let intervalCount = 1;
  if (b['interval_count'] !== undefined && b['interval_count'] !== null && b['interval_count'] !== '') {
    const n = Number(b['interval_count']);
    if (!Number.isInteger(n) || n < SUBS_INTERVAL_COUNT_MIN || n > SUBS_INTERVAL_COUNT_MAX) {
      return {
        ok: false,
        message: `A frequência deve ser um número inteiro de ${SUBS_INTERVAL_COUNT_MIN} a ${SUBS_INTERVAL_COUNT_MAX}.`,
      };
    }
    intervalCount = n;
  }
  if (intervalCount > subsIntervalCountMax(interval)) return { ok: false, message: YEARLY_COUNT_MESSAGE };

  return {
    ok: true,
    value: {
      enabled: b['enabled'] === true,
      preselected: b['preselected'] === true,
      discountPercent,
      interval,
      intervalCount,
    },
  };
}

/** Preço recorrente por oferta = preço × (1 − desconto), igual ao servidor. */
export function recurringPreview(offers: OfferForPreview[], discountPercent: number | null): RecurringPreviewRow[] {
  return [...offers]
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      let recurringMinor: number | null = null;
      if (Number.isInteger(o.priceCents) && o.priceCents > 0) {
        try {
          recurringMinor = recurringUnitAmount(o.priceCents, discountPercent);
        } catch {
          recurringMinor = null;
        }
      }
      return {
        offerId: o.id,
        position: o.position,
        title: o.title,
        qty: o.qty,
        priceMinor: o.priceCents,
        recurringMinor,
      };
    });
}

/**
 * Pendências para ligar a assinatura numa landing Stripe (vazio = ok).
 * Desligada nunca bloqueia (os valores ficam salvos para depois).
 */
export function stripeSubscriptionIssues(
  settings: StripeSubscriptionSettings,
  offers: OfferForPreview[],
): string[] {
  if (!settings.enabled) return [];
  const issues: string[] = [];
  if (!settings.interval) issues.push('Escolha o intervalo da cobrança (dia, semana, mês ou ano).');
  else if (settings.intervalCount > subsIntervalCountMax(settings.interval)) issues.push(YEARLY_COUNT_MESSAGE);
  const priced = offers.filter((o) => o.priceCents > 0);
  if (priced.length === 0) issues.push('A landing precisa de ofertas (bundles) com preço para vender assinatura.');
  const zeroed = recurringPreview(priced, settings.discountPercent).filter((r) => r.recurringMinor === null);
  if (zeroed.length > 0) {
    issues.push(
      `Com ${settings.discountPercent ?? 0}% de desconto o preço recorrente fica zero em: ${zeroed
        .map((r) => r.title || `oferta ${r.position}`)
        .join(', ')}. Reduza o desconto.`,
    );
  }
  return issues;
}
