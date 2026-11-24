// Tradução de páginas G3 (F1b): extrai os blocos com o mesmo extrator da edição de textos, traduz em
// lotes com Claude (worker), o operador revisa por unidade e "aplicar" gera uma NOVA página no idioma
// (job derivado, mesmo pipeline do import). Ideias reaproveitadas da G2 (translation-*): cache por texto
// de origem, validação do lote, edição manual nunca sobrescrita — sem acoplar às tabelas legacy.
import { randomUUID } from 'node:crypto';

import type { Sql } from 'postgres';

import { vslError } from './errors.js';
import { VslPageImportJobs, type ImportJobView } from './page-import-jobs.js';
import { extractPageTextBlocks, type PageTextKind } from './page-texts.js';
import type { VslObjectStore } from './storage.js';

export const VSL_TRANSLATION_LOCALES = ['it', 'en', 'es', 'pt', 'fr', 'de', 'nl', 'pl'] as const;
export type VslTranslationLocale = (typeof VSL_TRANSLATION_LOCALES)[number];
export const VSL_TRANSLATION_DEFAULT_MAX_CHARS = 100_000;
export const VSL_TRANSLATION_DEFAULT_MODEL = 'claude-haiku-4-5';
export const TRANSLATION_LEASE_SECONDS = 300;
const LANGUAGE_NAMES: Record<string, string> = {
  it: 'Italian', en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', nl: 'Dutch', pl: 'Polish',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTranslationLocale(value: unknown): value is VslTranslationLocale {
  return typeof value === 'string' && (VSL_TRANSLATION_LOCALES as readonly string[]).includes(value);
}

/* ─────────────────────────────── Proteção de trechos que não se traduzem ─────────────────────────────── */

const PROTECTED = [
  /https?:\/\/[^\s"'<>]*[^\s"'<>.,;:!?)\]]/g, // URLs (sem a pontuação final)
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // e-mails
  /\{\{[^{}]{1,80}\}\}|\{[A-Za-z_][\w.]{0,40}\}|%(?:\d+\$)?[sdif]|\[\[[^\]]{1,80}\]\]/g, // placeholders de template
  /(?:R\$|US\$|A\$|C\$|\$|€|£|¥|CHF|zł|PLN|EUR|USD|BRL|GBP)\s?\d+(?:[.,\s]\d+)*/g, // moeda + valor
  /\d+(?:[.,]\d+)*\s?(?:€|£|zł|PLN|EUR|USD|BRL|GBP|CHF)(?![\p{L}])/gu, // valor + moeda
];

/** Troca URLs, e-mails, placeholders e preços por marcadores ⟦n⟧ que o modelo deve manter. */
export function protectSegments(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  let masked = text;
  for (const pattern of PROTECTED)
    masked = masked.replace(pattern, (match) => {
      if (/⟦\d+⟧/.test(match)) return match;
      tokens.push(match);
      return `⟦${tokens.length - 1}⟧`;
    });
  return { masked, tokens };
}

/** Restaura os marcadores; null se o modelo perdeu, duplicou ou inventou algum. */
export function restoreSegments(translated: string, tokens: string[]): string | null {
  const seen = [...translated.matchAll(/⟦(\d+)⟧/g)].map((match) => Number(match[1]));
  if (seen.length !== tokens.length || new Set(seen).size !== tokens.length || seen.some((index) => !(index in tokens))) return null;
  return translated.replace(/⟦(\d+)⟧/g, (_match, index: string) => tokens[Number(index)]!);
}

/* ─────────────────────────────── Provider ─────────────────────────────── */

export interface CopyTranslationItem { key: string; text: string; kind: PageTextKind; label: string; context: string }
export interface CopyTranslationRequest {
  sourceLocale: string | null; targetLocale: VslTranslationLocale; pageTitle: string; items: CopyTranslationItem[];
}
export interface VslCopyTranslator {
  readonly provider: string;
  readonly model: string;
  /** Devolve `{ [key]: texto traduzido }` (os marcadores ⟦n⟧ do texto de entrada devem ser mantidos). */
  translate(request: CopyTranslationRequest): Promise<Record<string, string>>;
}
export class TranslatorError extends Error {
  constructor(readonly kind: 'auth' | 'transient' | 'invalid', message: string) { super(message); }
}

