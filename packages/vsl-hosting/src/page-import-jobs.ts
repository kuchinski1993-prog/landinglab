// Import G3 assíncrono: a API só grava o upload (stream) e cria o job; o worker
// processa com lease + fencing (lease_token) em vsl_page_import_jobs (0088).
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { Sql } from 'postgres';

import { analyze, canonical, type Finding, type ImportConfig, type ImportSummary } from './analysis.js';
import { ArchiveError, extractSource, LIMITS } from './archive.js';
import { localizeResources, type LOCALIZE_LIMITS } from './localize.js';
import { safeFetch, SafeFetchError, type SafeFetcher, type SafeFetchOptions } from './safe-fetch.js';
import { validateImportConfig } from './config.js';
import { vslError, VSL_ERRORS, type VslErrorCode } from './errors.js';
import { findCtaSuggestions } from './cta-candidates.js';
import { applyPageTextEdits, decodePageHtml, extractPageTextBlocks, PageTextError, type PageTextEdit } from './page-texts.js';
import { digest, VslUploadTooLarge, type Manifest, type VslObjectStore } from './storage.js';

export type ImportJobState = 'queued' | 'running' | 'needs_resolution' | 'succeeded' | 'failed';
export const IMPORT_LEASE_SECONDS = 300;
export const IMPORT_MAX_ATTEMPTS = 3;
/** Versão do pipeline de import inteligente (entra no fingerprint: reprocessar gera revisão nova). */
export const SMART_IMPORT_VERSION = 'smart-1';
/** "Importar de um link": tempo máximo para baixar o HTML da página. */
export const IMPORT_URL_TIMEOUT_MS = 15_000;

/** Mensagens PT-BR por categoria de achado da análise (códigos = categoria com "_"). */
const FINDING_MESSAGES: Record<string, string> = {
  'external-reference': 'Recurso carregado de outro site; será bloqueado na página publicada se não for autorizado.',
  'external-kept': 'Não deu para trazer este recurso para o seu servidor; ele continua vindo do site original (origem liberada na página).',
  'navigation-reference': 'Link para outro site.',
  'navigation-link': 'Link para outra página do site original. Não atrapalha: o botão do VSL cuida da navegação.',
  'missing-dependency': 'Arquivo usado pela página não veio no ZIP. Informe o endereço original da página para buscá-lo.',
  'missing-recovered': 'Arquivo que não veio no ZIP foi recuperado automaticamente.',
  'invalid-reference': 'Referência a um caminho inválido; foi mantida como está.',
  'unknown-script': 'Script que não conseguimos analisar; foi mantido como está.',
  'module-origin': 'Script de módulo carregado de outra origem; foi mantido.',
  'external-api': 'Script chama uma API de outro site; a chamada pode ser bloqueada na página publicada.',
  'dynamic-script': 'Script com comportamento dinâmico; foi mantido.',
  'origin-dependent-script': 'Script lê cookies ou o domínio do site original; foi mantido, mas pode se comportar diferente no seu domínio.',
  'tracker-mixed': 'Script mistura rastreador com código da página; foi mantido e os pixels originais são desligados ao publicar.',
  'tracker-removable': 'Rastreador do site original removido.',
  'video-player-replaced': 'Player de vídeo do site original substituído pelo vídeo do VSL Hosting, no mesmo lugar.',
  'video-player-script-removed': 'Script do player de vídeo substituído removido.',
  'video-player-kept': 'Outro player de vídeo da página foi mantido; a origem dele foi liberada.',
  'iframe-authorized': 'Conteúdo incorporado de outro site (iframe) mantido; a origem foi liberada.',
  'resource-hint-removed': 'Link para rastreador ou player removido junto com ele.',
  'base-removed': 'Tag <base> removida; o endereço original só é usado para buscar arquivos.',
  'csp-incompatible': 'Código incompatível com a política de segurança da página publicada.',
  'base-origin': 'Tag <base> aponta para outro site.',
  'selector-invalid': 'Seletor inválido.',
  'selector-missing': 'Elemento esperado não foi encontrado na página.',
  'pwa-manifest-removed': 'Link para manifesto de app (PWA) removido; não é usado em páginas de funil.',
  metadata: 'Metadado do sistema operacional ignorado.',
  'discarded-os-metadata': 'Metadado do sistema operacional (__MACOSX/.DS_Store) ignorado.',
  'discarded-reserved-name': 'Arquivo com nome reservado pelo VSL Hosting (manifest.json na raiz, .sealed ou __vsl) ignorado.',
  'discarded-hidden-file': 'Arquivo oculto ignorado.',
  'discarded-unsupported-type': 'Tipo de arquivo não usado pela página (ex.: .map, .txt, .xml, .md) ignorado.',
  'discarded-empty-file': 'Arquivo vazio ignorado.',
  'discarded-executable': 'Executável ou arquivo compactado dentro do ZIP ignorado.',
  'discarded-invalid-content': 'Arquivo com conteúdo inválido ignorado.',
};

/** Legado (jobs gravados antes das mensagens em PT-BR): motivo técnico → mensagem para o operador. */
const LEGACY_SOURCE_ERRORS: Array<[RegExp, string]> = [
  [/Reserved release path/, 'O ZIP tinha um arquivo com nome reservado (ex.: manifest.json). Envie de novo: agora ele é ignorado.'],
  [/Unsupported or empty file/, 'O ZIP tinha um arquivo vazio ou de tipo não suportado. Envie de novo: agora ele é ignorado.'],
  [/no HTML entry|Invalid entry HTML/, 'Nenhum arquivo .html de entrada encontrado.'],
  [/Invalid HTML/, 'O arquivo não parece ser uma página HTML.'],
  [/Invalid textual content/, 'Um arquivo de texto não é UTF-8 válido ou contém código de servidor.'],
  [/VSL path|Excessively encoded/, 'O ZIP contém um caminho de arquivo inválido.'],
];

