'use server';

// Server actions do modo Autopilot (Story 13.3, AC6).
//
// Fluxo:
//   1. Valida input (source_type + url/image + language)
//   2. Insere landing_page (generation_mode='autopilot', status='draft')
//   3. Enfileira job `landinglab.squad1.research` no BullMQ
//
// Diferente das actions "manuais" (landing-actions.ts), o autopilot NÃO exige
// título/HTML — esses vêm do LandingLab Squad 2 (Copy) após o PIR pronto.
// Pra respeitar constraints não-null do banco (title, htmlBody, price, currency),
// gravamos placeholders informativos que o worker substituirá.

import { revalidatePath } from 'next/cache';
import { landingPages } from '@blackshop/db/schema-landinglab-core';

import { enqueueJob } from '@/lib/api-queue';
import { getDb } from '@/lib/landing-db';

// STORE_ID immutable — retained for DB compatibility with rows created before
// rename (Story 13.7). Same policy as migrations 0045/0046 filenames.
const STORE_ID = 'l0i';
const AUTOPILOT_QUEUE = 'landinglab.squad1.research';
const AUTOPILOT_JOB_NAME = 'ProductResearchJob';

export type AutopilotSourceType = 'aliexpress_link' | 'photo_upload' | 'other_url';
export type AutopilotLanguage = 'de' | 'it' | 'en' | 'es' | 'fr';

const SOURCE_TYPES: readonly AutopilotSourceType[] = [
  'aliexpress_link',
  'photo_upload',
  'other_url',
] as const;
const LANGUAGES: readonly AutopilotLanguage[] = ['de', 'it', 'en', 'es', 'fr'] as const;

export interface AutopilotInput {
  sourceType: AutopilotSourceType;
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  targetLanguage: AutopilotLanguage;
  /**
   * Multi-language selection for Squad 2 (Copy). EN sempre incluso; extras opcionais.
   * Story 13.4 AC17/AC22. Se ausente/vazio, defaults to [targetLanguage] com EN
   * garantido pelo server (Copy processor normaliza).
   */
  targetLanguages?: AutopilotLanguage[];
  hint: string | null;
}

export type AutopilotResult =
  | { ok: true; data: { id: string } }
  | { ok: false; code: 'validation' | 'enqueue_failed' | 'unknown'; message: string };

function validate(input: AutopilotInput): { ok: true } | { ok: false; message: string } {
  if (!SOURCE_TYPES.includes(input.sourceType)) {
    return { ok: false, message: 'Tipo de fonte inválido.' };
  }
  if (!LANGUAGES.includes(input.targetLanguage)) {
    return { ok: false, message: 'Idioma-alvo inválido.' };
  }
  // photo_upload requer image; os outros dois requerem URL.
  if (input.sourceType === 'photo_upload') {
    if (!input.sourceImageUrl || !input.sourceImageUrl.trim()) {
      return { ok: false, message: 'URL da foto do produto é obrigatória.' };
    }
    if (!/^https?:\/\//.test(input.sourceImageUrl)) {
      return { ok: false, message: 'URL da imagem deve começar com http(s).' };
    }
  } else {
    if (!input.sourceUrl || !input.sourceUrl.trim()) {
      return { ok: false, message: 'URL do produto é obrigatória.' };
    }
    if (!/^https?:\/\//.test(input.sourceUrl)) {
      return { ok: false, message: 'URL deve começar com http(s).' };
    }
  }
  if (input.hint && input.hint.length > 500) {
    return { ok: false, message: 'Hint deve ter no máximo 500 caracteres.' };
  }
  // Story 13.4 AC17: valida targetLanguages array (se enviado).
  if (input.targetLanguages) {
    for (const lang of input.targetLanguages) {
      if (!LANGUAGES.includes(lang)) {
        return { ok: false, message: `Idioma inválido em targetLanguages: ${lang}.` };
      }
    }
  }
  return { ok: true };
}

/**
 * Story 13.4 AC17: normaliza targetLanguages garantindo:
 *   - EN sempre presente.
 *   - Ordem: EN first, resto alpha.
 *   - Sem duplicatas.
 *   - Se input vazio, retorna [targetLanguage] com EN garantido.
 */
