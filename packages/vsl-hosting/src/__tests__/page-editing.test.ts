// Edição de textos e tradução sobre Postgres real (PGlite) + storage local: revisão derivada pelo pipeline de jobs,
// bytes preservados, caminho de assets da revisão, tradução com provider fake, aplicar → nova página no idioma.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AnthropicCopyTranslator, extractPageTextBlocks, FakeCopyTranslator, LocalVslStorage, protectSegments, restoreSegments, VslPageImportJobs,
  VslPageTranslations, type Manifest,
} from '../index.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

import { zip } from './helpers.js';

let db: VslTestDatabase;
let root: string;
let storage: LocalVslStorage;
beforeAll(async () => {
  db = await startVslTestDatabase();
  root = await mkdtemp(path.join(tmpdir(), 'vsl-editing-'));
  storage = new LocalVslStorage(root);
}, 60_000);
afterAll(async () => {
  await db?.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => { await db.reset(); });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const INDEX = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Método Leve</title><link rel="stylesheet" href="style.css"></head>
<body><h1>Emagreça sem dieta</h1><img src="img.png" alt="Foto do produto"><p>Por apenas R$ 197,00 — acesse https://leve.example.com/termos</p>
<a id="cta" class="btn" href="#">Quero meu acesso</a><p>Quero meu acesso</p>
<script>var quiz = { questions: [{ question: 'Qual seu objetivo?', answers: ['Perder peso', 'Ganhar energia'] }] };</script></body></html>`;
const CSS = 'body{background:url(img.png)} h1{color:#111}';

async function importPage(): Promise<{ pageId: string; revisionId: string }> {
  const [page] = await db.sql`INSERT INTO vsl_pages(name) VALUES('Método Leve') RETURNING id`;
  const bytes = zip([{ name: 'index.html', bytes: Buffer.from(INDEX) }, { name: 'style.css', bytes: Buffer.from(CSS) }, { name: 'img.png', bytes: PNG }]);
  const jobs = new VslPageImportJobs(db.sql, storage);
  await jobs.submit({ pageId: String(page!.id), idempotencyKey: 'imp', kind: 'zip', config: {}, contentLength: bytes.length, source: Readable.from([bytes]) });
  const claimed = (await jobs.claimNext())!;
  expect(await jobs.process(claimed)).toBe('succeeded');
  const [revision] = await db.sql`SELECT id FROM vsl_page_revisions WHERE page_id=${page!.id}`;
  return { pageId: String(page!.id), revisionId: String(revision!.id) };
}
async function revisionFiles(revisionId: string) {
  const [row] = await db.sql`SELECT storage_prefix,manifest,entry_path,validation_report,status FROM vsl_page_revisions WHERE id=${revisionId}`;
  const manifest = row!.manifest as Manifest;
  const files: Record<string, Buffer> = {};
  for (const key of Object.keys(manifest.files)) files[key] = await storage.read(`${row!.storage_prefix}/${key}`);
  return { row: row!, files, sealed: await storage.isSealed(String(row!.storage_prefix), manifest) };
}
async function runJob(jobs: VslPageImportJobs) {
  const claimed = await jobs.claimNext();
  expect(claimed).toBeTruthy();
  return jobs.process(claimed!);
}

describe('text editing → derived revision', () => {
  it('lists blocks, applies edits through a job and keeps every other byte', async () => {
    const { pageId, revisionId } = await importPage();
    const jobs = new VslPageImportJobs(db.sql, storage);
    const { blocks } = await jobs.texts(pageId, revisionId);
    const title = blocks.find((block) => block.text === 'Emagreça sem dieta')!;
    const question = blocks.find((block) => block.text === 'Qual seu objetivo?')!;
    expect(title).toMatchObject({ kind: 'text', label: 'Título' });
    expect(question).toMatchObject({ kind: 'script-string', label: 'Pergunta do quiz' });

    // Step usando a revisão original não muda sozinha.
    const [project] = await db.sql`INSERT INTO vsl_projects(name) VALUES('Funil') RETURNING id`;
    const [step] = await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname,page_revision_id) VALUES(${project!.id},0,'VSL','/',${revisionId}) RETURNING id,version`;

    const { job, created } = await jobs.submitTextEdit(pageId, revisionId, [{ id: title.id, text: 'Lose weight without dieting' }, { id: question.id, text: 'Your goal?' }], 'edit-1');
    expect(created).toBe(true);
    expect(job).toMatchObject({ operation: 'text_edit', state: 'queued' });
    expect((await jobs.submitTextEdit(pageId, revisionId, [{ id: title.id, text: 'Lose weight without dieting' }, { id: question.id, text: 'Your goal?' }], 'edit-1')).created).toBe(false);
    await expect(jobs.submitTextEdit(pageId, revisionId, [{ id: title.id, text: 'Outro' }], 'edit-1')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await runJob(jobs)).toBe('succeeded');
    const done = await jobs.get(pageId, job.id);
    const newRevision = done.result!.revisionId!;
    expect(done.result).toMatchObject({ pageId, reused: false });

    const before = await revisionFiles(revisionId);
    const after = await revisionFiles(newRevision);
    expect(after.sealed).toBe(true);
    expect(after.row.validation_report).toMatchObject({ derivedFrom: { revisionId, operation: 'text_edit' } });
    expect(after.files['img.png']!.equals(before.files['img.png']!)).toBe(true);
    const oldBase = `/__vsl/assets/${revisionId}/`, newBase = `/__vsl/assets/${newRevision}/`;
    expect(before.files['index.html']!.toString()).toContain(oldBase);
    // Único diff além das edições: o caminho de assets da revisão.
    const expected = before.files['index.html']!.toString().split(oldBase).join(newBase)
      .replace('Emagreça sem dieta', 'Lose weight without dieting').replace("'Qual seu objetivo?'", "'Your goal?'");
    expect(after.files['index.html']!.toString()).toBe(expected);
    expect(after.files['style.css']!.toString()).toBe(before.files['style.css']!.toString().split(oldBase).join(newBase));

    const [page] = await db.sql`SELECT current_revision_id FROM vsl_pages WHERE id=${pageId}`;
    expect(page!.current_revision_id).toBe(newRevision);
    const [stepAfter] = await db.sql`SELECT page_revision_id,version FROM vsl_steps WHERE id=${step!.id}`;
    expect(stepAfter).toMatchObject({ page_revision_id: revisionId, version: step!.version });
  });

  it('rejects unknown blocks, bad payloads and missing revisions with stable codes', async () => {
    const { pageId, revisionId } = await importPage();
    const jobs = new VslPageImportJobs(db.sql, storage);
    await expect(jobs.submitTextEdit(pageId, revisionId, [{ id: 't0000000000000000', text: 'x' }])).rejects.toMatchObject({ code: 'text_edit_invalid', details: { reason: 'unknown_block' } });
    await expect(jobs.submitTextEdit(pageId, revisionId, [])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(jobs.submitTextEdit(pageId, revisionId, [{ id: 'nope', text: 'x' }])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(jobs.texts(pageId, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'revision_not_found' });
    await expect(jobs.texts('00000000-0000-4000-8000-000000000000', revisionId)).rejects.toMatchObject({ code: 'page_not_found' });
  });
});

