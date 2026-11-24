// Página de obrigado do checkout Stripe (Story 15.3).
// Confirma o PaymentIntent no servidor (cria o pedido se o webhook ainda
// não chegou) e mostra o número do pedido. Purchase no Pixel com o mesmo
// eventID enviado pelo CAPI.
import { checkoutStrings } from '@blackshop/payments/checkout-i18n';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { headerBrandOf } from '../../brand';

import ThankYouClient from './ThankYouClient';

import { confirmCheckout, fetchCheckoutView } from '@/lib/checkout-api';
import { requestContext } from '@/lib/post-sale-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Order',
  robots: { index: false, follow: false },
};

export default async function DonePage({ params }: { params: { token: string } }): Promise<JSX.Element> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(params.token)) notFound();
  // QA 15.3 PERF-002: IP do cliente nas duas chamadas (rate-limit por cliente).
  const ctx = requestContext(headers());
  await confirmCheckout(params.token, ctx).catch(() => null);
  const view = await fetchCheckoutView(params.token, ctx);
  if (!view) notFound();
  const t = checkoutStrings(view.locale);

  return (
    <ThankYouClient
      token={params.token}
      brand={headerBrandOf(view)}
      paid={view.status === 'paid'}
      orderNumber={view.orderNumber}
      t={t}
      locale={view.locale}
      currency={view.currency}
      totalMinor={view.quote.totalMinor}
      items={view.items}
      quote={view.quote}
      pixel={view.pixelId ? { pixelId: view.pixelId, eventId: view.metaEventId } : null}
    />
  );
}
