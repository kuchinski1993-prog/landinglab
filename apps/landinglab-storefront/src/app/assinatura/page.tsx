// Gestão da assinatura (Story 15.6, AC11): nº do pedido + e-mail (mesma
// verificação do /rastreio) geram um link assinado novo → Customer Portal.
// Idioma = idioma do mercado da landing servida neste host (it + fallback en).
import { subscriptionStrings } from '@blackshop/payments/subscription-i18n';
import type { Metadata } from 'next';
import { headers } from 'next/headers';

import SubscriptionClient from './SubscriptionClient';

import { fetchPublishedPolicies, requestContext } from '@/lib/post-sale-api';

export const dynamic = 'force-dynamic';

async function marketLocale(): Promise<string | null> {
  const { locale } = await fetchPublishedPolicies(requestContext(headers()));
  return locale;
}

export async function generateMetadata(): Promise<Metadata> {
  return { title: subscriptionStrings(await marketLocale()).manageTitle, robots: { index: false, follow: false } };
}

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: { order?: string | string[]; e?: string | string[] };
}): Promise<JSX.Element> {
  const locale = await marketLocale();
  const lang = (locale ?? '').slice(0, 2).toLowerCase() === 'it' ? 'it' : 'en';
  const order = typeof searchParams.order === 'string' ? searchParams.order.slice(0, 40) : '';
  const e = searchParams.e === 'invalid' || searchParams.e === 'unavailable' ? searchParams.e : null;
  return <SubscriptionClient lang={lang} initialOrderNumber={order} initialError={e} />;
}