describe('page translation', () => {
  it('translates in batches with the fake provider, accepts review edits and applies as a new page', async () => {
    const { pageId, revisionId } = await importPage();
    const fake = new FakeCopyTranslator();
    const service = new VslPageTranslations(db.sql, storage, { providerAvailable: async () => true, translator: async () => fake, batch: { items: 3, chars: 1000 } });
    // Duplicar funil: etapa da cópia passa para a revisão traduzida ao aplicar.
    const [project] = await db.sql`INSERT INTO vsl_projects(name) VALUES('Cópia IT') RETURNING id`;
    const [step] = await db.sql`INSERT INTO vsl_steps(project_id,position,name,pathname,page_revision_id) VALUES(${project!.id},0,'VSL','/',${revisionId}) RETURNING id,version`;
    const translation = await service.create(pageId, { sourceRevisionId: revisionId, targetLocale: 'it' }, [String(step!.id)]);
    expect(translation).toMatchObject({ status: 'translating', sourceLocale: 'pt-BR', targetLocale: 'it', progress: 0 });

    const claimed = (await service.claimNext())!;
    expect(await service.process(claimed)).toBe('review');
    // "Quero meu acesso" aparece 2x mas vai uma vez ao provider; URLs e preços vão protegidos por marcadores.
    const sent = fake.calls.flatMap((call) => call.items.map((item) => item.text));
    expect(sent.filter((text) => text === 'Quero meu acesso')).toHaveLength(1);
    expect(sent.some((text) => text.includes('⟦0⟧') && !text.includes('R$') && !text.includes('https://'))).toBe(true);
    expect(fake.calls.length).toBeGreaterThan(1);

    const { translation: reviewed, units } = await service.get(translation.id);
    expect(reviewed).toMatchObject({ status: 'review', progress: 100, provider: 'fake' });
    expect(units.every((unit) => unit.translated?.startsWith('[it] '))).toBe(true);
    const price = units.find((unit) => unit.source.includes('R$ 197,00'))!;
    expect(price.translated).toBe(`[it] ${price.source}`);
    const title = units.find((unit) => unit.source === 'Emagreça sem dieta')!;
    const patched = await service.patchUnits(translation.id, [{ id: title.id, translated: 'Dimagrisci senza dieta' }, { id: price.id, status: 'approved' }]);
    expect(patched.units).toEqual([expect.objectContaining({ id: title.id, status: 'edited', translated: 'Dimagrisci senza dieta' }),
      expect.objectContaining({ id: price.id, status: 'approved' })].sort((a, b) => units.findIndex((u) => u.id === a.id) - units.findIndex((u) => u.id === b.id)));
    const quiz = units.find((unit) => unit.kind === 'script-string')!;
    await expect(service.patchUnits(translation.id, [{ id: quiz.id, translated: '<b>x</b>' }])).rejects.toMatchObject({ code: 'text_edit_invalid' });

    const applied = await service.apply(translation.id, {});
    expect(applied.created).toBe(true);
    expect(applied.job).toMatchObject({ operation: 'translation_apply', state: 'queued', pageId });
    expect((await service.apply(translation.id, {})).job.id).toBe(applied.job.id);
    expect((await service.get(translation.id)).translation.status).toBe('applying');
    expect(await runJob(service.jobs)).toBe('succeeded');

    const final = await service.get(translation.id);
    expect(final.translation).toMatchObject({ status: 'done', progress: 100 });
    const job = await service.jobs.get(pageId, applied.job.id);
    expect(job.result!.pageId).toBe(final.translation.targetPageId);
    const [newPage] = await db.sql`SELECT name,locale,current_revision_id FROM vsl_pages WHERE id=${final.translation.targetPageId}`;
    expect(newPage).toMatchObject({ name: 'Método Leve (IT)', locale: 'it', current_revision_id: final.translation.targetRevisionId });
    const { files } = await revisionFiles(String(final.translation.targetRevisionId));
    const html = files['index.html']!.toString();
    expect(html).toContain('<html lang="it">');
    expect(html).toContain('Dimagrisci senza dieta');
    expect(html).toContain('R$ 197,00');
    expect(html).toContain('https://leve.example.com/termos');
    expect(extractPageTextBlocks(html).find((block) => block.kind === 'script-string')!.text).toBe('[it] Qual seu objetivo?');
    const [stepAfter] = await db.sql`SELECT page_revision_id,version FROM vsl_steps WHERE id=${step!.id}`;
    expect(stepAfter).toMatchObject({ page_revision_id: final.translation.targetRevisionId, version: step!.version + 1 });
  });

  it('enforces provider, locale and character limit', async () => {
    const { pageId, revisionId } = await importPage();
    await expect(new VslPageTranslations(db.sql, storage, { providerAvailable: async () => false }).create(pageId, { sourceRevisionId: revisionId, targetLocale: 'it' }))
      .rejects.toMatchObject({ code: 'translation_provider_unavailable' });
    const service = new VslPageTranslations(db.sql, storage, { providerAvailable: async () => true, maxChars: 20 });
    await expect(service.create(pageId, { sourceRevisionId: revisionId, targetLocale: 'xx' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(service.create(pageId, { sourceRevisionId: revisionId, targetLocale: 'en' })).rejects.toMatchObject({ code: 'translation_too_large', details: { maxChars: 20 } });
    const ok = await new VslPageTranslations(db.sql, storage, { providerAvailable: async () => true }).create(pageId, { sourceRevisionId: revisionId, targetLocale: 'en' });
    await expect(service.apply(ok.id)).rejects.toMatchObject({ code: 'translation_not_ready' });
    // Worker sem chave: tradução falha com código estável.
    const noKey = new VslPageTranslations(db.sql, storage, { translator: async () => null });
    expect(await noKey.process((await noKey.claimNext())!)).toBe('failed');
    expect((await noKey.get(ok.id)).translation.error).toMatchObject({ code: 'translation_provider_unavailable' });
  });

  it('retries transient provider failures and keeps partial progress', async () => {
    const { pageId, revisionId } = await importPage();
    let calls = 0;
    const flaky = { provider: 'fake', model: 'flaky', translate: vi.fn(async (request: { items: Array<{ key: string; text: string }> }) => {
      calls++;
      if (calls === 2) throw new Error('socket hang up');
      return Object.fromEntries(request.items.map((item) => [item.key, `EN ${item.text}`]));
    }) };
    const service = new VslPageTranslations(db.sql, storage, { providerAvailable: async () => true, translator: async () => flaky, batch: { items: 2, chars: 1000 } });
    const created = await service.create(pageId, { sourceRevisionId: revisionId, targetLocale: 'en' });
    expect(await service.process((await service.claimNext())!)).toBe('retry');
    const partial = await service.get(created.id);
    expect(partial.translation.status).toBe('translating');
    expect(partial.units.filter((unit) => unit.translated).length).toBeGreaterThan(0);
    await db.sql`UPDATE vsl_page_translations SET run_after=now() WHERE id=${created.id}`;
    expect(await service.process((await service.claimNext())!)).toBe('review');
    expect((await service.get(created.id)).units.every((unit) => unit.translated?.startsWith('EN '))).toBe(true);
  });
});

describe('translation helpers', () => {
  it('protects URLs, e-mails, placeholders and prices', () => {
    const { masked, tokens } = protectSegments('Só R$ 197,00 ou 49,90 € hoje em https://x.com/a, fale com ajuda@x.com, {{nome}}');
    expect(tokens).toEqual(['https://x.com/a', 'ajuda@x.com', '{{nome}}', 'R$ 197,00', '49,90 €']);
    expect(masked).toBe('Só ⟦3⟧ ou ⟦4⟧ hoje em ⟦0⟧, fale com ⟦1⟧, ⟦2⟧');
    expect(restoreSegments('Only ⟦3⟧ or ⟦4⟧ today at ⟦0⟧, write ⟦1⟧, ⟦2⟧', tokens)).toBe('Only R$ 197,00 or 49,90 € today at https://x.com/a, write ajuda@x.com, {{nome}}');
    expect(restoreSegments('Only ⟦3⟧ today', tokens)).toBeNull();
  });

  it('calls the Anthropic Messages API with the sales-copy prompt and parses JSON', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { model: string; system: string; messages: Array<{ content: string }> };
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.system).toMatch(/persuasive sales tone/);
      expect(body.system).toMatch(/never convert currencies/);
      expect(JSON.parse(body.messages[0]!.content)).toMatchObject({ items: [{ key: '0', text: 'Olá' }] });
      expect((init!.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
      return Response.json({ content: [{ type: 'text', text: 'Here:\n{"t":{"0":"Ciao"}}' }] });
    }) as unknown as typeof fetch;
    const translator = new AnthropicCopyTranslator('sk-test', undefined, fetcher);
    expect(await translator.translate({ sourceLocale: 'pt-BR', targetLocale: 'it', pageTitle: 'P', items: [{ key: '0', text: 'Olá', kind: 'text', label: 'Título', context: '' }] }))
      .toEqual({ '0': 'Ciao' });
    const denied = new AnthropicCopyTranslator('bad', undefined, (async () => new Response('no', { status: 401 })) as unknown as typeof fetch);
    await expect(denied.translate({ sourceLocale: null, targetLocale: 'en', pageTitle: '', items: [] })).rejects.toMatchObject({ kind: 'auth' });
  });
});
