// Página pública de rastreio (Story 15.4, AC10).
// Idioma = idioma do mercado da landing servida neste host (fallback en).
// A consulta acontece no cliente via proxy same-origin /api/ll-tracking.
import type { Metadata } from 'next';
import { headers } from 'next/headers';

import TrackingClient from './TrackingClient';

import { fetchPublishedPolicies, requestContext } from '@/lib/post-sale-api';
import { trackingLocale, trackingStrings } from '@/lib/post-sale-i18n';

export const dynamic = 'force-dynamic';

async function marketLocale(): Promise<string | null> {
  const { locale } = await fetchPublishedPolicies(requestContext(headers()));
  return locale;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = trackingStrings(await marketLocale());
  return { title: t.title, robots: { index: false, follow: false } };
}

export default async function TrackingPage({
  searchParams,
}: {
  searchParams: { order?: string | string[] };
}): Promise<JSX.Element> {
  const locale = await marketLocale();
  const lang = trackingLocale(locale);
  // Datas no formato regional do mercado (ex.: it-IT) quando o idioma tem texto.
  const formatLocale = locale && locale.slice(0, 2).toLowerCase() === lang ? locale : lang;
  const order = typeof searchParams.order === 'string' ? searchParams.order.slice(0, 40) : '';
  return <TrackingClient lang={lang} formatLocale={formatLocale} initialOrderNumber={order} />;
}