export function translationSystemPrompt(sourceLocale: string | null, targetLocale: VslTranslationLocale): string {
  const source = sourceLocale ? `${LANGUAGE_NAMES[sourceLocale.slice(0, 2)] ?? sourceLocale} (${sourceLocale})` : 'the source language (detect it)';
  const target = `${LANGUAGE_NAMES[targetLocale]} (${targetLocale})`;
  return [
    `You are a senior direct-response copywriter and native ${LANGUAGE_NAMES[targetLocale]} translator.`,
    `Translate sales-page copy (VSL funnels, quizzes, checkout calls to action) from ${source} to ${target}.`,
    'Rules:',
    '- Keep the persuasive sales tone, urgency, emotion and reading level of the original. Adapt idioms so a native reader feels it was written in their language; do not translate word by word.',
    '- Keep roughly the same length; buttons and labels must stay short.',
    '- Never translate brand names, product names, people names, URLs, e-mail addresses or code.',
    '- Keep every marker like ⟦0⟧ exactly as it appears (same markers, each once).',
    '- Keep all numbers, prices, currencies, percentages, dates and units exactly as in the source; never convert currencies.',
    '- Keep emojis, line breaks and surrounding punctuation.',
    '- Do not add notes or explanations.',
    'Answer ONLY with JSON: {"t":{"<key>":"<translation>"}} containing every key you received.',
  ].join('\n');
}

/** Claude via HTTP (mesmo padrão de apps/api/src/routes/editor.routes.ts). Chave: vault `anthropic:api_key`. */
export class AnthropicCopyTranslator implements VslCopyTranslator {
  readonly provider = 'anthropic';
  constructor(private readonly apiKey: string, readonly model: string = VSL_TRANSLATION_DEFAULT_MODEL,
    private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 90_000) {}

  async translate(request: CopyTranslationRequest): Promise<Record<string, string>> {
    const body = {
      model: this.model,
      max_tokens: 8192,
      temperature: 0.3,
      system: translationSystemPrompt(request.sourceLocale, request.targetLocale),
      messages: [{ role: 'user', content: JSON.stringify({
        page: request.pageTitle,
        items: request.items.map((item) => ({ key: item.key, type: item.label, ...(item.context ? { context: item.context } : {}), text: item.text })),
      }) }],
    };
    let response: Response;
    try {
      response = await this.fetcher('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TranslatorError('transient', error instanceof Error ? error.message : 'network error');
    }
    if (response.status === 401 || response.status === 403) throw new TranslatorError('auth', `anthropic ${response.status}`);
    if (!response.ok) throw new TranslatorError(response.status === 400 ? 'invalid' : 'transient', `anthropic ${response.status}`);
    const data = await response.json().catch(() => null) as { content?: Array<{ type: string; text?: string }> } | null;
    const text = data?.content?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('') ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { t?: Record<string, unknown> };
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.t ?? {})) if (typeof value === 'string') out[key] = value;
      return out;
    } catch {
      throw new TranslatorError('transient', 'invalid JSON from model');
    }
  }
}

/** Provider determinístico para testes/dev (`VSL_TRANSLATION_PROVIDER=fake`, nunca em produção). */
export class FakeCopyTranslator implements VslCopyTranslator {
  readonly provider = 'fake';
  readonly model = 'fake-v1';
  readonly calls: CopyTranslationRequest[] = [];
  async translate(request: CopyTranslationRequest): Promise<Record<string, string>> {
    this.calls.push(request);
    return Object.fromEntries(request.items.map((item) => [item.key, `[${request.targetLocale}] ${item.text}`]));
  }
}

/* ─────────────────────────────── Serviço ─────────────────────────────── */

interface TranslationRow {
  id: string; page_id: string; source_revision_id: string; source_locale: string | null; target_locale: VslTranslationLocale;
  status: 'extracting' | 'translating' | 'review' | 'applying' | 'done' | 'failed'; progress: number; source_chars: number; units_total: number;
  provider: string | null; model: string | null; attempts: number; max_attempts: number; lease_token: string | null;
  apply_job_id: string | null; target_page_id: string | null; target_revision_id: string | null; link_step_ids: string[];
  error_code: string | null; error_message: string | null; created_at: Date; updated_at: Date; finished_at: Date | null;
}
interface UnitRow {
  id: string; translation_id: string; position: number; block_id: string; kind: PageTextKind; label: string; context: string;
  source: string; translated: string | null; status: 'pending' | 'edited' | 'approved';
}

