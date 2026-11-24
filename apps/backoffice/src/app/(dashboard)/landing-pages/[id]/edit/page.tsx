// /landing-pages/[id]/edit — editor visual inline (Camada 1).
//
// UX PageFly-style: iframe full-screen da landing com overlay de edição.
// Operator clica em texto/imagem, edita inline, salva em batch.
//
// Regras invioláveis (anti-quebra de layout):
//   - Só edita textContent de nodes com data-editable-id
//   - Nunca modifica tag/atributos/classes/estilos
//   - Imagens: só troca src, herda todo o resto
//   - Edits só persistem no botão "Salvar" (batch)
//   - Reclone descarta edits (aviso claro antes)
//
// Camadas server/client:
//   - page.tsx (aqui): server, carrega landing e passa pro client
//   - EditorClient: iframe + toolbar + postMessage handlers
//   - preview/route.ts?edit=1: injeta CSS/JS de overlay dentro do iframe
//   - /api/landing-pages/[id]/edit-inline: PATCH batch de edits

import { notFound } from 'next/navigation';

import EditorClient from './EditorClient';
import { getLandingPage } from '@/lib/landing-actions';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Props {
  params: { id: string };
}

export default async function LandingPageInlineEditor({
  params,
}: Props): Promise<JSX.Element> {
  requireSession(`/landing-pages/${params.id}/edit`);
  const landing = await getLandingPage(params.id);
  if (!landing) notFound();

  return (
    <EditorClient
      landingId={landing.id}
      landingTitle={landing.title}
    />
  );
}
