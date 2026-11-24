// LandingLab → Pedidos (Story 15.4) — tipos do contrato /admin/landing-orders
// e helpers de exibição. Valores sempre em unidade mínima + moeda ISO do pedido.

import { currencyMinorUnitDigits, minorUnitsToMajor } from '@blackshop/pricing';

export const LANDING_ORDER_STATUSES = [
  'pending',
  'paid',
  'preparing',
  'shipped',
  'delivered',
  'refunded',
  'cancelled',
  'chargeback',
  'failed',
] as const;
export type LandingOrderStatus = (typeof LANDING_ORDER_STATUSES)[number];

export const TRACKING_STATUSES: readonly string[] = ['paid', 'preparing', 'shipped'];
export const REFUNDABLE_STATUSES: readonly string[] = ['paid', 'preparing', 'shipped', 'delivered'];

export const LANDING_ORDER_EMAIL_TYPES = [
  'order_confirmed',
  'order_preparing',
  'order_shipped',
  'order_refunded',
] as const;
export type LandingOrderEmailType = (typeof LANDING_ORDER_EMAIL_TYPES)[number];

// Story 15.6 — tipo do pedido (avulso / 1ª fatura de assinatura / renovação).
export const LANDING_ORDER_KINDS = ['one_time', 'subscription_initial', 'subscription_renewal'] as const;
export type LandingOrderKind = (typeof LANDING_ORDER_KINDS)[number];

export interface LandingOrderListItem {
  id: string;
  orderNumber: string;
  /** Story 15.6 — ausente em respostas antigas = one_time. */
  orderKind?: LandingOrderKind | string;
  subscriptionId?: string | null;
  status: string;
  createdAt: string;
  paidAt: string | null;
  customerName: string | null;
  customerEmail: string;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  landingPageId: string;
  landingTitle: string | null;
  marketId: string | null;
  marketName: string | null;
  trackingCode: string | null;
}

export interface LandingOrderTotals {
  currency: string;
  count: number;
  amountMinor: number;
  refundedMinor: number;
}

export interface LandingOrderListResponse {
  orders: LandingOrderListItem[];
  total: number;
  totals: LandingOrderTotals[];
  page: number;
  pageSize: number;
}

export interface LandingOrderAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface LandingOrderItem {
  title: string;
  quantity: number;
  unitLabel: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  image: string | null;
}

export interface LandingOrderDetail extends LandingOrderListItem {
  locale: string | null;
  customerPhone: string | null;
  shippingAddress: LandingOrderAddress | null;
  items: LandingOrderItem[];
  host: string | null;
  shippingMethod: 'free' | 'express' | string | null;
  shippingMinor: number | null;
  subtotalMinor: number | null;
  settlementMinor: number | null;
  settlementCurrency: string | null;
  stripePaymentIntentId: string | null;
  stripeAccount: { id: string; nickname: string; mode: string } | null;
  trackingCarrier: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  preparingAt: string | null;
  landingBrand: string | null;
  refundableMinor: number;
}

export type LandingOrderEventType =
  | 'paid'
  | 'preparing'
  | 'shipped'
  | 'refunded'
  | 'email_sent'
  | 'email_failed'
  | 'note'
  | 'subscription_started'
  | 'subscription_renewed'
  | 'subscription_payment_failed'
  | 'subscription_canceled';

export interface LandingOrderEvent {
  id: string;
  type: LandingOrderEventType | string;
  payload: Record<string, unknown> | null;
  visibleToCustomer: boolean;
  createdAt: string;
}

export interface LandingOrderDetailResponse {
  order: LandingOrderDetail;
  events: LandingOrderEvent[];
  /** Story 15.6 — null/ausente = pedido avulso. */
  subscription?: LandingOrderSubscription | null;
}

// ─── Story 15.6 — assinaturas (contrato /admin/landing-subscriptions) ───

