// Textos da página pública /rastreio (Story 15.4, AC10).
//
// Mesmo mecanismo do checkout (`checkoutStrings` em
// packages/payments/src/checkout-i18n.ts): dicionário por idioma (2 letras),
// fallback 'en'. Nesta story só o italiano tem texto (decisão 8 do owner);
// es/pt/fr/de entram aqui quando houver mercado nesses idiomas.
//
// Honestidade (D12/D13): nenhum texto promete data de entrega nem inventa
// eventos de transportadora — só descreve o estado real do pedido.

export type KnownOrderStatus =
  | 'pending'
  | 'paid'
  | 'preparing'
  | 'shipped'
  | 'delivered'
  | 'refunded'
  | 'cancelled'
  | 'chargeback'
  | 'failed';

export interface TrackingStrings {
  title: string;
  intro: string;
  orderNumber: string;
  email: string;
  submit: string;
  searching: string;
  notFound: string;
  rateLimited: string;
  errorGeneric: string;
  order: string;
  placedOn: string;
  status: string;
  statusLabel: Record<KnownOrderStatus, string>;
  statusUnknown: string;
  /** Explicação honesta do estado atual (sem data). Ausente = sem texto extra. */
  statusNote: Partial<Record<KnownOrderStatus, string>>;
  shipment: string;
  carrier: string;
  trackingCode: string;
  trackOnCarrier: string;
  noTrackingYet: string;
  history: string;
  eventPaid: string;
  eventPreparing: string;
  eventShipped: string;
  eventShippedUpdated: string;
  eventRefundFull: string;
  eventRefundPartial: string;
  trackAnother: string;
  /** Story 15.6 — eventos visíveis da assinatura (sem datas futuras). */
  eventSubscriptionStarted: string;
  eventSubscriptionRenewed: string;
  eventSubscriptionCanceled: string;
}

const en: TrackingStrings = {
  title: 'Track your order',
  intro: 'Enter your order number and the email address you used at checkout.',
  orderNumber: 'Order number',
  email: 'Email',
  submit: 'Track order',
  searching: 'Searching…',
  notFound:
    "We couldn't find an order with these details. Please check the order number and email address and try again.",
  rateLimited: 'Too many attempts. Please wait a minute and try again.',
  errorGeneric: 'Something went wrong. Please try again in a few moments.',
  order: 'Order',
  placedOn: 'Placed on',
  status: 'Status',
  statusLabel: {
    pending: 'Awaiting payment',
    paid: 'Order received',
    preparing: 'Being prepared',
    shipped: 'Shipped',
    delivered: 'Delivered',
    refunded: 'Refunded',
    cancelled: 'Cancelled',
    chargeback: 'Under review',
    failed: 'Payment not completed',
  },
  statusUnknown: 'In progress',
  statusNote: {
    paid: 'We have received your order. You will get an email with the tracking code as soon as it ships.',
    preparing:
      'Your order is being prepared. The tracking code will appear here and in your email as soon as it ships.',
    shipped: "Your order has been shipped. Use the tracking code below on the carrier's website.",
    refunded: 'This order has been refunded.',
  },
  shipment: 'Shipment',
  carrier: 'Carrier',
  trackingCode: 'Tracking code',
  trackOnCarrier: "Track on the carrier's website",
  noTrackingYet: 'Tracking code not available yet.',
  history: 'Order history',
  eventPaid: 'Order confirmed',
  eventPreparing: 'Order being prepared',
  eventShipped: 'Order shipped',
  eventShippedUpdated: 'Shipping details updated',
  eventRefundFull: 'Full refund issued',
  eventRefundPartial: 'Partial refund issued',
  trackAnother: 'Track another order',
  eventSubscriptionStarted: 'Subscription started',
  eventSubscriptionRenewed: 'Subscription renewed — new order',
  eventSubscriptionCanceled: 'Subscription canceled',
};

const it: TrackingStrings = {
  title: 'Traccia il tuo ordine',
  intro: "Inserisci il numero dell'ordine e l'indirizzo email usato al momento dell'acquisto.",
  orderNumber: "Numero dell'ordine",
  email: 'Email',
  submit: 'Traccia ordine',
  searching: 'Ricerca in corso…',
  notFound:
    "Non abbiamo trovato un ordine con questi dati. Controlla il numero dell'ordine e l'indirizzo email e riprova.",
  rateLimited: 'Troppi tentativi. Attendi un minuto e riprova.',
  errorGeneric: 'Si è verificato un errore. Riprova tra qualche istante.',
  order: 'Ordine',
  placedOn: 'Effettuato il',
  status: 'Stato',
  statusLabel: {
    pending: 'In attesa di pagamento',
    paid: 'Ordine ricevuto',
    preparing: 'In preparazione',
    shipped: 'Spedito',
    delivered: 'Consegnato',
    refunded: 'Rimborsato',
    cancelled: 'Annullato',
    chargeback: 'In verifica',
    failed: 'Pagamento non completato',
  },
  statusUnknown: 'In corso',
  statusNote: {
    paid: "Abbiamo ricevuto il tuo ordine. Riceverai un'email con il codice di tracciamento appena verrà spedito.",
    preparing:
      'Il tuo ordine è in preparazione. Il codice di tracciamento apparirà qui e nella tua email appena verrà spedito.',
    shipped: 'Il tuo ordine è stato spedito. Usa il codice di tracciamento qui sotto sul sito del corriere.',
    refunded: 'Questo ordine è stato rimborsato.',
  },
  shipment: 'Spedizione',
  carrier: 'Corriere',
  trackingCode: 'Codice di tracciamento',
  trackOnCarrier: 'Traccia sul sito del corriere',
  noTrackingYet: 'Codice di tracciamento non ancora disponibile.',
  history: "Cronologia dell'ordine",
  eventPaid: 'Ordine confermato',
  eventPreparing: 'Ordine in preparazione',
  eventShipped: 'Ordine spedito',
  eventShippedUpdated: 'Dati di spedizione aggiornati',
  eventRefundFull: 'Rimborso totale effettuato',
  eventRefundPartial: 'Rimborso parziale effettuato',
  trackAnother: 'Traccia un altro ordine',
  eventSubscriptionStarted: 'Abbonamento attivato',
  eventSubscriptionRenewed: 'Abbonamento rinnovato — nuovo ordine',
  eventSubscriptionCanceled: 'Abbonamento annullato',
};

const STRINGS: Record<string, TrackingStrings> = { en, it };

export function trackingStrings(locale: string | null | undefined): TrackingStrings {
  return STRINGS[(locale ?? '').slice(0, 2).toLowerCase()] ?? en;
}

/** Idioma efetivamente usado (para `lang` e formatação de datas). */
export function trackingLocale(locale: string | null | undefined): string {
  const key = (locale ?? '').slice(0, 2).toLowerCase();
  return key in STRINGS ? key : 'en';
}

export function statusLabel(t: TrackingStrings, status: string): string {
  return (t.statusLabel as Record<string, string | undefined>)[status] ?? t.statusUnknown;
}

export function statusNote(t: TrackingStrings, status: string): string | null {
  return (t.statusNote as Record<string, string | undefined>)[status] ?? null;
}
