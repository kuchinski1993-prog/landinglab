// POST /api/landing-pages/[id]/apply-bundle-template
//
// Aplica o BUNDLE PADRÃO LandingLab na landing clonada:
//   1. Lê wizard_state.pricing (bundles + currency + subs)
//   2. Substitui bundle block detectado (kaching-bundles-block, .cc-pdp-offer,
//      etc) pelo template LandingLab
//   3. Persiste html_body atualizado
//
// Rationale (feedback do usuário):
//   "não é para criar regras absolutas em relação a clonagem" — em vez de
//   adaptar handler pra cada tema origem, o sistema tem SEU PRÓPRIO bundle
//   standard. Isso elimina classe de bug "bundle não clicável" pra sempre.
//
// Fluxo típico no wizard:
//   Step 4 (Pricing) → salva pricing → Step 5 (Product) chama:
//     a) apply-bundle-template (aqui)  ← substitui bundle no HTML
//     b) from-clone                    ← cria produto Shopify + landing_variants
//     c) auto-bind                     ← preenche data-landing-variant-id nos slots
//
// Idempotente: se HTML já tem [data-landinglab-bundle="v1"], substitui novamente
// (permite user rodar Step 4 múltiplas vezes ajustando valores).

import { landingPages } from '@blackshop/db/schema-landinglab-core';
import { injectLandinglabBundle } from '@blackshop/landinglab-cloner';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

const STORE_ID = 'l0i';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface Ctx {
  params: { id: string };
}

interface PricingBundle {
  name: string;
  description?: string | undefined;
  priceCents: number;
  compareAtPriceCents: number | null;
  quantityUnits: number | null;
  highlight?: 'popular' | 'best' | null | undefined;
}

interface PricingSubs {
  enabled: boolean;
  sellingPlanId: string | null;
  discountPct: number;
}

interface PricingState {
  currency: string;
  bundles: PricingBundle[];
  subs?: PricingSubs;
}

// Remove versão anterior do bundle LandingLab (idempotência ao reaplicar).
function stripPreviousLandinglabBundle(html: string): string {
  let out = html;
  // Remove <style data-landinglab-bundle-styles>
  out = out.replace(/<style\b[^>]*data-landinglab-bundle-styles[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove <div data-landinglab-bundle="v1">...</div>
  // Usa contador de tags pra evitar match greedy quebrado.
  const openRx = /<div\b[^>]*data-landinglab-bundle="v1"[^>]*>/i;
  const openMatch = openRx.exec(out);
  if (openMatch) {
    const openIdx = openMatch.index;
    const afterOpen = openIdx + openMatch[0].length;
    // Balanceamento simples: procura </div> correspondente
    let depth = 1;
    const cursor = afterOpen;
    const tagRx = /<\/?div\b[^>]*>/gi;
    tagRx.lastIndex = cursor;
    let m: RegExpExecArray | null;
    while ((m = tagRx.exec(out)) !== null) {
      if (m[0].startsWith('</')) depth--;
      else depth++;
      if (depth === 0) {
        const closeEnd = m.index + m[0].length;
        out = out.slice(0, openIdx) + out.slice(closeEnd);
        break;
      }
    }
  }
  // Remove <script data-landinglab-bundle-runtime>...</script>
  out = out.replace(/<script\b[^>]*data-landinglab-bundle-runtime[^>]*>[\s\S]*?<\/script>/gi, '');
  return out;
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const db = getDb();
  const [row] = await db
    .select({
      htmlBody: landingPages.htmlBody,
      wizardState: landingPages.wizardState,
      targetLanguage: landingPages.targetLanguage,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  if (!row) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }
  if (!row.htmlBody) {
    return NextResponse.json({ ok: false, message: 'Landing sem HTML' }, { status: 400 });
  }

  const wizardState = (row.wizardState ?? {}) as Record<string, unknown>;
  const pricing = wizardState['pricing'] as PricingState | undefined;
  if (!pricing || !Array.isArray(pricing.bundles) || pricing.bundles.length === 0) {
    return NextResponse.json(
      { ok: false, message: 'wizard_state.pricing.bundles vazio. Rode Step 4 primeiro.' },
      { status: 400 },
    );
  }

  // Locale = target language (fallback en). O bundle template usa pra rótulos.
  const locale = row.targetLanguage ?? 'en';

  const cleanHtml = stripPreviousLandinglabBundle(row.htmlBody);
  const config = {
    bundles: pricing.bundles,
    currency: pricing.currency,
    subs: pricing.subs,
    locale,
  };
  const result = injectLandinglabBundle(cleanHtml, config);

  await db
    .update(landingPages)
    .set({
      htmlBody: result.html,
      updatedAt: new Date(),
    })
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)));

  return NextResponse.json({
    ok: true,
    replaced: result.replaced,
    strategy: result.strategy,
    slotsInjected: pricing.bundles.length,
    subsEnabled: pricing.subs?.enabled ?? false,
    message: `Bundle padrão aplicado (${result.strategy}). ${pricing.bundles.length} slot(s) injetados.`,
  });
}