export const LANDING_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete_expired',
] as const;
export type LandingSubscriptionStatus = (typeof LANDING_SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

export interface SubscriptionOrderSummary {
  id: string;
  orderNumber: string;
  orderKind: LandingOrderKind | string;
  status: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
}

export interface LandingSubscription {
  id: string;
  status: LandingSubscriptionStatus | string;
  landingPageId: string;
  landingTitle: string | null;
  bundleOfferId: string | null;
  offerTitle: string | null;
  customerEmail: string;
  customerName: string | null;
  interval: SubscriptionInterval | string;
  intervalCount: number;
  unitAmountMinor: number;
  currency: string;
  renewalsCount: number;
  failedPayments: number;
  /** "Próxima cobrança" — só quando a Stripe informou. */
  currentPeriodEnd: string | null;
  cancelReason: string | null;
  /** Fim efetivo — só em assinatura cancelada (ended_at da Stripe). */
  canceledAt: string | null;
  /** E2E B-5 — cancelamento agendado pelo Portal (assinatura ainda viva). */
  cancelScheduledAt?: string | null;
  createdAt: string;
  firstOrderId: string | null;
  firstOrderNumber: string | null;
  stripeAccount: { id: string; nickname: string; mode: string } | null;
  stripeSubscriptionId: string;
  stripeDashboardUrl: string | null;
}

/** Cartão "Assinatura" no detalhe do pedido. */
export interface LandingOrderSubscription extends LandingSubscription {
  orders: SubscriptionOrderSummary[];
}

export interface LandingSubscriptionListResponse {
  subscriptions: LandingSubscription[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LandingSubscriptionDetailResponse {
  subscription: LandingSubscription;
  orders: SubscriptionOrderSummary[];
}

export interface LandingOrderRefundResponse {
  refund: { id: string; amountMinor: number; currency: string; status: string | null };
}

type Tone = 'success' | 'warning' | 'critical' | 'info' | 'attention' | undefined;

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pendente', tone: 'attention' },
  paid: { label: 'Pago', tone: 'success' },
  preparing: { label: 'Em preparação', tone: 'info' },
  shipped: { label: 'Enviado', tone: 'success' },
  delivered: { label: 'Entregue', tone: 'success' },
  refunded: { label: 'Reembolsado', tone: 'critical' },
  cancelled: { label: 'Cancelado', tone: undefined },
  chargeback: { label: 'Chargeback', tone: 'critical' },
  failed: { label: 'Falhou', tone: 'critical' },
};

export function statusLabel(status: string): string {
  return STATUS_META[status]?.label ?? status;
}

export function statusTone(status: string): Tone {
  return STATUS_META[status]?.tone;
}

export const EMAIL_TYPE_LABELS: Record<LandingOrderEmailType, string> = {
  order_confirmed: 'Pedido confirmado',
  order_preparing: 'Em preparação',
  order_shipped: 'Pedido enviado (rastreio)',
  order_refunded: 'Reembolso',
};

// Story 15.6 — e-mails automáticos de assinatura (não reenviáveis pelo painel).
const SUBSCRIPTION_EMAIL_LABELS: Record<string, string> = {
  subscription_renewal: 'Renovação da assinatura',
  subscription_payment_failed: 'Falha no pagamento da assinatura',
  subscription_canceled: 'Assinatura cancelada',
};

export function emailTypeLabel(type: unknown): string {
  if (typeof type !== 'string') return String(type ?? '—');
  if (type in EMAIL_TYPE_LABELS) return EMAIL_TYPE_LABELS[type as LandingOrderEmailType];
  return SUBSCRIPTION_EMAIL_LABELS[type] ?? type;
}

const KIND_META: Record<string, { label: string; tone: Tone }> = {
  one_time: { label: 'Avulso', tone: undefined },
  subscription_initial: { label: 'Assinatura (inicial)', tone: 'info' },
  subscription_renewal: { label: 'Renovação', tone: 'success' },
};

export function orderKindLabel(kind: string | null | undefined): string {
  return KIND_META[kind ?? 'one_time']?.label ?? String(kind);
}

export function orderKindTone(kind: string | null | undefined): Tone {
  return KIND_META[kind ?? 'one_time']?.tone;
}

export function isSubscriptionOrder(kind: string | null | undefined): boolean {
  return kind === 'subscription_initial' || kind === 'subscription_renewal';
}

const SUBSCRIPTION_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  incomplete: { label: 'Aguardando 1º pagamento', tone: 'attention' },
  active: { label: 'Ativa', tone: 'success' },
  past_due: { label: 'Pagamento pendente', tone: 'warning' },
  unpaid: { label: 'Não paga', tone: 'critical' },
  canceled: { label: 'Cancelada', tone: undefined },
  incomplete_expired: { label: 'Expirada sem pagamento', tone: undefined },
};

export function subscriptionStatusLabel(status: string): string {
  return SUBSCRIPTION_STATUS_META[status]?.label ?? status;
}

export function subscriptionStatusTone(status: string): Tone {
  return SUBSCRIPTION_STATUS_META[status]?.tone;
}

const INTERVAL_WORDS: Record<string, [string, string]> = {
  day: ['dia', 'dias'],
  week: ['semana', 'semanas'],
  month: ['mês', 'meses'],
  year: ['ano', 'anos'],
};

/** "a cada mês", "a cada 2 semanas". */
export function intervalLabel(interval: string | null | undefined, count: number | null | undefined): string {
  if (!interval) return '—';
  const words = INTERVAL_WORDS[interval];
  if (!words) return interval;
  const n = count && count > 0 ? count : 1;
  return n === 1 ? `a cada ${words[0]}` : `a cada ${n} ${words[1]}`;
}

const CANCEL_REASON_LABELS: Record<string, string> = {
  cancellation_requested: 'pedido de cancelamento (cliente ou Dashboard)',
  payment_failed: 'pagamentos recusados (tentativas esgotadas)',
  payment_disputed: 'pagamento contestado',
};

export const PAST_DUE_NEXT_CHARGE = 'Cobrança pendente — a Stripe está tentando novamente';

/**
 * E2E B-5 — texto de "Próxima cobrança". Em past_due/unpaid o current_period_end
 * gravado é o da fatura que falhou (não é uma cobrança futura): mostra o estado.
 * Com cancelamento agendado não há próxima cobrança.
 */
export function nextChargeLabel(
  sub: Pick<LandingSubscription, 'status' | 'currentPeriodEnd' | 'cancelScheduledAt'>,
): string {
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return '—';
  if (sub.cancelScheduledAt) return `Nenhuma — cancelamento agendado para ${formatShortDate(sub.cancelScheduledAt)}`;
  if (sub.status === 'past_due' || sub.status === 'unpaid') return PAST_DUE_NEXT_CHARGE;
  return sub.currentPeriodEnd ? formatShortDate(sub.currentPeriodEnd) : 'Não informada pela Stripe';
}

export function cancelReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return CANCEL_REASON_LABELS[reason] ?? reason;
}