export function translationView(row: TranslationRow) {
  return {
    id: row.id, pageId: row.page_id, sourceRevisionId: row.source_revision_id, sourceLocale: row.source_locale, targetLocale: row.target_locale,
    status: row.status, progress: row.progress, unitsTotal: row.units_total, sourceChars: row.source_chars, provider: row.provider, model: row.model,
    applyJobId: row.apply_job_id, targetPageId: row.target_page_id, targetRevisionId: row.target_revision_id,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
  };
}
export type TranslationView = ReturnType<typeof translationView>;
const unitView = (row: UnitRow) => ({ id: row.id, blockId: row.block_id, kind: row.kind, label: row.label, context: row.context,
  source: row.source, translated: row.translated, status: row.status });

export interface VslPageTranslationsOptions {
  /** Limite de caracteres de origem por tradução (custo). Default VSL_TRANSLATION_MAX_CHARS ou 100 000. */
  maxChars?: number;
  /** API: há provider configurado? (sem chave → translation_provider_unavailable). */
  providerAvailable?: () => Promise<boolean>;
  /** Worker: provider real (null = sem chave). */
  translator?: () => Promise<VslCopyTranslator | null>;
  /** Itens/caracteres por chamada ao modelo. */
  batch?: { items: number; chars: number };
  log?: { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };
}

const LETTER = /\p{L}/u;

export class VslPageTranslations {
  readonly jobs: VslPageImportJobs;
  private readonly maxChars: number;
  constructor(readonly sql: Sql, readonly storage: VslObjectStore, readonly options: VslPageTranslationsOptions = {}) {
    this.jobs = new VslPageImportJobs(sql, storage, options.log);
    const fromEnv = Number(process.env['VSL_TRANSLATION_MAX_CHARS']);
    this.maxChars = options.maxChars ?? (Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : VSL_TRANSLATION_DEFAULT_MAX_CHARS);
  }

