// Story 0.6 (QA F8) — erro inesperado nas rotas de publicação vira JSON
// `{ ok, code, message, retryable }` em pt-BR (nunca 500 sem corpo). O detalhe
// técnico só vai para o log, sem dados sensíveis.

import { NextResponse } from 'next/server';

export function internalError(route: string, err: unknown): NextResponse {
  console.error(
    JSON.stringify({
      event: 'PUBLISH_INTERNAL',
      route,
      error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown_error',
    }),
  );
  return NextResponse.json(
    {
      ok: false,
      code: 'PUBLISH_INTERNAL',
      retryable: true,
      message:
        'Erro inesperado no servidor ao processar a publicação. Nada foi marcado como publicado — tente de novo em instantes; se persistir, avise o suporte.',
    },
    { status: 500 },
  );
}
