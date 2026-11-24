// Modelo de exibição do /rastreio (Story 15.4, AC10) — puro, testável e
// seguro para o bundle do cliente (só `import type` de post-sale-api).
// Só usa o que a API pública devolve: status atual, eventos visíveis ao
// cliente e o rastreio real informado pelo owner. Nada é inventado aqui.
import { formatInterval } from '@blackshop/payments/subscription-i18n';

import { formatMinor } from '../app/checkout/money';

import type { PublicOrderView } from './post-sale-api';
import { statusLabel, statusNote, type TrackingStrings } from './post-sale-i18n';

export interface TimelineRow {
  key: string;
  label: string;
  at: string;
  detail: string | null;
}

export interface TrackingDisplay {
  orderNumber: string;
  placedAt: string;
  statusLabel: string;
  statusNote: string | null;
  tracking: { code: string; carrier: string; url: string | null } | null;
  /** true quando não há código: a página mostra o estado honesto, sem data. */
  awaitingTracking: boolean;
  timeline: TimelineRow[];
  /** Story 15.6 — selo "Abbonamento" + valor recorrente + link de gestão (sem datas). */
  subscription: { recurring: string; managePath: string | null; canceled: boolean } | null;
}

/** Só caminho relativo da própria página de gestão (nunca URL externa vinda de dados). */
export function safeManagePath(value: unknown): string | null {
  return typeof value === 'string' && /^\/assinatura\/gerir\?t=[A-Za-z0-9._%-]+$/.test(value) ? value : null;
}

export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Só http(s): nunca renderiza `javascript:` ou similares vindos de dados. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const AWAITING_STATUSES = new Set(['paid', 'preparing']);

export function buildTrackingDisplay(order: PublicOrderView, t: TrackingStrings, locale: string): TrackingDisplay {
  const tracking =
    order.tracking && order.tracking.code && order.tracking.carrier
      ? { code: order.tracking.code, carrier: order.tracking.carrier, url: safeHttpUrl(order.tracking.url) }
      : null;

  // Mais antigo primeiro para identificar correções de rastreio; exibido do mais recente.
  const ordered = [...order.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let shippedSeen = false;
  const rows: TimelineRow[] = [];
  ordered.forEach((ev, index) => {
    const at = formatDateTime(ev.at, locale);
    const key = `${ev.type}-${index}`;
    if (ev.type === 'paid') rows.push({ key, label: t.eventPaid, at, detail: null });
    else if (ev.type === 'preparing') rows.push({ key, label: t.eventPreparing, at, detail: null });
    else if (ev.type === 'shipped') {
      const parts = [ev.details.carrier, ev.details.code].filter((p): p is string => typeof p === 'string' && p !== '');
      rows.push({
        key,
        label: shippedSeen ? t.eventShippedUpdated : t.eventShipped,
        at,
        detail: parts.length ? parts.join(' · ') : null,
      });
      shippedSeen = true;
    } else if (ev.type === 'refunded') {
      const amount =
        typeof ev.details.amountMinor === 'number' && typeof ev.details.currency === 'string' && ev.details.currency
          ? formatMinor(ev.details.amountMinor, ev.details.currency.toUpperCase(), locale)
          : null;
      rows.push({ key, label: ev.details.full ? t.eventRefundFull : t.eventRefundPartial, at, detail: amount });
    } else if (ev.type === 'subscription_started') {
      rows.push({ key, label: t.eventSubscriptionStarted, at, detail: null });
    } else if (ev.type === 'subscription_renewed') {
      rows.push({ key, label: t.eventSubscriptionRenewed, at, detail: null });
    } else if (ev.type === 'subscription_canceled') {
      rows.push({ key, label: t.eventSubscriptionCanceled, at, detail: null });
    }
  });

  const sub = order.subscription;
  const subscription = sub
    ? {
        recurring: `${formatMinor(sub.amountMinor, sub.currency.toUpperCase(), locale)} ${formatInterval(sub.interval, sub.intervalCount, locale)}`,
        managePath: sub.status === 'canceled' ? null : safeManagePath(sub.managePath),
        canceled: sub.status === 'canceled',
      }
    : null;

  return {
    orderNumber: order.orderNumber,
    placedAt: formatDateTime(order.placedAt, locale),
    statusLabel: statusLabel(t, order.status),
    // A nota de "enviado" cita o código abaixo — sem código, não exibe.
    statusNote: order.status === 'shipped' && !tracking ? null : statusNote(t, order.status),
    tracking,
    awaitingTracking: !tracking && AWAITING_STATUSES.has(order.status),
    timeline: rows.reverse(),
    subscription,
  };
}
