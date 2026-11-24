// Story 13.10 (AC3) — contexto de nomes da landing para sugestões de domínio:
// produto/marca de destino, idioma/mercado e marca/URL de origem do clone.

import { landingMarkets, landingPages } from '@blackshop/db';
import { eq } from 'drizzle-orm';

import type { NamingContext } from './domain-names';

import { getDb } from '@/lib/landing-db';

function firstLanguage(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const lang = v?.trim().slice(0, 2).toLowerCase();
    if (lang && /^[a-z]{2}$/.test(lang)) return lang;
  }
  return null;
}

/** `null` = landing não encontrada. */
export async function loadLandingNamingContext(landingPageId: string): Promise<NamingContext | null> {
  const rows = await getDb()
    .select({
      title: landingPages.title,
      brandFrom: landingPages.brandFrom,
      brandTo: landingPages.brandTo,
      checkoutProductName: landingPages.checkoutProductName,
      sourceUrl: landingPages.sourceUrl,
      contentLanguage: landingPages.contentLanguage,
      targetLanguage: landingPages.targetLanguage,
      initialTargetLanguage: landingPages.initialTargetLanguage,
      locale: landingPages.locale,
      marketLocale: landingMarkets.locale,
    })
    .from(landingPages)
    .leftJoin(landingMarkets, eq(landingMarkets.id, landingPages.marketId))
    .where(eq(landingPages.id, landingPageId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    productNames: [row.brandTo, row.checkoutProductName, row.title].filter(
      (n): n is string => typeof n === 'string' && n.trim() !== '',
    ),
    language: firstLanguage(
      row.marketLocale,
      row.contentLanguage,
      row.targetLanguage,
      row.initialTargetLanguage,
      row.locale,
    ),
    sourceBrand: row.brandFrom,
    sourceUrl: row.sourceUrl,
  };
}
