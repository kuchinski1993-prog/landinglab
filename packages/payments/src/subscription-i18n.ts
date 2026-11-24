// Textos de assinatura do checkout/rastreio (Story 15.6). Só italiano, com
// inglês como fallback (decisão O8). Sem dependências — importável pelo storefront.
import type { SubscriptionInterval } from './checkout.js';

export interface SubscriptionStrings {
  badge: string;
  recurring: string;
  firstPayment: string;
  shippingFirstOnly: string;
  discountAllInvoices: string;
  cancelAnytime: string;
  manage: string;
  manageTitle: string;
  manageIntro: string;
  manageSubmit: string;
  manageNotFound: string;
  manageLinkInvalid: string;
  manageUnavailable: string;
  orderNumber: string;
  email: string;
}

const en: SubscriptionStrings = {
  badge: 'Subscription',
  recurring: 'Then',
  firstPayment: 'Due today',
  shippingFirstOnly: 'Shipping is charged on the first order only.',
  discountAllInvoices: 'The subscription discount applies to every payment.',
  cancelAnytime: 'You can cancel anytime from the subscription management page.',
  manage: 'Manage subscription',
  manageTitle: 'Manage your subscription',
  manageIntro: 'Enter your order number and the email used at checkout to manage your subscription.',
  manageSubmit: 'Continue',
  manageNotFound: 'We could not find a subscription with these details.',
  manageLinkInvalid: 'This link is invalid or has expired. Request a new one below.',
  manageUnavailable: 'Subscription management is temporarily unavailable. Please try again later.',
  orderNumber: 'Order number',
  email: 'Email',
};

const it: SubscriptionStrings = {
  badge: 'Abbonamento',
  recurring: 'Poi',
  firstPayment: 'Totale di oggi',
  shippingFirstOnly: 'La spedizione viene addebitata solo sul primo ordine.',
  discountAllInvoices: "Lo sconto dell'abbonamento vale per ogni pagamento.",
  cancelAnytime: "Puoi annullare in qualsiasi momento dalla pagina di gestione dell'abbonamento.",
  manage: "Gestisci l'abbonamento",
  manageTitle: 'Gestisci il tuo abbonamento',
  manageIntro: "Inserisci il numero d'ordine e l'email usata al checkout per gestire il tuo abbonamento.",
  manageSubmit: 'Continua',
  manageNotFound: 'Non abbiamo trovato un abbonamento con questi dati.',
  manageLinkInvalid: 'Questo link non è valido o è scaduto. Richiedine uno nuovo qui sotto.',
  manageUnavailable: "La gestione dell'abbonamento non è disponibile al momento. Riprova più tardi.",
  orderNumber: "Numero d'ordine",
  email: 'Email',
};

const STRINGS: Record<string, SubscriptionStrings> = { en, it };

export function subscriptionStrings(locale: string | null | undefined): SubscriptionStrings {
  return STRINGS[(locale ?? '').slice(0, 2)] ?? en;
}

const UNITS: Record<'it' | 'en', Record<SubscriptionInterval, [string, string]>> = {
  it: { day: ['giorno', 'giorni'], week: ['settimana', 'settimane'], month: ['mese', 'mesi'], year: ['anno', 'anni'] },
  en: { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] },
};

/** "ogni mese" / "ogni 2 settimane" / "every 3 months". */
export function formatInterval(interval: SubscriptionInterval, count: number, locale: string | null | undefined): string {
  const lang = (locale ?? '').slice(0, 2) === 'it' ? 'it' : 'en';
  const [one, many] = UNITS[lang][interval];
  if (lang === 'it') {
    if (count === 1) return interval === 'week' ? 'ogni settimana' : `ogni ${one}`;
    return `ogni ${count} ${many}`;
  }
  return count === 1 ? `every ${one}` : `every ${count} ${many}`;
}
