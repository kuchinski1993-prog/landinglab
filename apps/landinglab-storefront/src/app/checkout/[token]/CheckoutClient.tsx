'use client';

// Checkout Stripe da LandingLab (Story 15.3) — layout espelhado no checkout
// Shopify: pagamento rápido, contato, entrega, frete, pagamento | resumo.
// Valores sempre vêm do servidor (proxy /api/ll-checkout → API).
//
// Story 15.6 — sessão de assinatura (view.billing): Elements em modo deferred
// (`mode: 'subscription'`, valor da 1ª fatura). No submit: elements.submit()
// → POST subscribe (servidor cria Customer + Subscription default_incomplete
// com frete só na 1ª fatura) → confirmPayment com o client secret da fatura.
// A compra avulsa continua exatamente como na 15.3.
//
// Story 15.7 — só apresentação: moldura Shopify (CheckoutShell) e Appearance
// API dos Elements com os valores medidos no checkout Shopify de referência.

import { checkoutStrings, type CheckoutStrings } from '@blackshop/payments/checkout-i18n';
import { subscriptionStrings } from '@blackshop/payments/subscription-i18n';
import {
  AddressElement,
  Elements,
  ExpressCheckoutElement,
  LinkAuthenticationElement,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { loadStripe, type Appearance, type StripeElementLocale } from '@stripe/stripe-js';
import { useEffect, useMemo, useRef, useState } from 'react';

import { headerBrandOf } from '../brand';
import styles from '../checkout.module.css';
import { ChevronIcon, CheckoutShell, openMobileSummary } from '../CheckoutShell';
import { formatMinor } from '../money';
import { OrderSummary } from '../OrderSummary';

import type { CheckoutView, QuoteView, ShippingOptionView } from '@/lib/checkout-api';
import { createShippingSwitch, elementsAmount, expressShippingRates } from '@/lib/checkout-elements';
import type { PolicyLink } from '@/lib/post-sale-api';

interface Props {
  token: string;
  view: CheckoutView;
  /** Story 15.4 (AC13): políticas publicadas do mercado (vazio = sem rodapé). */
  policies?: PolicyLink[];
}

interface IntentResponse {
  publishableKey: string;
  clientSecret: string;
  quote: QuoteView;
  /** Story 15.6: 'subscription' = Elements deferred (sem client secret ainda). */
  mode?: 'payment' | 'subscription';
  error?: string;
}

interface SubscribeResponse {
  publishableKey: string;
  clientSecret: string;
  quote: QuoteView;
  error?: string;
}

// Pilha de fontes do sistema do checkout Shopify (mesma no body e nos títulos).
export const SHOPIFY_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"';

// Valores do checkout Shopify de referência: texto #000 / secundário #707070,
// borda #DEDEDE, raio 12px, campos ~49px com label flutuante, foco no accent
// #005BD1, controles/seleção em #5D5D5D, item selecionado com fundo #F6F6F6.
export const SHOPIFY_APPEARANCE: Appearance = {
  theme: 'stripe',
  labels: 'floating',
  inputs: 'spaced',
  variables: {
    fontFamily: SHOPIFY_FONT_STACK,
    fontSizeBase: '14px',
    fontLineHeight: '1.35',
    fontWeightNormal: '400',
    fontWeightMedium: '600',
    fontWeightBold: '600',
    colorPrimary: '#5D5D5D',
    colorBackground: '#FFFFFF',
    colorText: '#000000',
    colorTextSecondary: '#707070',
    colorTextPlaceholder: '#707070',
    colorDanger: '#D91C1C',
    iconColor: '#707070',
    borderRadius: '12px',
    buttonExpressCheckoutBorderRadius: '5px',
    spacingUnit: '2px',
    gridRowSpacing: '10px',
    gridColumnSpacing: '10px',
    focusBoxShadow: '0 0 0 1px #005BD1',
    focusOutline: 'none',
  },
  rules: {
    '.Input': {
      border: '1px solid #DEDEDE',
      boxShadow: 'none',
      padding: '8px 10px',
      fontSize: '14px',
    },
    '.Input:focus': {
      border: '1px solid #005BD1',
      boxShadow: '0 0 0 1px #005BD1',
    },
    '.Input--invalid': {
      border: '1px solid #D91C1C',
      boxShadow: '0 0 0 1px #D91C1C',
    },
    '.Label': { color: '#707070', fontWeight: '400' },
    '.Error': { fontSize: '12px', color: '#D91C1C' },
    '.Tab': { border: '1px solid #DEDEDE', boxShadow: 'none' },
    '.Tab--selected': { borderColor: '#5D5D5D', boxShadow: '0 0 0 1px #5D5D5D' },
    '.AccordionItem': {
      border: '1px solid #DEDEDE',
      boxShadow: 'none',
      padding: '14px',
      fontSize: '14px',
      fontWeight: '600',
      color: '#000000',
    },
    '.AccordionItem--selected': {
      backgroundColor: '#F6F6F6',
      borderColor: '#5D5D5D',
      color: '#000000',
    },
    '.Block': { border: '1px solid #DEDEDE', boxShadow: 'none', backgroundColor: '#FFFFFF' },
    '.CheckboxInput': { border: '1px solid #DEDEDE', borderRadius: '6px', boxShadow: 'none' },
    '.CheckboxInput--checked': { backgroundColor: '#5D5D5D', borderColor: '#5D5D5D' },
    '.CheckboxLabel': { fontSize: '14px', color: '#000000' },
  },
};

async function post<T>(token: string, action: string, body: unknown = {}): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(`/api/ll-checkout/${token}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, data };
}

export default function CheckoutClient({ token, view, policies = [] }: Props): JSX.Element {
  const t = checkoutStrings(view.locale);
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void post<IntentResponse>(token, 'intent').then(({ ok, data }) => {
      if (cancelled) return;
      const deferred = data.mode === 'subscription' && Boolean(view.billing);
      if (!ok || (!data.clientSecret && !deferred)) setFatal(data.error ?? t.errorGeneric);
      else setIntent(data);
    });
    return () => {
      cancelled = true;
    };
  }, [token, t.errorGeneric, view.billing]);

  const stripePromise = useMemo(() => (intent ? loadStripe(intent.publishableKey) : null), [intent]);
  const live = useLiveQuote(view.quote);

  const summary = (
    <OrderSummary
      items={view.items}
      quote={live.quote}
      currency={view.currency}
      locale={view.locale}
      t={t}
      shippingKnown={live.known}
      billing={view.billing ?? null}
    />
  );

  return (
    <CheckoutShell
      summary={summary}
      summaryLabel={t.orderSummary}
      summaryTotal={formatMinor(live.quote.totalMinor, view.currency, view.locale)}
      brand={headerBrandOf(view)}
    >
      {fatal && <div className={styles.error}>{fatal}</div>}
      {!fatal && !intent && <div className={styles.loading}>{t.processing}</div>}
      {intent && stripePromise && (
        <Elements
          stripe={stripePromise}
          options={
            intent.mode === 'subscription'
              ? {
                  mode: 'subscription',
                  // Unidade da Stripe (QA 15.3 MNT-004: COP tem 2 casas na Stripe).
                  amount: elementsAmount(intent.quote.totalMinor, view.currency),
                  currency: view.currency.toLowerCase(),
                  locale: view.locale as StripeElementLocale,
                  appearance: SHOPIFY_APPEARANCE,
                }
              : {
                  clientSecret: intent.clientSecret,
                  locale: view.locale as StripeElementLocale,
                  appearance: SHOPIFY_APPEARANCE,
                }
          }
        >
          <CheckoutForm
            token={token}
            view={view}
            t={t}
            initialQuote={intent.quote}
            clientSecret={intent.clientSecret}
            subscription={intent.mode === 'subscription'}
          />
        </Elements>
      )}
      <PolicyFooter policies={policies} landingPageId={view.landingPageId ?? null} />
    </CheckoutShell>
  );
}

function PolicyFooter({
  policies,
  landingPageId,
}: {
  policies: PolicyLink[];
  landingPageId: string | null;
}): JSX.Element | null {
  if (policies.length === 0) return null;
  // `lp` fixa a mesma landing (mercado) na página da política quando o host tem várias.
  const suffix = landingPageId ? `?lp=${encodeURIComponent(landingPageId)}` : '';
  return (
    <footer className={styles.policyFooter}>
      <ul>
        {policies.map((p) => (
          <li key={p.slug}>
            <a href={`/policies/${p.slug}${suffix}`} target="_blank" rel="noopener">
              {p.title}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}

// O resumo precisa refletir o frete escolhido no formulário: ouve o evento
// disparado pelo CheckoutForm em vez de levantar estado por toda a árvore.
const QUOTE_EVENT = 'll-checkout-quote';

/** Quote ao vivo para o resumo (desktop e barra do mobile), publicado pelo CheckoutForm. */
function useLiveQuote(initial: QuoteView): { quote: QuoteView; known: boolean } {
  const [quote, setQuote] = useState<QuoteView>(initial);
  const [known, setKnown] = useState(false);
  useEffect(() => {
    const onQuote = (e: Event) => {
      setQuote((e as CustomEvent<QuoteView>).detail);
      setKnown(true);
    };
    window.addEventListener(QUOTE_EVENT, onQuote);
    return () => window.removeEventListener(QUOTE_EVENT, onQuote);
  }, []);
  return { quote, known };
}

function publishQuote(quote: QuoteView): void {
  window.dispatchEvent(new CustomEvent<QuoteView>(QUOTE_EVENT, { detail: quote }));
}

interface FormProps {
  token: string;
  view: CheckoutView;
  t: CheckoutStrings;
  initialQuote: QuoteView;
  clientSecret: string;
  /** Story 15.6: Elements deferred — client secret só existe após POST subscribe. */
  subscription?: boolean;
}

interface AddressValue {
  name: string;
  phone?: string;
  address: { line1: string; line2: string | null; city: string; postal_code: string; state: string; country: string };
}

function CheckoutForm({ token, view, t, initialQuote, clientSecret, subscription = false }: FormProps): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [quote, setQuote] = useState<QuoteView>(initialQuote);
  const [email, setEmail] = useState('');
  const [newsletter, setNewsletter] = useState(false);
  const [addressComplete, setAddressComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasExpress, setHasExpress] = useState(false);
  // QA 15.3 REL-001: rádios desabilitados enquanto uma troca de frete está pendente.
  const [switchingShipping, setSwitchingShipping] = useState(false);

  const returnPath = `/checkout/${token}/done`;
  const returnUrl = typeof window !== 'undefined' ? `${window.location.origin}${returnPath}` : returnPath;
  const money = (minor: number) => formatMinor(minor, view.currency, view.locale);

  useEffect(() => {
    if (addressComplete) publishQuote(quote);
  }, [quote, addressComplete]);

  const quoteRef = useRef(quote);
  quoteRef.current = quote;

  async function applyShipping(method: ShippingOptionView['method']): Promise<boolean> {
    if (method === quoteRef.current.shippingMethod) return true;
    const { ok, data } = await post<QuoteView>(token, 'shipping', { method });
    if (!ok) {
      setError(t.errorGeneric);
      return false;
    }
    setQuote(data);
    quoteRef.current = data;
    // Assinatura (deferred): o valor exibido pelo Elements/carteiras é o da 1ª
    // fatura; a Stripe só é chamada no submit, com o frete já escolhido.
    if (subscription) elements?.update({ amount: elementsAmount(data.totalMinor, view.currency) });
    else await elements?.fetchUpdates();
    return true;
  }

  // Uma troca por vez (o servidor também serializa por sessão).
  const applyShippingRef = useRef(applyShipping);
  applyShippingRef.current = applyShipping;
  const switchRef = useRef<((method: ShippingOptionView['method']) => Promise<boolean>) | null>(null);
  switchRef.current ??= createShippingSwitch<ShippingOptionView['method']>(
    (method) => applyShippingRef.current(method),
    setSwitchingShipping,
  );
  const changeShipping = (method: ShippingOptionView['method']) => switchRef.current!(method);

  async function sendCustomer(details: { email: string; name: string; phone?: string; address: AddressValue['address'] }) {
    return post<{ error?: string }>(token, 'customer', {
      email: details.email,
      name: details.name,
      phone: details.phone,
      newsletter,
      address: { ...details.address, line2: details.address.line2 ?? undefined },
    });
  }

  /** Story 15.6: cria a assinatura no servidor e devolve o client secret da 1ª fatura. */
  async function startSubscription(details: {
    email: string;
    name: string;
    phone?: string;
    address: AddressValue['address'];
  }): Promise<{ ok: true; clientSecret: string } | { ok: false; error: string }> {
    const { ok, data } = await post<SubscribeResponse>(token, 'subscribe', {
      email: details.email,
      name: details.name,
      phone: details.phone,
      newsletter,
      shippingMethod: quote.shippingMethod,
      address: { ...details.address, line2: details.address.line2 ?? undefined },
    });
    if (!ok || !data.clientSecret) return { ok: false, error: data.error ?? t.errorGeneric };
    return { ok: true, clientSecret: data.clientSecret };
  }

  /** Avulsa: grava o cliente e usa o client secret do PaymentIntent; assinatura: cria a Subscription. */
  async function prepareConfirmation(details: {
    email: string;
    name: string;
    phone?: string;
    address: AddressValue['address'];
  }): Promise<{ ok: true; clientSecret: string } | { ok: false; error: string }> {
    if (subscription) return startSubscription(details);
    const saved = await sendCustomer(details);
    if (!saved.ok) return { ok: false, error: saved.data.error ?? t.errorGeneric };
    return { ok: true, clientSecret };
  }

  async function pay(): Promise<void> {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await elements.submit();
      if (submitted.error) {
        setError(submitted.error.message ?? t.errorGeneric);
        return;
      }
      const addressEl = elements.getElement(AddressElement);
      const addr = (await addressEl?.getValue())?.value as AddressValue | undefined;
      if (!addr || !email) {
        setError(t.errorGeneric);
        return;
      }
      const prepared = await prepareConfirmation({ email, name: addr.name, phone: addr.phone, address: addr.address });
      if (!prepared.ok) {
        setError(prepared.error);
        return;
      }
      const result = await stripe.confirmPayment({
        elements,
        clientSecret: prepared.clientSecret,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });
      if (result.error) {
        setError(result.error.message ?? t.errorGeneric);
        return;
      }
      window.location.assign(returnPath);
    } finally {
      setBusy(false);
    }
  }

  // QA 15.3 UX-008: frete atual da sessão primeiro (a carteira abre com ele selecionado).
  const shippingRates = expressShippingRates(view.shippingOptions, quote.shippingMethod, view.currency);

  const st = subscriptionStrings(view.locale);
  const itemCount = view.items.reduce((n, i) => n + i.quantity, 0);
  const firstImage = view.items.find((i) => i.image)?.image ?? null;

  return (
    <>
      <div className={styles.express} style={{ display: hasExpress ? 'block' : 'none' }}>
        <h2 className={styles.expressTitle}>{t.expressCheckout}</h2>
        <ExpressCheckoutElement
          options={{
            emailRequired: true,
            shippingAddressRequired: true,
            allowedShippingCountries: view.countries,
            shippingRates,
            buttonHeight: 48,
            layout: { maxColumns: 3, maxRows: 1, overflow: 'auto' },
            // Como no Shopify: Apple Pay / Google Pay aparecem em todo navegador compatível,
            // mesmo sem cartão salvo na carteira (o cliente adiciona no próprio fluxo da carteira).
            paymentMethods: { applePay: 'always', googlePay: 'always', link: 'auto' },
            buttonTheme: { applePay: 'black', googlePay: 'black' },
          }}
          onReady={({ availablePaymentMethods }) => setHasExpress(Boolean(availablePaymentMethods))}
          onShippingRateChange={async (event) => {
            const ok = await changeShipping(event.shippingRate.id as ShippingOptionView['method']);
            if (ok) event.resolve();
            else event.reject();
          }}
          onConfirm={async (event) => {
            if (!stripe || !elements) return;
            const ship = event.shippingAddress;
            // Deferred (assinatura): valida os dados do Elements antes de criar a Subscription.
            if (subscription) {
              const submitted = await elements.submit();
              if (submitted.error) {
                setError(submitted.error.message ?? t.errorGeneric);
                return;
              }
            }
            const prepared = await prepareConfirmation({
              email: event.billingDetails?.email ?? '',
              name: ship?.name ?? event.billingDetails?.name ?? '',
              phone: event.billingDetails?.phone ?? undefined,
              address: {
                line1: ship?.address.line1 ?? '',
                line2: ship?.address.line2 ?? null,
                city: ship?.address.city ?? '',
                postal_code: ship?.address.postal_code ?? '',
                state: ship?.address.state ?? '',
                country: ship?.address.country ?? '',
              },
            });
            if (!prepared.ok) {
              event.paymentFailed({ reason: 'invalid_shipping_address' });
              setError(prepared.error);
              return;
            }
            const result = await stripe.confirmPayment({
              elements,
              clientSecret: prepared.clientSecret,
              confirmParams: { return_url: returnUrl },
              redirect: 'if_required',
            });
            if (result.error) {
              setError(result.error.message ?? t.errorGeneric);
              return;
            }
            window.location.assign(returnPath);
          }}
        />
        <div className={styles.divider}>
          <span>{t.or}</span>
        </div>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t.contact}</h2>
        <LinkAuthenticationElement onChange={(e) => setEmail(e.value.email)} />
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={newsletter}
            onChange={(e) => setNewsletter(e.target.checked)}
          />
          <span>{t.newsletter}</span>
        </label>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t.delivery}</h2>
        <AddressElement
          options={{
            mode: 'shipping',
            allowedCountries: view.countries,
            display: { name: 'split' },
            fields: { phone: 'always' },
            validation: { phone: { required: 'never' } },
          }}
          onChange={(e) => setAddressComplete(e.complete)}
        />

        <h3 className={styles.subsectionTitle}>{t.shippingMethod}</h3>
        {!addressComplete ? (
          <div className={styles.shippingEmpty}>
            <p>{t.shippingMethodHint}</p>
          </div>
        ) : (
          <div className={styles.shippingList} role="radiogroup" aria-label={t.shippingMethod}>
            {view.shippingOptions.map((o) => (
              <label
                key={o.method}
                className={`${styles.shippingOption} ${quote.shippingMethod === o.method ? styles.shippingOptionActive : ''}`}
              >
                <input
                  type="radio"
                  className={styles.radio}
                  name="shipping"
                  checked={quote.shippingMethod === o.method}
                  onChange={() => void changeShipping(o.method)}
                  disabled={busy || switchingShipping}
                />
                <span className={styles.shippingLabel}>
                  {o.label}
                  <span className={styles.shippingDays}>
                    {o.minDays === o.maxDays ? o.minDays : `${o.minDays}–${o.maxDays}`} {t.businessDays}
                  </span>
                </span>
                <span className={o.amountMinor === 0 ? styles.shippingFree : styles.shippingPrice}>
                  {o.amountMinor === 0 ? t.free : money(o.amountMinor)}
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{t.payment}</h2>
        <p className={styles.secure}>{t.paymentSecure}</p>
        <PaymentElement
          options={{
            layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false },
          }}
        />
      </section>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.mobileTotal}>
        {firstImage ? (
          <div className={styles.mobileTotalThumb}>
            <img src={firstImage} alt="" />
          </div>
        ) : null}
        <div className={styles.mobileTotalText}>
          <strong>{view.billing ? st.firstPayment : t.total}</strong>
          <span>{itemCount === 1 ? t.itemOne : t.itemMany.replace('{count}', String(itemCount))}</span>
        </div>
        <button type="button" className={styles.mobileTotalValue} onClick={openMobileSummary} aria-label={t.orderSummary}>
          <span className={styles.currencyPill}>{view.currency}</span>
          <strong>{money(quote.totalMinor)}</strong>
          <ChevronIcon />
        </button>
      </div>

      <button type="button" className={styles.payButton} onClick={() => void pay()} disabled={busy || !stripe}>
        {busy ? t.processing : t.payNow}
      </button>
    </>
  );
}