function sourceErrorMessage(error: unknown): string {
  if (error instanceof ArchiveError) return error.message;
  return 'O arquivo está corrompido ou não é um HTML/ZIP válido.';
}

/** Mensagem de `import_source_invalid`: o motivo específico gravado no job (PT-BR) ou o genérico. */
export function importErrorMessage(code: string | null, detail: string | null): string {
  const generic = VSL_ERRORS[(code ?? 'import_failed') as VslErrorCode]?.message ?? VSL_ERRORS.import_failed.message;
  if (code !== 'import_source_invalid' || !detail) return generic;
  for (const [pattern, message] of LEGACY_SOURCE_ERRORS) if (pattern.test(detail)) return message;
  return [...detail].every((char) => char.charCodeAt(0) < 128) && !/^(?:O|A|Nenhum|Um) /.test(detail) ? generic : detail;
}

export interface LocalizedFinding {
  id: string; code: string; severity: Finding['severity']; file: string; location: string;
  message: string; evidence: string; action: string;
}

export function localizeFindings(findings: Finding[] = []): LocalizedFinding[] {
  return findings.map((finding) => ({
    id: finding.id,
    code: finding.category.replace(/-/g, '_'),
    severity: finding.severity,
    file: finding.file,
    location: finding.location,
    message: FINDING_MESSAGES[finding.category] ?? 'Item que precisa de revisão.',
    // Hash de conteúdo não diz nada ao operador.
    evidence: /^[0-9a-f]{64}$/.test(finding.evidence) ? '' : finding.evidence,
    action: finding.action,
  }));
}

export type PageJobOperation = 'import' | 'text_edit' | 'translation_apply';
/** Revisão derivada: edições por bloco sobre `base_revision_id`; `target` = nova página (tradução). */
export interface DerivedPayload {
  edits: PageTextEdit[];
  lang?: string;
  target?: { pageId: string; name: string; locale: string; translationId: string };
}

interface JobRow {
  id: string; page_id: string; idempotency_key: string; request_hash: string; kind: 'html' | 'zip';
  source_key: string; source_bytes: string | number; source_sha256: string; config: ImportConfig;
  operation: PageJobOperation; base_revision_id: string | null; payload: DerivedPayload | null;
  state: ImportJobState; stage: string; progress: number; attempts: number; max_attempts: number;
  lease_token: string | null; lease_until: Date | null; run_after: Date; revision_id: string | null; reused: boolean;
  report: { findings?: Finding[]; pending?: string[]; candidates?: string[]; resolutionCode?: string; targetPageId?: string; summary?: ImportSummary } | null;
  error_code: string | null; error_message: string | null; created_at: Date; updated_at: Date; finished_at: Date | null;
}

export function importJobView(row: JobRow) {
  const findings = localizeFindings(row.report?.findings);
  return {
    id: row.id, pageId: row.page_id, operation: row.operation ?? 'import', state: row.state, stage: row.stage, progress: row.progress,
    attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
    // `result.pageId` = página que recebeu a revisão (na tradução, a página nova).
    // `summary`: resumo amigável do import inteligente (null em revisões derivadas e jobs antigos).
    result: row.state === 'succeeded' ? { revisionId: row.revision_id, pageId: row.report?.targetPageId ?? row.page_id, reused: row.reused, findings,
      summary: row.report?.summary ?? null } : null,
    // `reprocessable`: job antigo parado em pendências — "Reprocessar com a importação nova" (POST .../reprocess).
    resolution: row.state === 'needs_resolution' ? {
      code: row.report?.resolutionCode ?? 'import_needs_resolution',
      message: VSL_ERRORS[(row.report?.resolutionCode ?? 'import_needs_resolution') as VslErrorCode]?.message ?? VSL_ERRORS.import_needs_resolution.message,
      candidates: row.report?.candidates ?? [], pending: row.report?.pending ?? [], findings,
      reprocessable: (row.report?.resolutionCode ?? 'import_needs_resolution') === 'import_needs_resolution',
    } : null,
    error: row.state === 'failed' ? {
      code: row.error_code ?? 'import_failed',
      message: importErrorMessage(row.error_code ?? 'import_failed', row.error_message),
    } : null,
  };
}
export type ImportJobView = ReturnType<typeof importJobView>;

export interface SubmitImportInput {
  pageId: string; idempotencyKey: string; kind: 'html' | 'zip'; config: unknown;
  contentLength: number | undefined; source: Readable;
}

function importConfig(input: unknown): ImportConfig {
  try {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return validateImportConfig({ ...raw, requiredTargets: [], allowForms: true });
  } catch (error) {
    throw vslError('invalid_config', { reason: error instanceof Error ? error.message : 'invalid' });
  }
}

class Fenced extends Error {}
/** Erros determinísticos (o arquivo é que está errado): não adianta tentar de novo. */
class Deterministic extends Error {
  constructor(readonly code: VslErrorCode, readonly detail: string) { super(detail); }
}

export interface ImportProcessLog { warn: (obj: object, msg: string) => void }

export interface PageImportJobOptions {
  /** GET protegido contra SSRF (padrão: safeFetch). Injetável nos testes. */
  fetcher?: SafeFetcher;
  /** Injeção para testes: resolver DNS, portas e bloqueio de endereços. */
  fetchOptions?: Partial<SafeFetchOptions>;
  localizeLimits?: Partial<typeof LOCALIZE_LIMITS>;
}

/** Página principal sem perguntar: a escolhida, a única, ou o `index.html` da raiz. */
export function pickEntry(candidates: string[], configured?: string): string | null {
  if (configured) return candidates.includes(configured) ? configured : null;
  if (candidates.length === 1) return candidates[0]!;
  return candidates.find((candidate) => /^index\.html?$/i.test(candidate)) ?? null;
}