const EMAIL_FAILURE_LABELS: Record<string, string> = {
  provider_error: 'erro do provedor de e-mail',
  enqueue_failed: 'falha ao enfileirar',
  missing_data: 'dados incompletos',
  no_recipient: 'pedido sem e-mail',
  invalid_recipient: 'e-mail do cliente inválido',
};

/** Formata unidade mínima na moeda do pedido (JPY sem decimais). */
export function formatMinor(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor)) return '—';
  const code = (currency ?? '').toUpperCase();
  if (!code) return String(amountMinor);
  const digits = currencyMinorUnitDigits(code);
  const major = minorUnitsToMajor(amountMinor, code);
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${code}`;
  }
}

/**
 * Converte o valor digitado (unidade maior, "12,50" ou "12.50") para unidade
 * mínima da moeda. null quando inválido ou com mais casas que a moeda permite.
 */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const raw = input.trim().replace(/\s/g, '');
  if (!raw) return null;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;
  if (lastComma > -1 && lastDot > -1) {
    // "1.234,56" ou "1,234.56": o último separador é o decimal.
    const [thousands, decimal] = lastComma > lastDot ? ['.', ','] : [',', '.'];
    normalized = raw.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma > -1) {
    normalized = raw.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const digits = currencyMinorUnitDigits(currency.toUpperCase());
  const decimals = normalized.split('.')[1]?.length ?? 0;
  if (decimals > digits) return null;
  const minor = Math.round(Number(normalized) * 10 ** digits);
  return Number.isSafeInteger(minor) ? minor : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Título + detalhe legível de um evento da timeline. */
export function describeEvent(ev: LandingOrderEvent, currency: string): { title: string; detail: string | null } {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'paid':
      return { title: 'Pagamento confirmado', detail: null };
    case 'preparing':
      return { title: 'Em preparação', detail: null };
    case 'shipped': {
      const parts = [str(p['carrier']), str(p['code'])].filter(Boolean).join(' · ');
      const url = str(p['url']);
      return {
        title: p['correction'] === true ? 'Rastreio corrigido' : 'Pedido enviado',
        detail: [parts, url].filter(Boolean).join(' — ') || null,
      };
    }
    case 'refunded': {
      const amount = typeof p['amountMinor'] === 'number' ? p['amountMinor'] : null;
      const cur = str(p['currency']) ?? currency;
      const total = typeof p['totalRefundedMinor'] === 'number' ? p['totalRefundedMinor'] : null;
      return {
        title: p['full'] === true ? 'Reembolso total' : 'Reembolso parcial',
        detail: [
          amount !== null ? formatMinor(amount, cur) : null,
          total !== null ? `total reembolsado ${formatMinor(total, cur)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      };
    }
    case 'email_sent':
      return {
        title: `E-mail enviado: ${emailTypeLabel(p['emailType'])}`,
        detail: [p['manual'] === true ? 'reenvio manual' : 'automático', p['mode'] === 'mock' ? 'modo simulado (mock)' : null]
          .filter(Boolean)
          .join(' · '),
      };
    case 'email_failed': {
      const reason = str(p['reason']);
      return {
        title: `Falha no e-mail: ${emailTypeLabel(p['emailType'])}`,
        detail: [reason ? (EMAIL_FAILURE_LABELS[reason] ?? reason) : null, str(p['error'])].filter(Boolean).join(' — ') || null,
      };
    }
    case 'note':
      return { title: 'Nota interna', detail: str(p['text']) };
    case 'subscription_started':
      return {
        title: 'Assinatura iniciada',
        detail: typeof p['interval'] === 'string' ? intervalLabel(p['interval'], num(p['intervalCount'])) : null,
      };
    case 'subscription_renewed': {
      const n = num(p['renewal']);
      return { title: n ? `Assinatura renovada (${n}ª renovação)` : 'Assinatura renovada', detail: null };
    }
    case 'subscription_payment_failed': {
      const amount = num(p['amountMinor']);
      const attempts = num(p['attemptCount']);
      return {
        title: 'Falha no pagamento da renovação',
        detail:
          [
            amount !== null ? formatMinor(amount, str(p['currency']) ?? currency) : null,
            attempts !== null ? `tentativa ${attempts}` : null,
            'a Stripe tenta de novo conforme a política de retentativas da conta',
          ]
            .filter(Boolean)
            .join(' · ') || null,
      };
    }
    case 'subscription_canceled':
      return { title: 'Assinatura cancelada', detail: cancelReasonLabel(str(p['reason'])) };
    default:
      return { title: ev.type, detail: null };
  }
}

/** Data curta pt-BR ("06 de out. de 2026"); '—' se ausente/inválida. */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatAddress(a: LandingOrderAddress | null | undefined): string[] {
  if (!a) return [];
  return [
    [a.line1, a.line2].filter(Boolean).join(', '),
    [a.postal_code, a.city, a.state].filter(Boolean).join(' '),
    a.country ?? '',
  ].filter((line) => line.trim().length > 0);
}