function normalizeTargetLanguages(
  targetLanguage: AutopilotLanguage,
  extra: AutopilotLanguage[] | undefined,
): AutopilotLanguage[] {
  const set = new Set<AutopilotLanguage>();
  set.add('en'); // AC17: EN sempre incluso.
  set.add(targetLanguage);
  for (const lang of extra ?? []) set.add(lang);
  const rest = Array.from(set).filter((l) => l !== 'en').sort();
  return ['en', ...rest];
}

// Slug placeholder — worker Squad 2 substitui após copy chegar. Formato garante
// unicidade (evita colisão do unique index landing_pages_store_slug).
function makeAutopilotPlaceholderSlug(): string {
  // Ex.: 'autopilot-draft-lk9x2m3q7f' — url-safe, respeita CHECK do slug.
  const rand = Math.random().toString(36).slice(2, 12);
  return `autopilot-draft-${rand}`;
}

export async function createAutopilotLandingPage(
  input: AutopilotInput,
): Promise<AutopilotResult> {
  const validation = validate(input);
  if (!validation.ok) {
    return { ok: false, code: 'validation', message: validation.message };
  }

  // Story 13.4 AC17: normaliza array de idiomas ANTES do insert.
  const targetLanguages = normalizeTargetLanguages(input.targetLanguage, input.targetLanguages);

  // Insert row (draft placeholder — worker preenche fields depois).
  let landingPageId: string;
  try {
    const db = getDb();
    const now = new Date();
    const [row] = await db
      .insert(landingPages)
      .values({
        storeId: STORE_ID,
        title: 'Autopilot draft (aguardando IA)',
        slug: makeAutopilotPlaceholderSlug(),
        status: 'draft',
        currency: 'USD', // placeholder — Copy squad decide currency por market.
        fulfillmentType: 'dropship',
        htmlBody: '<!-- generating via LandingLab Autopilot -->',
        price: '0.00',
        generationMode: 'autopilot',
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl,
        sourceImageUrl: input.sourceImageUrl,
        targetLanguage: input.targetLanguage,
        // Story 13.4 AC17: array multi-idioma (EN + extras) pra Squad 2.
        // Squad 1 continua usando `targetLanguage` singular como research language.
        targetLanguages,
        previewToken: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: landingPages.id });
    if (!row) {
      return { ok: false, code: 'unknown', message: 'Falha ao criar landing page.' };
    }
    landingPageId = row.id;
  } catch (err) {
    console.error('[autopilot/actions] insert failed', err);
    return { ok: false, code: 'unknown', message: 'Erro ao criar landing autopilot.' };
  }

  // Enqueue Squad 1 research job. Short-lived Redis connection (mesmo padrão
  // do apps/worker/src/publish-enqueue.ts — evita coupling com worker.ts).
  try {
    await enqueueResearchJob({
      landingPageId,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      sourceImageUrl: input.sourceImageUrl,
      targetLanguage: input.targetLanguage,
      hint: input.hint,
    });
  } catch (err) {
    // Insert deu certo mas enqueue falhou → landing existe em draft mas fica órfã.
    // Dono pode re-tentar clicando "Reprocessar" na UI (Story 13.4+) OU manualmente
    // enqueueing via CLI. Não deletamos o row: mantém audit trail.
    console.error('[autopilot/actions] enqueue failed', err);
    return {
      ok: false,
      code: 'enqueue_failed',
      message: 'Landing criada mas fila indisponível. Reprocesse pela lista.',
    };
  }

  revalidatePath('/landing-pages');
  revalidatePath(`/landing-pages/${landingPageId}`);
  return { ok: true, data: { id: landingPageId } };
}

interface EnqueuePayload {
  landingPageId: string;
  sourceType: AutopilotSourceType;
  sourceUrl: string | null;
  sourceImageUrl: string | null;
  targetLanguage: AutopilotLanguage;
  hint: string | null;
}

async function enqueueResearchJob(payload: EnqueuePayload): Promise<void> {
  await enqueueJob(AUTOPILOT_QUEUE, AUTOPILOT_JOB_NAME, { ...payload }, {
    jobId: `lp-research-${payload.landingPageId}`,
    attempts: 2, // synth call é caro; 2 tentativas total (evita 3 chamadas $)
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
    removeOnFail: { age: 14 * 24 * 3600 },
  });
}
