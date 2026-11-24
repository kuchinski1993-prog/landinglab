// /landing-pages/[id]/editor — Novo painel de edição (Wave A).
// Substitui wizard-v2 como UX principal pós-clone.
//
// Server component: busca landing via getLandingPage e passa pro EditorPanel client.

import { notFound } from 'next/navigation';

import { getLandingPage } from '@/lib/landing-actions';
import { requireSession } from '@/lib/session';

import EditorPanel from './EditorPanel';

export const dynamic = 'force-dynamic';
// Story 0.6 (QA F5): a server action publishLandingPage roda neste segmento —
// Vercel (2 × 7 s) + sondagem HTTPS (≈ 9 s) precisam de até ~23 s.
export const maxDuration = 30;

interface Props {
  params: { id: string };
}

export default async function EditorPage({ params }: Props): Promise<JSX.Element> {
  requireSession(`/landing-pages/${params.id}/editor`);
  const row = await getLandingPage(params.id);
  if (!row) notFound();
  return <EditorPanel landing={row} />;
}
