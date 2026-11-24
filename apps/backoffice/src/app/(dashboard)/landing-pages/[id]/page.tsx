// /landing-pages/[id] — Redireciona pro novo Editor Panel (Wave A, set/2026).
//
// Refactor: antes carregava EditClient com EditWorkspace (5 abas: Progresso ·
// Copy · Visual · Config · Publicar). Agora usa painel plano com seções
// independentes (/editor).
//
// Wave A substitui como UX principal. EditWorkspace/wizard-v2 permanecem no
// código pra fallback (rotas /edit e /wizard-v2/[step] continuam acessíveis
// direto), mas nenhum link do UI aponta pra eles.

import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
// Story 0.6 (QA F5): a server action publishLandingPage roda neste segmento —
// Vercel (2 × 7 s) + sondagem HTTPS (≈ 9 s) precisam de até ~23 s.
export const maxDuration = 30;

interface Props {
  params: { id: string };
}

export default function LandingPageRedirect({ params }: Props): never {
  redirect(`/landing-pages/${params.id}/editor`);
}
