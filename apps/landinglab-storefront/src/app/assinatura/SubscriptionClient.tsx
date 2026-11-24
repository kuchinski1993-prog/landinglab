'use client';

// Formulário da página /assinatura (Story 15.6, AC11). Não mostra dados da
// assinatura: só gera o link e segue para o Customer Portal (cancelar, trocar
// cartão e ver faturas são feitos lá — exigência UE).

import { subscriptionStrings } from '@blackshop/payments/subscription-i18n';
import { useState, type FormEvent } from 'react';

import styles from '../post-sale.module.css';

import { trackingStrings } from '@/lib/post-sale-i18n';

interface Props {
  lang: string;
  initialOrderNumber: string;
  initialError: 'invalid' | 'unavailable' | null;
}

export default function SubscriptionClient({ lang, initialOrderNumber, initialError }: Props): JSX.Element {
  const t = subscriptionStrings(lang);
  const tt = trackingStrings(lang);
  const [orderNumber, setOrderNumber] = useState(initialOrderNumber);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    initialError === 'invalid' ? t.manageLinkInvalid : initialError === 'unavailable' ? t.manageUnavailable : null,
  );

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ll-subscription-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderNumber, email }),
      });
      const data = (await res.json().catch(() => ({}))) as { path?: string };
      if (res.ok && data.path) {
        window.location.assign(data.path);
        return;
      }
      setError(res.status === 404 ? t.manageNotFound : res.status === 429 ? tt.rateLimited : t.manageUnavailable);
    } catch {
      setError(t.manageUnavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page} lang={lang}>
      <main className={styles.container}>
        <h1 className={styles.title}>{t.manageTitle}</h1>
        <p className={styles.intro}>{t.manageIntro}</p>
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
            {busy ? tt.searching : t.manageSubmit}
          </button>
        </form>
      </main>
    </div>
  );
}
