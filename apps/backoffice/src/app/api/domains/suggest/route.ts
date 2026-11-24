// POST /api/domains/suggest
//
// Recebe { base: string, tlds?: string[] } e retorna disponibilidade + preço
// dos domínios sugeridos usando Spaceship API (checkAvailability).
//
// Usado pelo modal "Comprar novo domínio" pra o usuário ver quais estão
// disponíveis antes de comprar.

import { createSpaceshipClient } from '@blackshop/landinglab-deploy';
import { NextResponse } from 'next/server';

import { buildRateLimitResponse, getClientIdentity, rateLimit } from '@/lib/rate-limit';
import { requireVerifiedApiSession } from '@/lib/session';
export const runtime = 'nodejs';
export const maxDuration = 30;

const DEFAULT_TLDS = ['.com', '.click', '.store', '.online', '.co', '.shop', '.net'];

interface SuggestBody {
  base?: string;
  tlds?: string[];
}

interface SuggestionResult {
  domain: string;
  available: boolean;
  priceUsd: number | null;
  error?: string;
}

export async function POST(req: Request): Promise<Response> {
  // Épico 0 · 0.1 — sessão verificada na API (não basta o cookie existir).
  const authError = await requireVerifiedApiSession(req);
  if (authError) return authError;

  // Rate limit: 30 sugestões/minuto — modal digitando rápido pode disparar
  // várias, mas 30/min cobre uso legítimo e barra brute-force da Spaceship API.
  const rl = await rateLimit(`domain-suggest:${getClientIdentity(req)}`, 30, 60 * 1000);
  if (!rl.ok) return buildRateLimitResponse(rl.resetAt);

  let body: SuggestBody;
  try {
    body = (await req.json()) as SuggestBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const base = body.base?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') ?? '';
  if (!base || base.length < 3) {
    return NextResponse.json(
      { ok: false, message: 'Nome base precisa ter no mínimo 3 caracteres alfanuméricos.' },
      { status: 400 },
    );
  }

  const tlds = (body.tlds && body.tlds.length > 0 ? body.tlds : DEFAULT_TLDS).map(
    (t) => (t.startsWith('.') ? t : `.${t}`),
  );

  const client = createSpaceshipClient();

  // Checa em paralelo — Spaceship lida bem com ~10 requests concorrentes.
  const results = await Promise.all(
    tlds.map<Promise<SuggestionResult>>(async (tld) => {
      const domain = `${base}${tld}`;
      try {
        const check = await client.checkAvailability(domain);
        return {
          domain,
          available: check.available,
          priceUsd: check.price ?? null,
        };
      } catch (err) {
        return {
          domain,
          available: false,
          priceUsd: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return NextResponse.json({ ok: true, suggestions: results });
}
