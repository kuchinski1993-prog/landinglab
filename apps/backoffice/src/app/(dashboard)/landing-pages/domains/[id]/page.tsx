// Server component — fetch domain + bindings.
// Client component (DomainDetailClient) trata form de nickname/tags + bindings.

import { notFound } from 'next/navigation';

import { getDomain } from '@/lib/domain-actions';
import { requireSession } from '@/lib/session';

import DomainDetailClient from './DomainDetailClient';

export const dynamic = 'force-dynamic';

interface Props {
  params: { id: string };
}

export default async function DomainDetailPage({ params }: Props): Promise<JSX.Element> {
  requireSession(`/landing-pages/domains/${params.id}`);
  const result = await getDomain(params.id);
  if (!result) notFound();
  return <DomainDetailClient domain={result.domain} bindings={result.bindings} />;
}