/** Arquivos de texto que podem citar o caminho de assets da revisão (`/__vsl/assets/<revisionId>/`). */
const TEXT_ASSET_MIME = /^(?:text\/|application\/(?:javascript|json|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i;
const EDIT_ID = /^t[0-9a-f]{16}$/;
export const TEXT_EDIT_LIMITS = { maxEdits: 5000, maxChars: 20_000 };

function replaceBytes(bytes: Buffer, from: string, to: string): Buffer {
  const needle = Buffer.from(from);
  let at = bytes.indexOf(needle);
  if (at < 0) return bytes;
  const parts: Buffer[] = [];
  let cursor = 0;
  while (at >= 0) {
    parts.push(bytes.subarray(cursor, at), Buffer.from(to));
    cursor = at + needle.length;
    at = bytes.indexOf(needle, cursor);
  }
  parts.push(bytes.subarray(cursor));
  return Buffer.concat(parts);
}

/** Valida a lista de edições (formato) antes de olhar o HTML. */
export function validateTextEdits(input: unknown): PageTextEdit[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > TEXT_EDIT_LIMITS.maxEdits) throw vslError('validation_failed', { field: 'edits' });
  const seen = new Set<string>();
  return input.map((item, index) => {
    const edit = item as Partial<PageTextEdit> | null;
    if (!edit || typeof edit !== 'object' || typeof edit.id !== 'string' || !EDIT_ID.test(edit.id) || typeof edit.text !== 'string' ||
      edit.text.length > TEXT_EDIT_LIMITS.maxChars || seen.has(edit.id))
      throw vslError('validation_failed', { field: `edits[${index}]` });
    seen.add(edit.id);
    return { id: edit.id, text: edit.text };
  });
}

/** PageTextError → erro HTTP estável. */
export function pageTextHttpError(error: unknown) {
  if (error instanceof PageTextError)
    return error.reason === 'encoding' ? vslError('page_text_unsupported') : vslError('text_edit_invalid', { reason: error.reason, ids: error.ids });
  return error;
}

export class VslPageImportJobs {
  constructor(readonly sql: Sql, readonly storage: VslObjectStore, readonly log?: ImportProcessLog, readonly options: PageImportJobOptions = {}) {}

  private async findByKey(pageId: string, key: string) {
    const [row] = await this.sql<JobRow[]>`SELECT * FROM vsl_page_import_jobs WHERE page_id=${pageId} AND idempotency_key=${key}`;
    return row;
  }

  /** Grava o upload em stream e cria o job. `created=false` = mesma chave já usada (idempotente). */
  async submit(input: SubmitImportInput): Promise<{ job: ImportJobView; created: boolean }> {
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 200 || /[^\x21-\x7e]/.test(key)) throw vslError('validation_failed', { field: 'Idempotency-Key' });
    if (input.contentLength === undefined || !Number.isSafeInteger(input.contentLength) || input.contentLength <= 0)
      throw vslError('content_length_required');
    if (input.contentLength > LIMITS[input.kind]) throw vslError('payload_too_large', { maxBytes: LIMITS[input.kind] });
    const config = importConfig(input.config);
    const [page] = await this.sql`SELECT id FROM vsl_pages WHERE id=${input.pageId} AND store_id='l0i'`;
    if (!page) throw vslError('page_not_found');
    const requestHash = digest(canonical({ kind: input.kind, bytes: input.contentLength, config }));
    const prior = await this.findByKey(input.pageId, key);
    if (prior) {
      if (prior.request_hash !== requestHash) throw vslError('idempotency_conflict');
      return { job: importJobView(prior), created: false };
    }
    const id = randomUUID();
    const sourceKey = `vsl/sources/g3/${id}/original.${input.kind}`;
    let stored: { bytes: number; sha256: string };
    try {
      stored = await this.storage.putStream(sourceKey, input.source, { maxBytes: LIMITS[input.kind], contentLength: input.contentLength });
    } catch (error) {
      await this.storage.deletePrefix(`vsl/sources/g3/${id}`).catch(() => undefined);
      if (error instanceof VslUploadTooLarge) throw vslError('payload_too_large', { maxBytes: LIMITS[input.kind] });
      if (error instanceof Error && /Content-Length/.test(error.message)) throw vslError('validation_failed', { field: 'Content-Length' });
      throw vslError('import_storage_failed');
    }
    const [created] = await this.sql<JobRow[]>`INSERT INTO vsl_page_import_jobs(id,page_id,idempotency_key,request_hash,kind,source_key,source_bytes,source_sha256,config,max_attempts)
      VALUES(${id},${input.pageId},${key},${requestHash},${input.kind},${sourceKey},${stored.bytes},${stored.sha256},${this.sql.json(config as never)},${IMPORT_MAX_ATTEMPTS})
      ON CONFLICT(page_id,idempotency_key) DO NOTHING RETURNING *`;
    if (created) return { job: importJobView(created), created: true };
    await this.storage.deletePrefix(`vsl/sources/g3/${id}`).catch(() => undefined);
    const raced = await this.findByKey(input.pageId, key);
    if (!raced || raced.request_hash !== requestHash) throw vslError('idempotency_conflict');
    return { job: importJobView(raced), created: false };
  }

  /** Revisão pronta da página (para extrair/editar textos). */
  async revision(pageId: string, revisionId: string) {
    const [page] = await this.sql`SELECT id,name,locale FROM vsl_pages WHERE id=${pageId} AND store_id='l0i'`;
    if (!page) throw vslError('page_not_found');
    const [revision] = await this.sql<Array<{ id: string; page_id: string; storage_prefix: string; entry_path: string; manifest: Manifest; status: string; storage_deleted_at: Date | null }>>`
      SELECT id,page_id,storage_prefix,entry_path,manifest,status,storage_deleted_at FROM vsl_page_revisions WHERE id=${revisionId} AND page_id=${pageId}`;
    if (!revision || revision.status !== 'ready' || revision.storage_deleted_at) throw vslError('revision_not_found');
    return { page: page as { id: string; name: string; locale: string | null }, revision };
  }

  /** HTML de entrada da revisão (UTF-8 com ida e volta exata). */
  async revisionHtml(pageId: string, revisionId: string): Promise<string> {
    const { revision } = await this.revision(pageId, revisionId);
    const bytes = await this.storage.read(`${revision.storage_prefix}/${revision.entry_path}`);
    try { return decodePageHtml(bytes); } catch (error) { throw pageTextHttpError(error); }
  }

  /** GET .../texts: blocos de texto da revisão. */
  async texts(pageId: string, revisionId: string) {
    return { blocks: extractPageTextBlocks(await this.revisionHtml(pageId, revisionId)) };
  }

  /**
   * GET .../cta-candidates: botões de compra sugeridos (links de checkout/próxima etapa ou texto de compra) e
   * mensagens de espera próximas a eles ("Seguí mirando el video para desbloquear…", `waitCandidates`).
   */
  async ctaCandidates(pageId: string, revisionId: string, nextPath?: string | null) {
    return findCtaSuggestions(await this.revisionHtml(pageId, revisionId), { nextPath: nextPath ?? null });
  }

  /** POST .../texts: valida as edições contra o HTML e cria o job que gera a nova revisão. */
  async submitTextEdit(pageId: string, revisionId: string, rawEdits: unknown, idempotencyKey?: string): Promise<{ job: ImportJobView; created: boolean }> {
    const edits = validateTextEdits(rawEdits);
    const html = await this.revisionHtml(pageId, revisionId);
    try { applyPageTextEdits(html, edits); } catch (error) { throw pageTextHttpError(error); }
    return this.submitDerived(this.sql, { pageId, operation: 'text_edit', baseRevisionId: revisionId, payload: { edits }, idempotencyKey });
  }

  /** Cria um job de revisão derivada (mesma fila/lease do import). `tx` permite criar junto com outra escrita. */
  async submitDerived(tx: Sql, input: { pageId: string; operation: Exclude<PageJobOperation, 'import'>; baseRevisionId: string; payload: DerivedPayload; idempotencyKey?: string }) {
    const key = (input.idempotencyKey ?? '').trim() || `auto-${randomUUID()}`;
    if (key.length > 200 || /[^\x21-\x7e]/.test(key)) throw vslError('validation_failed', { field: 'Idempotency-Key' });
    const requestHash = digest(canonical({ operation: input.operation, base: input.baseRevisionId, payload: input.payload }));
    const [prior] = await tx<JobRow[]>`SELECT * FROM vsl_page_import_jobs WHERE page_id=${input.pageId} AND idempotency_key=${key}`;
    if (prior) {
      if (prior.request_hash !== requestHash) throw vslError('idempotency_conflict');
      return { job: importJobView(prior), created: false };
    }
    const [created] = await tx<JobRow[]>`INSERT INTO vsl_page_import_jobs(page_id,idempotency_key,request_hash,kind,operation,base_revision_id,payload,max_attempts)
      VALUES(${input.pageId},${key},${requestHash},'html',${input.operation},${input.baseRevisionId},${tx.json(input.payload as never)},${IMPORT_MAX_ATTEMPTS})
      ON CONFLICT(page_id,idempotency_key) DO NOTHING RETURNING *`;
    if (created) return { job: importJobView(created), created: true };
    throw vslError('idempotency_conflict');
  }

  async get(pageId: string, jobId: string): Promise<ImportJobView> {
    const [row] = await this.sql<JobRow[]>`SELECT * FROM vsl_page_import_jobs WHERE id=${jobId} AND page_id=${pageId}`;
    if (!row) throw vslError('import_job_not_found');
    return importJobView(row);
  }

  async list(pageId: string): Promise<ImportJobView[]> {
    const rows = await this.sql<JobRow[]>`SELECT * FROM vsl_page_import_jobs WHERE page_id=${pageId} ORDER BY created_at DESC LIMIT 20`;
    return rows.map(importJobView);
  }

  /** Reabre um job em needs_resolution com nova configuração (entryPath/resolutions), sem reenviar o arquivo. */
  async resume(pageId: string, jobId: string, patch: unknown): Promise<ImportJobView> {
    const [row] = await this.sql<JobRow[]>`SELECT * FROM vsl_page_import_jobs WHERE id=${jobId} AND page_id=${pageId}`;
    if (!row) throw vslError('import_job_not_found');
    if (row.state !== 'needs_resolution') throw vslError('import_not_resumable');
    const extra = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const config = importConfig({ ...row.config, ...extra });
    if (config.entryPath && row.report?.candidates?.length && !row.report.candidates.includes(config.entryPath))
      throw vslError('import_entry_required', { candidates: row.report.candidates });
    const [updated] = await this.sql<JobRow[]>`UPDATE vsl_page_import_jobs SET config=${this.sql.json(config as never)},state='queued',stage='queued',progress=0,
      attempts=0,run_after=now(),error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=now()
      WHERE id=${jobId} AND state='needs_resolution' RETURNING *`;
    if (!updated) throw vslError('version_conflict');
    return importJobView(updated);
  }

  /**
   * "Reprocessar com a importação nova" / "Informar URL de origem": reaplica o pipeline atual na MESMA fonte.
   * `needs_resolution` → o próprio job volta para a fila (decisões antigas são descartadas);
   * `succeeded`/`failed` → novo job com cópia da fonte (se ela ainda existir). `sourceUrl` opcional.
   */
  async reprocess(pageId: string, jobId: string, input: unknown): Promise<{ job: ImportJobView; created: boolean }> {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (Object.keys(body).some((key) => key !== 'sourceUrl') || (body.sourceUrl !== undefined && typeof body.sourceUrl !== 'string'))
      throw vslError('validation_failed', { field: 'sourceUrl' });
    const sourceUrl = typeof body.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl.trim() : undefined;
    const [row] = await this.sql<JobRow[]>`SELECT * FROM vsl_page_import_jobs WHERE id=${jobId} AND page_id=${pageId}`;
    if (!row) throw vslError('import_job_not_found');
    if ((row.operation ?? 'import') !== 'import' || row.state === 'queued' || row.state === 'running') throw vslError('import_not_resumable');
    const { resolutions: _decisions, ...previous } = row.config ?? {};
    const config = importConfig({ ...previous, ...(sourceUrl ? { sourceUrl } : {}) });
    if (row.state === 'needs_resolution') {
      const [updated] = await this.sql<JobRow[]>`UPDATE vsl_page_import_jobs SET config=${this.sql.json(config as never)},state='queued',stage='queued',progress=0,
        attempts=0,run_after=now(),report=NULL,error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=now()
        WHERE id=${jobId} AND state='needs_resolution' RETURNING *`;
      if (!updated) throw vslError('version_conflict');
      return { job: importJobView(updated), created: false };
    }
    const key = `reprocess-${row.id}-${digest(canonical(config)).slice(0, 16)}`;
    const requestHash = digest(canonical({ reprocessOf: row.id, config }));
    const prior = await this.findByKey(pageId, key);
    if (prior) return { job: importJobView(prior), created: false };
    let source: Buffer;
    try { source = await this.storage.read(row.source_key); }
    catch { throw vslError('import_source_unavailable'); }
    if (source.length !== Number(row.source_bytes) || digest(source) !== row.source_sha256) throw vslError('import_source_unavailable');
    const id = randomUUID();
    const sourceKey = `vsl/sources/g3/${id}/original.${row.kind}`;
    try { await this.storage.putExclusive(sourceKey, source); }
    catch { throw vslError('import_storage_failed'); }
    const [created] = await this.sql<JobRow[]>`INSERT INTO vsl_page_import_jobs(id,page_id,idempotency_key,request_hash,kind,source_key,source_bytes,source_sha256,config,max_attempts)
      VALUES(${id},${pageId},${key},${requestHash},${row.kind},${sourceKey},${row.source_bytes},${row.source_sha256},${this.sql.json(config as never)},${IMPORT_MAX_ATTEMPTS})
      ON CONFLICT(page_id,idempotency_key) DO NOTHING RETURNING *`;
    if (created) return { job: importJobView(created), created: true };
    await this.storage.deletePrefix(`vsl/sources/g3/${id}`).catch(() => undefined);
    const raced = await this.findByKey(pageId, key);
    if (!raced) throw vslError('idempotency_conflict');
    return { job: importJobView(raced), created: false };
  }

  /**
   * "Importar de um link": baixa o HTML da URL (GET protegido contra SSRF: só http(s) público, máx. 3 redirects,
   * 5 MB, 15 s) e cria o job como um import de HTML com `sourceUrl` = endereço final — o worker roda o mesmo
   * pipeline (inclusive buscar CSS/fontes/imagens no site de origem).
   */
  async submitFromUrl(input: { pageId: string; url: unknown; idempotencyKey?: string }): Promise<{ job: ImportJobView; created: boolean }> {
    if (typeof input.url !== 'string' || !input.url.trim() || input.url.length > 2048) throw vslError('validation_failed', { field: 'url' });
    const [page] = await this.sql`SELECT id FROM vsl_pages WHERE id=${input.pageId} AND store_id='l0i'`;
    if (!page) throw vslError('page_not_found');
    const fetcher = this.options.fetcher ?? safeFetch;
    let response;
    try {
      response = await fetcher(input.url.trim(), { maxBytes: LIMITS.html, timeoutMs: IMPORT_URL_TIMEOUT_MS, maxRedirects: 3,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', ...this.options.fetchOptions });
    } catch (error) {
      const reason = error instanceof SafeFetchError ? error.reason : 'network';
      if (reason === 'invalid_url' || reason === 'private_address') throw vslError('import_url_invalid', { reason });
      if (reason === 'too_large') throw vslError('payload_too_large', { maxBytes: LIMITS.html });
      throw vslError('import_url_unreachable', { reason, ...(error instanceof SafeFetchError && error.status ? { status: error.status } : {}) });
    }
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/.test(response.contentType) || !response.bytes.length)
      throw vslError('import_url_not_html');
    const key = (input.idempotencyKey ?? '').trim() || `url-${randomUUID()}`;
    return this.submit({ pageId: input.pageId, idempotencyKey: key, kind: 'html', config: { sourceUrl: response.url.href },
      contentLength: response.bytes.length, source: Readable.from([response.bytes]) });
  }

  /** Reivindica o próximo job (queued vencido ou running com lease expirado). */
  async claimNext(): Promise<(JobRow & { lease_token: string }) | null> {
    const token = randomUUID();
    const [row] = await this.sql<JobRow[]>`UPDATE vsl_page_import_jobs SET state='running',stage='validating',progress=5,lease_token=${token},
      lease_until=now()+make_interval(secs => ${IMPORT_LEASE_SECONDS}),attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT id FROM vsl_page_import_jobs WHERE (state='queued' AND run_after<=now()) OR (state='running' AND lease_until<now())
        ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
    return row ? (row as JobRow & { lease_token: string }) : null;
  }

  private async stage(job: JobRow & { lease_token: string }, stage: string, progress: number) {
    const [row] = await this.sql`UPDATE vsl_page_import_jobs SET stage=${stage},progress=${progress},
      lease_until=now()+make_interval(secs => ${IMPORT_LEASE_SECONDS}),updated_at=now()
      WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running' RETURNING id`;
    if (!row) throw new Fenced('fenced');
  }

  private async finish(job: JobRow & { lease_token: string }, state: 'failed' | 'needs_resolution', fields: { code: VslErrorCode; detail?: string; report?: JobRow['report'] }) {
    const [row] = await this.sql`UPDATE vsl_page_import_jobs SET state=${state},stage=${state},progress=${state === 'failed' ? 100 : 0},
      error_code=${state === 'failed' ? fields.code : null},error_message=${fields.detail?.slice(0, 500) ?? null},
      report=${fields.report ? this.sql.json(fields.report as never) : null},
      lease_token=NULL,lease_until=NULL,finished_at=${state === 'failed' ? this.sql`now()` : null},updated_at=now()
      WHERE id=${job.id} AND lease_token=${job.lease_token} RETURNING id`;
    if (!row) throw new Fenced('fenced');
    if (state === 'failed' && job.operation === 'translation_apply')
      // Aplicar falhou: a tradução volta para revisão (o operador pode tentar de novo).
      await this.sql`UPDATE vsl_page_translations SET status='review',error_code=${fields.code},error_message=${fields.detail?.slice(0, 500) ?? null},updated_at=now()
        WHERE apply_job_id=${job.id} AND status='applying'`;
    if (state === 'failed' && job.source_key) await this.storage.deletePrefix(`vsl/sources/g3/${job.id}`).catch(() => undefined);
  }

  /** Processa um job reivindicado. Nunca lança: falhas viram estado do job. */
  async process(job: JobRow & { lease_token: string }): Promise<ImportJobState | 'fenced'> {
    if (job.operation && job.operation !== 'import') return this.processDerived(job);
    let releasePrefix: string | null = null;
    let committed = false;
    try {
      if (job.attempts > job.max_attempts) {
        await this.finish(job, 'failed', { code: 'import_failed', detail: 'attempts exhausted' });
        return 'failed';
      }
      const source = await this.storage.read(job.source_key);
      if (source.length !== Number(job.source_bytes) || digest(source) !== job.source_sha256)
        throw new Error('Source checksum mismatch');
      await this.stage(job, 'extracting', 15);
      let files;
      try { files = extractSource(source, job.kind); }
      catch (error) { throw new Deterministic('import_source_invalid', sourceErrorMessage(error)); }
      const candidates = files.filter((file) => file.mime === 'text/html').map((file) => file.path);
      const entry = pickEntry(candidates, job.config.entryPath);
      if (!entry) {
        if (!candidates.length) throw new Deterministic('import_source_invalid', 'Nenhum arquivo .html de entrada encontrado.');
        await this.finish(job, 'needs_resolution', { code: 'import_entry_required', report: { resolutionCode: 'import_entry_required', candidates } });
        return 'needs_resolution';
      }
      const fingerprint = digest(canonical({ sourceSha256: job.source_sha256, kind: job.kind, config: job.config, importer: SMART_IMPORT_VERSION }));
      const [prior] = await this.sql`SELECT id FROM vsl_page_revisions WHERE page_id=${job.page_id} AND fingerprint=${fingerprint}`;
      if (prior) return await this.commit(job, { reusedId: String(prior.id) });
      // Import inteligente: traz CSS/fontes/imagens externas e arquivos que faltaram no ZIP (lease renovado a cada lote).
      await this.stage(job, 'localizing', 20);
      let lastStage = Date.now();
      const localized = await localizeResources(files, entry, {
        sourceUrl: job.config.sourceUrl ?? null, fetcher: this.options.fetcher, fetchOptions: this.options.fetchOptions, limits: this.options.localizeLimits,
        onProgress: async (done, total) => {
          if (Date.now() - lastStage < 5000) return;
          lastStage = Date.now();
          await this.stage(job, 'localizing', 20 + Math.floor((14 * done) / Math.max(total, 1)));
        },
      });
      await this.stage(job, 'analyzing', 35);
      const revisionId = randomUUID();
      let result;
      // Política do import inteligente: nada exige decisão; o runtime público ainda remove pixels originais ao servir.
      try {
        result = analyze(localized.files, entry, { ...job.config, assetBasePath: `/__vsl/assets/${revisionId}/`, runtimeTrackerRemoval: true,
          smartImport: true, localization: localized.localization });
      } catch (error) { throw new Deterministic('import_source_invalid', sourceErrorMessage(error)); }
      if (result.report.pending.length) {
        await this.finish(job, 'needs_resolution', { code: 'import_needs_resolution',
          report: { resolutionCode: 'import_needs_resolution', candidates, findings: result.report.findings, pending: result.report.pending } });
        return 'needs_resolution';
      }
      releasePrefix = `vsl/releases/${job.page_id}/${revisionId}`;
      await this.stage(job, 'writing', 40);
      for (const [index, file] of result.files.entries()) {
        await this.storage.putExclusive(`${releasePrefix}/${file.path}`, file.bytes);
        if (index % 25 === 24) await this.stage(job, 'writing', 40 + Math.floor((45 * (index + 1)) / result.files.length));
      }
      await this.stage(job, 'sealing', 90);
      await this.storage.seal(releasePrefix, result.manifest);
      if (!(await this.storage.isSealed(releasePrefix, result.manifest))) throw new Error('Page release seal failed');
      // Com arquivo faltando, o upload fica guardado (até o GC) para "Informar URL de origem" reprocessar sem reenviar.
      const keepSource = Boolean(result.report.summary?.missing.length);
      const state = await this.commit(job, { revisionId, entry, prefix: releasePrefix, fingerprint, manifest: result.manifest, report: result.report, keepSource });
      committed = true;
      return state;
    } catch (error) {
      if (!committed && releasePrefix) await this.storage.deletePrefix(releasePrefix).catch(() => undefined);
      return this.failAttempt(job, error);
    }
  }

  /** Falha de uma tentativa: determinística → failed; transitória → retry com backoff (até max_attempts). */
  private async failAttempt(job: JobRow & { lease_token: string }, error: unknown): Promise<ImportJobState | 'fenced'> {
    if (error instanceof Fenced) return 'fenced';
    {
      try {
        if (error instanceof Deterministic) {
          await this.finish(job, 'failed', { code: error.code, detail: error.detail });
          return 'failed';
        }
        this.log?.warn({ jobId: job.id, attempt: job.attempts, errName: error instanceof Error ? error.name : typeof error }, '[vsl] import attempt failed');
        if (job.attempts >= job.max_attempts) {
          await this.finish(job, 'failed', { code: 'import_failed', detail: error instanceof Error ? error.message : 'unknown' });
          return 'failed';
        }
        const [row] = await this.sql`UPDATE vsl_page_import_jobs SET state='queued',stage='retrying',lease_token=NULL,lease_until=NULL,
          run_after=now()+make_interval(secs => ${15 * job.attempts}),error_message=${(error instanceof Error ? error.message : 'unknown').slice(0, 500)},updated_at=now()
          WHERE id=${job.id} AND lease_token=${job.lease_token} RETURNING id`;
        return row ? 'queued' as ImportJobState : 'fenced';
      } catch (inner) {
        if (inner instanceof Fenced) return 'fenced';
        throw inner;
      }
    }
  }

  private async commit(job: JobRow & { lease_token: string }, input:
    { reusedId: string } | { revisionId: string; entry: string; prefix: string; fingerprint: string; manifest: unknown; report: unknown; keepSource?: boolean }): Promise<ImportJobState | 'fenced'> {
    const outcome = await this.sql.begin(async (tx) => {
      const [locked] = await tx`SELECT id FROM vsl_page_import_jobs WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running' FOR UPDATE`;
      if (!locked) return { fenced: true as const };
      await tx`SELECT id FROM vsl_pages WHERE id=${job.page_id} FOR UPDATE`;
      let revisionId: string, reused: boolean, report: unknown = null;
      if ('reusedId' in input) { revisionId = input.reusedId; reused = true; }
      else {
        const [existing] = await tx`SELECT id FROM vsl_page_revisions WHERE page_id=${job.page_id} AND fingerprint=${input.fingerprint}`;
        if (existing) { revisionId = String(existing.id); reused = true; }
        else {
          const [count] = await tx`SELECT COALESCE(MAX(version_number),0)+1 AS next FROM vsl_page_revisions WHERE page_id=${job.page_id}`;
          await tx`INSERT INTO vsl_page_revisions(id,page_id,version_number,entry_path,storage_prefix,manifest,validation_report,source_sha256,fingerprint,status)
            VALUES(${input.revisionId},${job.page_id},${count!.next},${input.entry},${input.prefix},${tx.json(input.manifest as never)},${tx.json(input.report as never)},${job.source_sha256},${input.fingerprint},'ready')`;
          await tx`UPDATE vsl_pages SET current_revision_id=${input.revisionId},updated_at=now() WHERE id=${job.page_id}`;
          revisionId = input.revisionId; reused = false; report = input.report;
        }
      }
      if (reused) {
        const [prior] = await tx`SELECT validation_report FROM vsl_page_revisions WHERE id=${revisionId}`;
        report = prior?.validation_report ?? null;
      }
      await tx`UPDATE vsl_page_import_jobs SET state='succeeded',stage='done',progress=100,revision_id=${revisionId},reused=${reused},
        report=${report ? tx.json(report as never) : null},lease_token=NULL,lease_until=NULL,error_code=NULL,error_message=NULL,finished_at=now(),updated_at=now()
        WHERE id=${job.id}`;
      return { fenced: false as const, reused, revisionId };
    });
    if (outcome.fenced) throw new Fenced('fenced');
    if (outcome.reused && 'prefix' in input) await this.storage.deletePrefix(input.prefix).catch(() => undefined);
    if (!('keepSource' in input && input.keepSource && !outcome.reused)) await this.storage.deletePrefix(`vsl/sources/g3/${job.id}`).catch(() => undefined);
    return 'succeeded';
  }

  /**
   * Revisão derivada (edição de textos / aplicar tradução): copia os arquivos da revisão base byte a byte,
   * troca só os trechos editados do HTML de entrada e o caminho de assets da revisão
   * (`/__vsl/assets/<base>/` → `/__vsl/assets/<nova>/`, necessário para o runtime servir os assets), e sela.
   */
  private async processDerived(job: JobRow & { lease_token: string }): Promise<ImportJobState | 'fenced'> {
    let prefix: string | null = null;
    let committed = false;
    try {
      if (job.attempts > job.max_attempts) {
        await this.finish(job, 'failed', { code: 'import_failed', detail: 'attempts exhausted' });
        return 'failed';
      }
      const payload = job.payload!;
      const [base] = await this.sql<Array<{ id: string; storage_prefix: string; entry_path: string; manifest: Manifest; status: string; storage_deleted_at: Date | null; validation_report: Record<string, unknown> | null }>>`
        SELECT id,storage_prefix,entry_path,manifest,status,storage_deleted_at,validation_report FROM vsl_page_revisions WHERE id=${job.base_revision_id}`;
      if (!base || base.status !== 'ready' || base.storage_deleted_at) throw new Deterministic('revision_not_found', 'base revision unavailable');
      await this.stage(job, 'extracting', 15);
      const entryBytes = await this.storage.read(`${base.storage_prefix}/${base.entry_path}`);
      let html: string;
      try { html = applyPageTextEdits(decodePageHtml(entryBytes), payload.edits, { lang: payload.lang }); }
      catch (error) {
        if (error instanceof PageTextError) throw new Deterministic(error.reason === 'encoding' ? 'page_text_unsupported' : 'text_edit_invalid', error.reason);
        throw error;
      }
      const targetPageId = payload.target?.pageId ?? job.page_id;
      const fingerprint = digest(canonical({ operation: job.operation, base: base.id, edits: payload.edits, lang: payload.lang ?? null }));
      const [prior] = await this.sql`SELECT id FROM vsl_page_revisions WHERE page_id=${targetPageId} AND fingerprint=${fingerprint}`;
      if (prior) return await this.commitDerived(job, base, { reusedId: String(prior.id) });
      const revisionId = randomUUID();
      prefix = `vsl/releases/${targetPageId}/${revisionId}`;
      await this.stage(job, 'writing', 40);
      const from = `/__vsl/assets/${base.id}/`;
      const to = `/__vsl/assets/${revisionId}/`;
      const entries = Object.entries(base.manifest.files);
      const files: Manifest['files'] = {};
      let entrySha = '';
      for (const [index, [path, asset]] of entries.entries()) {
        let bytes = path === base.manifest.entryPath ? Buffer.from(html, 'utf8') : await this.storage.read(`${base.storage_prefix}/${asset.storageKey}`);
        if (TEXT_ASSET_MIME.test(asset.mimeType)) bytes = replaceBytes(bytes, from, to);
        await this.storage.putExclusive(`${prefix}/${path}`, bytes);
        files[path] = { storageKey: path, mimeType: asset.mimeType, bytes: bytes.length, sha256: digest(bytes) };
        if (path === base.manifest.entryPath) entrySha = files[path]!.sha256;
        if (index % 25 === 24) await this.stage(job, 'writing', 40 + Math.floor((45 * (index + 1)) / entries.length));
      }
      const manifest: Manifest = { version: 1, entryPath: base.manifest.entryPath, files };
      await this.stage(job, 'sealing', 90);
      await this.storage.seal(prefix, manifest);
      if (!(await this.storage.isSealed(prefix, manifest))) throw new Error('Page release seal failed');
      const state = await this.commitDerived(job, base, { revisionId, prefix, fingerprint, manifest, sourceSha256: entrySha });
      committed = true;
      return state;
    } catch (error) {
      if (!committed && prefix) await this.storage.deletePrefix(prefix).catch(() => undefined);
      return this.failAttempt(job, error);
    }
  }

  private async commitDerived(job: JobRow & { lease_token: string }, base: { id: string; entry_path: string; validation_report: Record<string, unknown> | null },
    input: { reusedId: string } | { revisionId: string; prefix: string; fingerprint: string; manifest: Manifest; sourceSha256: string }): Promise<ImportJobState | 'fenced'> {
    const payload = job.payload!;
    const target = payload.target;
    const pageId = target?.pageId ?? job.page_id;
    const outcome = await this.sql.begin(async (tx) => {
      const [locked] = await tx`SELECT id FROM vsl_page_import_jobs WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running' FOR UPDATE`;
      if (!locked) return { fenced: true as const };
      if (target) await tx`INSERT INTO vsl_pages(id,name,store_id,locale) VALUES(${target.pageId},${target.name},'l0i',${target.locale}) ON CONFLICT (id) DO NOTHING`;
      await tx`SELECT id FROM vsl_pages WHERE id=${pageId} FOR UPDATE`;
      let revisionId: string;
      let reused = true;
      if ('reusedId' in input) revisionId = input.reusedId;
      else {
        const [existing] = await tx`SELECT id FROM vsl_page_revisions WHERE page_id=${pageId} AND fingerprint=${input.fingerprint}`;
        if (existing) revisionId = String(existing.id);
        else {
          const [count] = await tx`SELECT COALESCE(MAX(version_number),0)+1 AS next FROM vsl_page_revisions WHERE page_id=${pageId}`;
          const report = { ...(base.validation_report ?? {}), derivedFrom: { revisionId: base.id, operation: job.operation, jobId: job.id } };
          await tx`INSERT INTO vsl_page_revisions(id,page_id,version_number,entry_path,storage_prefix,manifest,validation_report,source_sha256,fingerprint,status)
            VALUES(${input.revisionId},${pageId},${count!.next},${base.entry_path},${input.prefix},${tx.json(input.manifest as never)},${tx.json(report as never)},${input.sourceSha256},${input.fingerprint},'ready')`;
          revisionId = input.revisionId;
          reused = false;
        }
      }
      await tx`UPDATE vsl_pages SET current_revision_id=${revisionId},updated_at=now() WHERE id=${pageId}`;
      if (target) {
        await tx`UPDATE vsl_page_translations SET status='done',progress=100,target_page_id=${pageId},target_revision_id=${revisionId},
          error_code=NULL,error_message=NULL,finished_at=now(),updated_at=now() WHERE id=${target.translationId} AND apply_job_id=${job.id}`;
        // "Duplicar funil em outro idioma": as etapas da cópia que ainda usam a revisão de origem passam para a traduzida.
        const [translation] = await tx`SELECT link_step_ids FROM vsl_page_translations WHERE id=${target.translationId}`;
        const stepIds = Array.isArray(translation?.link_step_ids) ? (translation!.link_step_ids as string[]) : [];
        if (stepIds.length) {
          const moved = await tx`UPDATE vsl_steps SET page_revision_id=${revisionId},version=version+1,updated_at=now()
            WHERE id IN ${tx(stepIds)} AND page_revision_id=${base.id} AND status<>'archived' RETURNING project_id`;
          const projects = [...new Set(moved.map((row) => String(row.project_id)))];
          if (projects.length) await tx`UPDATE vsl_projects SET version=version+1,updated_at=now() WHERE id IN ${tx(projects)} AND status<>'archived'`;
        }
      }
      await tx`UPDATE vsl_page_import_jobs SET state='succeeded',stage='done',progress=100,revision_id=${revisionId},reused=${reused},
        report=${tx.json({ targetPageId: pageId } as never)},lease_token=NULL,lease_until=NULL,error_code=NULL,error_message=NULL,finished_at=now(),updated_at=now()
        WHERE id=${job.id}`;
      return { fenced: false as const, reused };
    });
    if (outcome.fenced) throw new Fenced('fenced');
    if (outcome.reused && 'prefix' in input) await this.storage.deletePrefix(input.prefix).catch(() => undefined);
    return 'succeeded';
  }
}
