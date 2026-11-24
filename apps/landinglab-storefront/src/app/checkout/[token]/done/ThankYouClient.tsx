'use client';

import type { CheckoutStrings } from '@blackshop/payments/checkout-i18n';
import { useEffect } from 'react';


import styles from '../../checkout.module.css';
import type { HeaderBrand } from '../../brand';
import { CheckoutShell } from '../../CheckoutShell';
import { formatMinor, minorDigits } from '../../money';
import { OrderSummary } from '../../OrderSummary';

import { CONSENT_COOKIE } from '@/lib/consent-banner';
import type { CheckoutItem, QuoteView } from '@/lib/checkout-api';

interface Props {
  /** Story 15.7: marca do header (logo ou nome). */
  brand?: HeaderBrand | null;
  token: string;
  paid: boolean;
  orderNumber: string | null;
  t: CheckoutStrings;
  locale: string;
  currency: string;
  totalMinor: number;
  items: CheckoutItem[];
  quote: QuoteView;
  pixel: { pixelId: string; eventId: string } | null;
}

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...a: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown };

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

function loadPixel(pixelId: string): Fbq {
  if (!window.fbq) {
    const fbq: Fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue!.push(args);
    } as Fbq;
    fbq.queue = [];
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.push = fbq;
    window.fbq = fbq;
    window._fbq = fbq;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(s);
    fbq('init', pixelId);
  }
  return window.fbq;
}

export default function ThankYouClient(props: Props): JSX.Element {
  const { t, paid } = props;

  // Ainda confirmando (webhook/redirect): recarrega algumas vezes.
  useEffect(() => {
    if (paid) return;
    const tries = Number(sessionStorage.getItem(`ll-done-${props.token}`) ?? '0');
    if (tries >= 10) return;
    const timer = setTimeout(() => {
      sessionStorage.setItem(`ll-done-${props.token}`, String(tries + 1));
      window.location.reload();
    }, 3000);
    return () => clearTimeout(timer);
  }, [paid, props.token]);

  // Purchase no Pixel — uma vez por pedido, mesmo eventID do CAPI.
  useEffect(() => {
    if (!paid || !props.pixel) return;
    // Pixel no navegador só com o consentimento do banner da landing (mesmo host).
    if (!new RegExp(`(?:^|; )${CONSENT_COOKIE}=granted`).test(document.cookie)) return;
    const key = `ll-purchase-${props.pixel.eventId}`;
    if (localStorage.getItem(key)) return;
    const fbq = loadPixel(props.pixel.pixelId);
    const item = props.items[0];
    fbq(
      'track',
      'Purchase',
      {
        value: props.totalMinor / Math.pow(10, minorDigits(props.currency)),
        currency: props.currency,
        content_name: item?.title,
        content_type: 'product',
        num_items: item?.quantity ?? 1,
      },
      { eventID: props.pixel.eventId },
    );
    localStorage.setItem(key, '1');
  }, [paid, props.pixel, props.items, props.totalMinor, props.currency]);

  // Story 15.7: mesma moldura Shopify do checkout (header + resumo à direita).
  const summary = (
    <OrderSummary
      items={props.items}
      quote={props.quote}
      currency={props.currency}
      locale={props.locale}
      t={t}
      shippingKnown
    />
  );

  return (
    <CheckoutShell
      summary={summary}
      summaryLabel={t.orderSummary}
      summaryTotal={formatMinor(props.quote.totalMinor, props.currency, props.locale)}
      brand={props.brand ?? null}
    >
      {paid ? (
        <>
          <div className={styles.thanksHead}>
            <span className={styles.thanksIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
                <path d="m6.5 12.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              {props.orderNumber && (
                <p className={styles.thanksOrder}>
                  {t.thankYouOrder} #{props.orderNumber}
                </p>
              )}
              <h1 className={styles.thanksTitle}>{t.thankYouTitle}</h1>
            </div>
          </div>
          <div className={styles.thanksCard}>
            <p>{t.thankYouBody}</p>
          </div>
        </>
      ) : (
        <div className={styles.thanksCard}>
          <p>{t.thankYouPending}</p>
        </div>
      )}
    </CheckoutShell>
  );
}