  /** Extrai os blocos da revisão e cria a tradução (o worker traduz em lotes). */
  async create(pageId: string, input: { sourceRevisionId?: unknown; targetLocale?: unknown }, linkStepIds: string[] = []): Promise<TranslationView> {
    if (typeof input.sourceRevisionId !== 'string' || !UUID.test(input.sourceRevisionId)) throw vslError('validation_failed', { field: 'sourceRevisionId' });
    if (!isTranslationLocale(input.targetLocale)) throw vslError('validation_failed', { field: 'targetLocale', allowed: VSL_TRANSLATION_LOCALES });
    if (this.options.providerAvailable && !(await this.options.providerAvailable())) throw vslError('translation_provider_unavailable');
    const { page } = await this.jobs.revision(pageId, input.sourceRevisionId);
    const html = await this.jobs.revisionHtml(pageId, input.sourceRevisionId);
    const blocks = extractPageTextBlocks(html).filter((block) => LETTER.test(block.text));
    const chars = blocks.reduce((total, block) => total + block.text.length, 0);
    if (chars > this.maxChars) throw vslError('translation_too_large', { chars, maxChars: this.maxChars });
    const sourceLocale = page.locale ?? /<html\b[^>]*?\blang\s*=\s*["']?([A-Za-z]{2}(?:-[A-Za-z]{2})?)/i.exec(html)?.[1] ?? null;
    const id = randomUUID();
    return this.sql.begin(async (tx) => {
      const [row] = await tx<TranslationRow[]>`INSERT INTO vsl_page_translations(id,page_id,source_revision_id,source_locale,target_locale,status,progress,source_chars,units_total,link_step_ids)
        VALUES(${id},${pageId},${input.sourceRevisionId as string},${sourceLocale},${input.targetLocale as string},${blocks.length ? 'translating' : 'review'},
          ${blocks.length ? 0 : 100},${chars},${blocks.length},${tx.json(linkStepIds as never)}) RETURNING *`;
      const rows = blocks.map((block, position) => ({ translation_id: id, position, block_id: block.id, kind: block.kind, label: block.label,
        context: block.context, source: block.text }));
      for (let index = 0; index < rows.length; index += 500)
        await tx`INSERT INTO vsl_page_translation_units ${tx(rows.slice(index, index + 500), 'translation_id', 'position', 'block_id', 'kind', 'label', 'context', 'source')}`;
      return translationView(row!);
    });
  }

  private async row(id: string): Promise<TranslationRow> {
    if (!UUID.test(id)) throw vslError('translation_not_found');
    const [row] = await this.sql<TranslationRow[]>`SELECT * FROM vsl_page_translations WHERE id=${id} AND store_id='l0i'`;
    if (!row) throw vslError('translation_not_found');
    return row;
  }

  async get(id: string) {
    const row = await this.row(id);
    const units = await this.sql<UnitRow[]>`SELECT * FROM vsl_page_translation_units WHERE translation_id=${id} ORDER BY position`;
    return { translation: translationView(row), units: units.map(unitView) };
  }

  async list(pageId: string) {
    const rows = await this.sql<TranslationRow[]>`SELECT * FROM vsl_page_translations WHERE page_id=${pageId} AND store_id='l0i' ORDER BY created_at DESC LIMIT 50`;
    return rows.map(translationView);
  }

  /** Revisão manual: `translated` editado vira `edited` (a menos que venha `status`). */
  async patchUnits(id: string, input: unknown) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 5000) throw vslError('validation_failed', { field: 'units' });
    const patches = input.map((item, index) => {
      const unit = item as { id?: unknown; translated?: unknown; status?: unknown } | null;
      if (!unit || typeof unit.id !== 'string' || !UUID.test(unit.id) ||
        (unit.translated !== undefined && (typeof unit.translated !== 'string' || unit.translated.length > 20_000)) ||
        (unit.status !== undefined && !['pending', 'edited', 'approved'].includes(unit.status as string)) ||
        (unit.translated === undefined && unit.status === undefined))
        throw vslError('validation_failed', { field: `units[${index}]` });
      return unit as { id: string; translated?: string; status?: UnitRow['status'] };
    });
    if (new Set(patches.map((patch) => patch.id)).size !== patches.length) throw vslError('validation_failed', { field: 'units', reason: 'duplicate id' });
    return this.sql.begin(async (tx) => {
      const [row] = await tx<TranslationRow[]>`SELECT * FROM vsl_page_translations WHERE id=${id} AND store_id='l0i' FOR UPDATE`;
      if (!row) throw vslError('translation_not_found');
      if (row.status !== 'translating' && row.status !== 'review') throw vslError('translation_not_ready', { status: row.status });
      const current = await tx<UnitRow[]>`SELECT * FROM vsl_page_translation_units WHERE translation_id=${id} AND id IN ${tx(patches.map((patch) => patch.id))}`;
      const byId = new Map(current.map((unit) => [unit.id, unit]));
      const missing = patches.filter((patch) => !byId.has(patch.id)).map((patch) => patch.id);
      if (missing.length) throw vslError('validation_failed', { field: 'units', ids: missing });
      const invalid = patches.filter((patch) => patch.translated !== undefined && byId.get(patch.id)!.kind === 'script-string' &&
        (/[<>]/.test(patch.translated) || !patch.translated.trim())).map((patch) => patch.id);
      if (invalid.length) throw vslError('text_edit_invalid', { reason: 'invalid_text', ids: invalid });
      const updated: UnitRow[] = [];
      for (const patch of patches) {
        const status = patch.status ?? (patch.translated !== undefined ? 'edited' : byId.get(patch.id)!.status);
        const [unit] = await tx<UnitRow[]>`UPDATE vsl_page_translation_units SET translated=${patch.translated ?? byId.get(patch.id)!.translated},
          status=${status},updated_at=now() WHERE id=${patch.id} RETURNING *`;
        updated.push(unit!);
      }
      await tx`UPDATE vsl_page_translations SET updated_at=now() WHERE id=${id}`;
      return { units: updated.sort((a, b) => a.position - b.position).map(unitView) };
    });
  }

  /** Gera a nova página no idioma (job derivado). Repetir com a tradução já aplicando devolve o mesmo job. */
  async apply(id: string, input: { name?: unknown } = {}, idempotencyKey?: string): Promise<{ job: ImportJobView; statusUrl: string; created: boolean }> {
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200))
      throw vslError('validation_failed', { field: 'name' });
    const outcome = await this.sql.begin(async (tx) => {
      const [row] = await tx<TranslationRow[]>`SELECT * FROM vsl_page_translations WHERE id=${id} AND store_id='l0i' FOR UPDATE`;
      if (!row) throw vslError('translation_not_found');
      if (row.status === 'applying' && row.apply_job_id) return { pageId: row.page_id, jobId: row.apply_job_id, created: false };
      if (row.status !== 'review') throw vslError('translation_not_ready', { status: row.status });
      const [page] = await tx`SELECT name FROM vsl_pages WHERE id=${row.page_id}`;
      const units = await tx<UnitRow[]>`SELECT * FROM vsl_page_translation_units WHERE translation_id=${id} ORDER BY position`;
      const edits = units.filter((unit) => unit.translated !== null && unit.translated !== unit.source &&
        !(unit.kind === 'script-string' && (/[<>]/.test(unit.translated) || !unit.translated.trim())))
        .map((unit) => ({ id: unit.block_id, text: unit.translated! }));
      const name = (typeof input.name === 'string' ? input.name.trim() : `${String(page?.name ?? 'Página').slice(0, 190)} (${row.target_locale.toUpperCase()})`).slice(0, 200);
      const { job, created } = await this.jobs.submitDerived(tx as unknown as Sql, { pageId: row.page_id, operation: 'translation_apply',
        baseRevisionId: row.source_revision_id, idempotencyKey: idempotencyKey ?? `translation-${id}-${randomUUID()}`,
        payload: { edits, lang: row.target_locale, target: { pageId: randomUUID(), name, locale: row.target_locale, translationId: id } } });
      await tx`UPDATE vsl_page_translations SET status='applying',apply_job_id=${job.id},error_code=NULL,error_message=NULL,updated_at=now() WHERE id=${id}`;
      return { pageId: row.page_id, jobId: job.id, created };
    });
    const job = await this.jobs.get(outcome.pageId, outcome.jobId);
    return { job, statusUrl: `/vsl/page-assets/${outcome.pageId}/import-jobs/${job.id}`, created: outcome.created };
  }

  /* ─────────────── Worker ─────────────── */

  async claimNext(): Promise<(TranslationRow & { lease_token: string }) | null> {
    const token = randomUUID();
    const [row] = await this.sql<TranslationRow[]>`UPDATE vsl_page_translations SET lease_token=${token},
      lease_until=now()+make_interval(secs => ${TRANSLATION_LEASE_SECONDS}),attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT id FROM vsl_page_translations WHERE status='translating' AND run_after<=now() AND (lease_token IS NULL OR lease_until<now())
        ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
    return row ? (row as TranslationRow & { lease_token: string }) : null;
  }

  private async renew(row: TranslationRow & { lease_token: string }, progress?: number): Promise<boolean> {
    const [ok] = await this.sql`UPDATE vsl_page_translations SET lease_until=now()+make_interval(secs => ${TRANSLATION_LEASE_SECONDS}),
      progress=COALESCE(${progress ?? null}::smallint,progress),updated_at=now() WHERE id=${row.id} AND lease_token=${row.lease_token} AND status='translating' RETURNING id`;
    return Boolean(ok);
  }

  private async fail(row: TranslationRow & { lease_token: string }, code: 'translation_failed' | 'translation_provider_unavailable', detail: string) {
    await this.sql`UPDATE vsl_page_translations SET status='failed',error_code=${code},error_message=${detail.slice(0, 500)},lease_token=NULL,lease_until=NULL,
      finished_at=now(),updated_at=now() WHERE id=${row.id} AND lease_token=${row.lease_token}`;
    return 'failed' as const;
  }

  /** Traduz as unidades pendentes em lotes (texto de origem repetido é traduzido uma vez). Nunca lança. */
  async process(row: TranslationRow & { lease_token: string }): Promise<'review' | 'retry' | 'failed' | 'fenced'> {
    try {
      const translator = this.options.translator ? await this.options.translator() : null;
      if (!translator) return await this.fail(row, 'translation_provider_unavailable', 'no translator configured');
      const pending = await this.sql<UnitRow[]>`SELECT * FROM vsl_page_translation_units WHERE translation_id=${row.id} AND translated IS NULL ORDER BY position`;
      const [pageRow] = await this.sql`SELECT name FROM vsl_pages WHERE id=${row.page_id}`;
      const unique = new Map<string, UnitRow>();
      for (const unit of pending) if (!unique.has(unit.source)) unique.set(unit.source, unit);
      const limits = this.options.batch ?? { items: 40, chars: 6000 };
      const batches: UnitRow[][] = [];
      let current: UnitRow[] = [];
      let size = 0;
      for (const unit of unique.values()) {
        if (current.length && (current.length >= limits.items || size + unit.source.length > limits.chars)) { batches.push(current); current = []; size = 0; }
        current.push(unit);
        size += unit.source.length;
      }
      if (current.length) batches.push(current);
      let done = row.units_total - pending.length;
      let missing = 0;
      for (const batch of batches) {
        if (!(await this.renew(row))) return 'fenced';
        const masked = batch.map((unit, index) => ({ unit, key: String(index), ...protectSegments(unit.source) }));
        const result = await translator.translate({ sourceLocale: row.source_locale, targetLocale: row.target_locale, pageTitle: String(pageRow?.name ?? ''),
          items: masked.map((item) => ({ key: item.key, text: item.masked, kind: item.unit.kind, label: item.unit.label, context: item.unit.context })) });
        for (const item of masked) {
          const raw = result[item.key];
          let value = typeof raw === 'string' && raw.trim() ? restoreSegments(raw, item.tokens) : null;
          if (value !== null && item.unit.kind === 'script-string' && /[<>]/.test(value)) value = null;
          if (value === null) { missing++; continue; }
          const updated = await this.sql`UPDATE vsl_page_translation_units SET translated=${value},updated_at=now()
            WHERE translation_id=${row.id} AND source=${item.unit.source} AND translated IS NULL RETURNING id`;
          done += updated.length;
        }
        await this.renew(row, Math.min(99, Math.floor((100 * done) / Math.max(1, row.units_total))));
      }
      if (missing && row.attempts < row.max_attempts) {
        const [ok] = await this.sql`UPDATE vsl_page_translations SET lease_token=NULL,lease_until=NULL,run_after=now()+make_interval(secs => ${30 * row.attempts}),
          provider=${translator.provider},model=${translator.model},updated_at=now() WHERE id=${row.id} AND lease_token=${row.lease_token} RETURNING id`;
        return ok ? 'retry' : 'fenced';
      }
      // Itens que o modelo não devolveu (após as tentativas) ficam sem tradução para o operador preencher.
      const [ok] = await this.sql`UPDATE vsl_page_translations SET status='review',progress=100,provider=${translator.provider},model=${translator.model},
        lease_token=NULL,lease_until=NULL,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=${row.id} AND lease_token=${row.lease_token} RETURNING id`;
      return ok ? 'review' : 'fenced';
    } catch (error) {
      const kind = error instanceof TranslatorError ? error.kind : 'transient';
      this.options.log?.warn({ translationId: row.id, attempt: row.attempts, kind, errName: error instanceof Error ? error.name : typeof error }, '[vsl] translation attempt failed');
      try {
        if (kind === 'auth') return await this.fail(row, 'translation_provider_unavailable', error instanceof Error ? error.message : 'auth');
        if (kind === 'invalid' || row.attempts >= row.max_attempts) return await this.fail(row, 'translation_failed', error instanceof Error ? error.message : 'unknown');
        const [ok] = await this.sql`UPDATE vsl_page_translations SET lease_token=NULL,lease_until=NULL,run_after=now()+make_interval(secs => ${30 * row.attempts}),
          error_message=${(error instanceof Error ? error.message : 'unknown').slice(0, 500)},updated_at=now() WHERE id=${row.id} AND lease_token=${row.lease_token} RETURNING id`;
        return ok ? 'retry' : 'fenced';
      } catch {
        return 'fenced';
      }
    }
  }
}

/** Processa traduções pendentes até esvaziar (ou `max`). */
export async function drainTranslations(service: VslPageTranslations, log: { info: (obj: object, msg: string) => void }, max = 5): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const row = await service.claimNext();
    if (!row) break;
    const state = await service.process(row);
    log.info({ translationId: row.id, attempt: row.attempts, state }, '[vsl] translation processed');
    processed++;
  }
  return processed;
}

/**
 * Chave da Anthropic para a tradução: cofre `anthropic:api_key` primeiro; se ausente (ou o cofre falhar),
 * a env `ANTHROPIC_API_KEY`. Erro do cofre só é propagado quando também não há chave na env.
 */
export function anthropicKeyWithEnvFallback(
  vault: () => Promise<string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string | null> {
  return async () => {
    const fromEnv = env['ANTHROPIC_API_KEY']?.trim() || null;
    let fromVault: string | null | undefined;
    try {
      fromVault = await vault();
    } catch (error) {
      if (fromEnv) return fromEnv;
      throw error;
    }
    return fromVault?.trim() || fromEnv;
  };
}

/** Provider a partir do ambiente: `VSL_TRANSLATION_PROVIDER=fake` (fora de produção) ou Claude com a chave do cofre/env. */
export function translatorFromKey(getKey: () => Promise<string | null>, env: NodeJS.ProcessEnv = process.env): () => Promise<VslCopyTranslator | null> {
  return async () => {
    if (env['VSL_TRANSLATION_PROVIDER'] === 'fake' && env['NODE_ENV'] !== 'production') return new FakeCopyTranslator();
    const key = await getKey();
    return key ? new AnthropicCopyTranslator(key, env['VSL_TRANSLATION_MODEL'] || VSL_TRANSLATION_DEFAULT_MODEL) : null;
  };
}
