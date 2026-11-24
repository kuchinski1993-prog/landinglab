import type { CheckoutStrings } from '@blackshop/payments/checkout-i18n';
import { formatInterval, subscriptionStrings } from '@blackshop/payments/subscription-i18n';

import type { BillingView, CheckoutItem, QuoteView } from '@/lib/checkout-api';

import styles from './checkout.module.css';
import { formatMinor } from './money';

/** Quadro neutro do item sem imagem enviada (Story 15.7). */
function ProductPlaceholder(): JSX.Element {
  return (
    <span className={styles.thumbPlaceholder} data-ll-thumb-placeholder aria-hidden="true">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
        <path
          d="M5.5 8.5h13l-.9 10.4a2 2 0 0 1-2 1.8H8.4a2 2 0 0 1-2-1.8L5.5 8.5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

interface Props {
  items: CheckoutItem[];
  quote: QuoteView;
  currency: string;
  locale: string;
  t: CheckoutStrings;
  shippingKnown: boolean;
  /** Story 15.6: assinatura — recorrência, desconto e "frete só na 1ª" (sem datas). */
  billing?: BillingView | null;
}

export function OrderSummary({ items, quote, currency, locale, t, shippingKnown, billing }: Props): JSX.Element {
  const money = (minor: number) => formatMinor(minor, currency, locale);
  const st = subscriptionStrings(locale);
  return (
    <div className={styles.summary}>
      {items.map((item, i) => (
        <div key={i} className={styles.item}>
          <div className={styles.thumb}>
            {item.image ? <img src={item.image} alt={item.title} /> : <ProductPlaceholder />}
            <span className={styles.badge}>{item.quantity}</span>
          </div>
          <div className={styles.itemText}>
            <p className={styles.itemTitle}>{item.title}</p>
            {item.unitLabel ? <p className={styles.itemSub}>{item.unitLabel}</p> : null}
          </div>
          <div className={styles.itemPrice}>
            {item.compareAtMinor && item.compareAtMinor > item.priceMinor ? (
              <span className={styles.compareAt}>{money(item.compareAtMinor)}</span>
            ) : null}
            {money(item.priceMinor)}
          </div>
        </div>
      ))}
      <div className={styles.totals}>
        <div className={styles.totalRow}>
          <span>{t.subtotal}</span>
          <span>{money(quote.subtotalMinor)}</span>
        </div>
        <div className={styles.totalRow}>
          <span>{t.shipping}</span>
          {!shippingKnown ? (
            <span className={styles.muted}>{t.shippingEnterAddress}</span>
          ) : (
            <span>{quote.shippingMinor === 0 ? t.free : money(quote.shippingMinor)}</span>
          )}
        </div>
        <div className={styles.grandTotal}>
          <strong>{billing ? st.firstPayment : t.total}</strong>
          <span className={styles.grandTotalValue}>
            <span className={styles.currencyCode}>{currency}</span>
            <strong>{money(quote.totalMinor)}</strong>
          </span>
        </div>
        {billing ? (
          <div className={styles.subscriptionNote} data-ll-subscription-summary>
            <div className={styles.totalRow}>
              <span>
                <strong>{st.badge}</strong> · {st.recurring}
              </span>
              <span>
                {money(billing.unitAmountMinor)} {formatInterval(billing.interval, billing.intervalCount, locale)}
              </span>
            </div>
            {quote.shippingMinor > 0 || shippingKnown ? <p className={styles.itemSub}>{st.shippingFirstOnly}</p> : null}
            {billing.discountPercent > 0 ? <p className={styles.itemSub}>{st.discountAllInvoices}</p> : null}
            <p className={styles.itemSub}>{st.cancelAnytime}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
