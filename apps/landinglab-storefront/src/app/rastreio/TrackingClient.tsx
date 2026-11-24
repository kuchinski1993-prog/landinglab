'use client';

// Formulário + resultado do /rastreio (Story 15.4, AC10).
// Mostra só o que a API pública devolve: status, eventos visíveis e rastreio
// real. Sem código: estado honesto, sem data prometida.

import { subscriptionStrings } from '@blackshop/payments/subscription-i18n';
import { useState, type FormEvent } from 'react';

import styles from '../post-sale.module.css';

import type { PublicOrderView } from '@/lib/post-sale-api';
import { trackingStrings } from '@/lib/post-sale-i18n';
import { buildTrackingDisplay } from '@/lib/tracking-view';

interface Props {
  lang: string;
  formatLocale: string;
  initialOrderNumber: string;
}

export default function TrackingClient({ lang, formatLocale, initialOrderNumber }: Props): JSX.Element {
  const t = trackingStrings(lang);
  const st = subscriptionStrings(lang);
  const [orderNumber, setOrderNumber] = useState(initialOrderNumber);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<PublicOrderView | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ll-tracking', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderNumber, email }),
      });
      const data = (await res.json().catch(() => ({}))) as { order?: PublicOrderView };
      if (res.ok && data.order) {
        setOrder(data.order);
        return;
      }
      setError(res.status === 404 ? t.notFound : res.status === 429 ? t.rateLimited : t.errorGeneric);
    } catch {
      setError(t.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  const view = order ? buildTrackingDisplay(order, t, formatLocale) : null;

  return (
    <div className={styles.page} lang={lang}>
      <main className={styles.container}>
        <h1 className={styles.title}>{t.title}</h1>

        {!view && (
          <>
            <p className={styles.intro}>{t.intro}</p>
            <form className={styles.form} onSubmit={(e) => void submit(e)}>
              <label className={styles.field}>
                {t.orderNumber}
                <input
                  className={styles.input}
                  name="orderNumber"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  required
                  maxLength={40}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </label>
              <label className={styles.field}>
                {t.email}
                <input
                  className={styles.input}
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  maxLength={254}
                  autoComplete="email"
                />
              </label>
              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}
              <button type="submit" className={styles.button} disabled={busy}>
                {busy ? t.searching : t.submit}
              </button>
            </form>
          </>
        )}

        {view && (
          <>
            <section className={styles.card} aria-live="polite">
              <div className={styles.cardHead}>
                <span className={styles.orderNumber}>
                  {t.order} {view.orderNumber}
                </span>
                {view.placedAt && (
                  <span className={styles.muted}>
                    {t.placedOn} {view.placedAt}
                  </span>
                )}
              </div>
              <span className={styles.statusBadge}>
                {t.status}: {view.statusLabel}
              </span>
              {view.statusNote && <p className={styles.note}>{view.statusNote}</p>}
            </section>

            {view.subscription && (
              <section className={styles.card}>
                <span className={styles.statusBadge}>{st.badge}</span>
                <p className={styles.note}>{view.subscription.recurring}</p>
                {view.subscription.managePath && (
                  <a className={styles.trackLink} href={view.subscription.managePath} rel="nofollow">
                    {st.manage} →
                  </a>
                )}
              </section>
            )}

            {(view.tracking || view.awaitingTracking) && (
              <section className={styles.card}>
                <h2 className={styles.sectionTitle}>{t.shipment}</h2>
                {view.tracking ? (
                  <>
                    <dl className={styles.kv}>
                      <dt>{t.carrier}</dt>
                      <dd>{view.tracking.carrier}</dd>
                      <dt>{t.trackingCode}</dt>
                      <dd className={styles.code}>{view.tracking.code}</dd>
                    </dl>
                    {view.tracking.url && (
                      <a
                        className={styles.trackLink}
                        href={view.tracking.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                      >
                        {t.trackOnCarrier} →
                      </a>
                    )}
                  </>
                ) : (
                  <p className={styles.note} style={{ marginTop: 0 }}>
                    {t.noTrackingYet}
                  </p>
                )}
              </section>
            )}

            {view.timeline.length > 0 && (
              <section className={styles.card}>
                <h2 className={styles.sectionTitle}>{t.history}</h2>
                <ol className={styles.timeline}>
                  {view.timeline.map((row) => (
                    <li key={row.key} className={styles.timelineItem}>
                      <strong>{row.label}</strong>
                      {row.at && <span className={styles.timelineDetail}>{row.at}</span>}
                      {row.detail && <span className={styles.timelineDetail}>{row.detail}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setOrder(null);
                setError(null);
              }}
            >
              {t.trackAnother}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
