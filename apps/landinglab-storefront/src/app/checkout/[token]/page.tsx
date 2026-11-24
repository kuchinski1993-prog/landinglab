// Checkout Stripe da LandingLab (Story 15.3).
import { checkoutStrings } from '@blackshop/payments/checkout-i18n';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import styles from '../checkout.module.css';
import { headerBrandOf } from '../brand';
import { CheckoutHeader } from '../CheckoutShell';

import CheckoutClient from './CheckoutClient';

import { fetchCheckoutView } from '@/lib/checkout-api';
import { fetchPublishedPolicies, requestContext } from '@/lib/post-sale-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
};

export default async function CheckoutPage({ params }: { params: { token: string } }): Promise<JSX.Element> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(params.token)) notFound();
  // QA 15.3 PERF-002: IP do cliente → rate-limit da API por cliente, não por IP do storefront.
  const ctx = requestContext(headers());
  const view = await fetchCheckoutView(params.token, ctx);
  if (!view) notFound();
  if (view.status === 'paid') redirect(`/checkout/${params.token}/done`);

  if (view.status === 'expired') {
    const t = checkoutStrings(view.locale);
    return (
      <div className={styles.page}>
        <CheckoutHeader brand={headerBrandOf(view)} />
        <div className={styles.center}>
          <p>{t.errorExpired}</p>
        </div>
      </div>
    );
  }

  // Story 15.4 (AC13): rodapé só com as políticas publicadas do mercado da landing.
  const { policies } = await fetchPublishedPolicies(ctx, view.landingPageId);
  return <CheckoutClient token={params.token} view={view} policies={policies} />;
}
