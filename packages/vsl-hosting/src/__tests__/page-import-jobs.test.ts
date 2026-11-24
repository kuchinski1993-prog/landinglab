// Import G3 assíncrono: submit (stream) → claim (lease) → process (fencing) num Postgres real.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { importErrorMessage, LocalVslStorage, VslError, VslPageImportJobs } from '../index.js';
import { startVslTestDatabase, type VslTestDatabase } from '../testing/pg-harness.js';

import { fakeFetcher, webp, zip } from './helpers.js';

let db: VslTestDatabase;
let root: string;
let storage: LocalVslStorage;
let jobs: VslPageImportJobs;
let pageId: string;
// Sem rede nos testes: por padrão todo download devolve 404 (o import cai no "manter externo").
let fetcher: ReturnType<typeof fakeFetcher>;

beforeAll(async () => { db = await startVslTestDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.reset();
  root = await mkdtemp(path.join(tmpdir(), 'vsl-import-jobs-'));
  storage = new LocalVslStorage(root);
  fetcher = fakeFetcher({});
  jobs = new VslPageImportJobs(db.sql, storage, undefined, { fetcher });
  const [page] = await db.sql`INSERT INTO vsl_pages(name) VALUES('Página') RETURNING id`;
  pageId = String(page!.id);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const html = Buffer.from('<html><head><title>Oferta</title></head><body><h1>Oferta</h1><a id="cta">Comprar</a></body></html>');
const submit = (bytes: Buffer, key = 'k1', kind: 'html' | 'zip' = 'html', config: unknown = {}) =>
  jobs.submit({ pageId, idempotencyKey: key, kind, config, contentLength: bytes.length, source: Readable.from([bytes]) });

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...(await files(full)));
    else out.push(path.relative(root, full));
  }
  return out;
}

describe('VslPageImportJobs', () => {
  it('stores the upload, then the worker builds a sealed revision and drops the source', async () => {
    const { job, created } = await submit(html);
    expect(created).toBe(true);
    expect(job).toMatchObject({ state: 'queued', progress: 0, result: null });
    expect(await files(root)).toEqual([`vsl/sources/g3/${job.id}/original.html`]);

    const claimed = await jobs.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(await jobs.claimNext()).toBeNull(); // lease ativo: ninguém mais pega
    expect(await jobs.process(claimed!)).toBe('succeeded');

    const done = await jobs.get(pageId, job.id);
    expect(done.state).toBe('succeeded');
    expect(done.progress).toBe(100);
    expect(done.result?.reused).toBe(false);
    const [page] = await db.sql`SELECT current_revision_id FROM vsl_pages WHERE id=${pageId}`;
    expect(page?.current_revision_id).toBe(done.result?.revisionId);
    const stored = await files(root);
    expect(stored.some((file) => file.startsWith('vsl/sources/'))).toBe(false);
    expect(stored).toContain(`vsl/releases/${pageId}/${done.result?.revisionId}/.sealed`);
  });

  it('is idempotent per key and rejects the same key with a different upload', async () => {
    const first = await submit(html, 'same');
    const again = await submit(html, 'same');
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    await expect(submit(Buffer.concat([html, Buffer.from(' ')]), 'same')).rejects.toMatchObject({ code: 'idempotency_conflict', statusCode: 409 });
  });

  it('validates content length, size limit, config and page', async () => {
    await expect(jobs.submit({ pageId, idempotencyKey: 'a', kind: 'html', config: {}, contentLength: undefined, source: Readable.from([html]) }))
      .rejects.toMatchObject({ code: 'content_length_required' });
    await expect(jobs.submit({ pageId, idempotencyKey: 'a', kind: 'html', config: {}, contentLength: 6 * 1024 ** 2, source: Readable.from([html]) }))
      .rejects.toMatchObject({ code: 'payload_too_large' });
    await expect(submit(html, 'b', 'html', { unknown: 1 })).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(jobs.submit({ pageId: '00000000-0000-4000-8000-000000000000', idempotencyKey: 'c', kind: 'html', config: {}, contentLength: html.length, source: Readable.from([html]) }))
      .rejects.toMatchObject({ code: 'page_not_found' });
    // Content-Length mentiroso: a gravação falha e nada fica no storage.
    await expect(jobs.submit({ pageId, idempotencyKey: 'd', kind: 'html', config: {}, contentLength: html.length + 5, source: Readable.from([html]) }))
      .rejects.toBeInstanceOf(VslError);
    expect(await files(root)).toEqual([]);
  });

  it('asks for the entry HTML when the ZIP is ambiguous and resumes without re-upload', async () => {
    const archive = zip([{ name: 'a.html', bytes: html }, { name: 'b.html', bytes: html }]);
    const { job } = await submit(archive, 'zip', 'zip');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('needs_resolution');
    const waiting = await jobs.get(pageId, job.id);
    expect(waiting.resolution).toMatchObject({ code: 'import_entry_required', candidates: ['a.html', 'b.html'] });
    await expect(jobs.resume(pageId, job.id, { entryPath: 'zzz.html' })).rejects.toMatchObject({ code: 'import_entry_required' });
    const resumed = await jobs.resume(pageId, job.id, { entryPath: 'b.html' });
    expect(resumed.state).toBe('queued');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    await expect(jobs.resume(pageId, job.id, {})).rejects.toMatchObject({ code: 'import_not_resumable' });
  });

  it('never stops for decisions: external script stays, origin is authorized and the finding is a PT-BR warning', async () => {
    const page = Buffer.from('<html><body><script src="https://cdn.example.com/app.js"></script></body></html>');
    const { job } = await submit(page, 'ext');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const view = await jobs.get(pageId, job.id);
    const finding = view.result?.findings.find((item) => item.code === 'external_kept');
    expect(finding).toMatchObject({ severity: 'warning', evidence: 'https://cdn.example.com/app.js' });
    expect(finding?.message).toMatch(/site original/);
    expect(view.result?.summary).toMatchObject({ keptExternal: 1, externalOrigins: ['https://cdn.example.com'], missing: [] });
    const [revision] = await db.sql`SELECT validation_report FROM vsl_page_revisions WHERE id=${view.result!.revisionId}`;
    expect((revision!.validation_report as { config: { externalOrigins: string[] } }).config.externalOrigins).toEqual(['https://cdn.example.com']);
  });

  it('runs the smart pipeline in the worker: downloads resources, replaces the player, removes trackers', async () => {
    fetcher = fakeFetcher({ 'https://cdn.example.net/logo.webp': { contentType: 'image/webp', body: webp() } });
    jobs = new VslPageImportJobs(db.sql, storage, undefined, { fetcher });
    const page = Buffer.from('<html><head><script>fbq("init","1");fbq("track","PageView")</script></head><body><img src="https://cdn.example.net/logo.webp">' +
      '<iframe src="https://player.vimeo.com/video/1" width="640" height="360"></iframe><a href="/checkout">Comprar</a></body></html>');
    const { job } = await submit(page, 'smart');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const view = await jobs.get(pageId, job.id);
    expect(view.result?.summary).toMatchObject({ localized: { images: 1 }, player: { provider: 'Vimeo', aspectRatio: '16:9' }, trackersRemoved: ['Meta Pixel'] });
    const [revision] = await db.sql`SELECT storage_prefix,manifest FROM vsl_page_revisions WHERE id=${view.result!.revisionId}`;
    const entry = (await storage.read(`${revision!.storage_prefix}/index.html`)).toString();
    expect(entry).toContain(`src="/__vsl/assets/${view.result!.revisionId}/_external/cdn.example.net/`);
    expect(entry).toContain('<div data-blackshop-video data-blackshop-aspect-ratio="16:9" style="width:100%"></div>');
    expect(entry).not.toMatch(/fbq|vimeo/);
    // Nada faltando → upload apagado como antes.
    expect((await files(root)).some((file) => file.startsWith('vsl/sources/'))).toBe(false);
  });

  it('picks index.html as the entry of a multi-page ZIP without asking', async () => {
    const { job } = await submit(zip([{ name: 'obrigado.html', bytes: html }, { name: 'index.html', bytes: html }]), 'multi', 'zip');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const [revision] = await db.sql`SELECT entry_path FROM vsl_page_revisions WHERE id=${(await jobs.get(pageId, job.id)).result!.revisionId}`;
    expect(revision?.entry_path).toBe('index.html');
  });

  it('reprocesses an old job stuck in needs_resolution with the smart importer (same upload, no justification)', async () => {
    const page = Buffer.from('<html><body><h1>VSL</h1><iframe src="https://player-vz-1.tv.pandavideo.com/embed/?v=1"></iframe></body></html>');
    const { job } = await submit(page, 'old', 'html', { resolutions: { abcdefabcdefabcdefabcdef: 'justificativa antiga' } });
    // Estado de um job analisado pelo importador antigo.
    await db.sql`UPDATE vsl_page_import_jobs SET state='needs_resolution',stage='needs_resolution',
      report=${db.sql.json({ resolutionCode: 'import_needs_resolution', pending: ['x'], findings: [] } as never)} WHERE id=${job.id}`;
    const old = await jobs.get(pageId, job.id);
    expect(old.resolution).toMatchObject({ code: 'import_needs_resolution', reprocessable: true });
    await expect(jobs.reprocess(pageId, job.id, { sourceUrl: 'http://127.0.0.1/' })).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(jobs.reprocess(pageId, job.id, { other: 1 })).rejects.toMatchObject({ code: 'validation_failed' });
    const { job: queued, created } = await jobs.reprocess(pageId, job.id, {});
    expect(created).toBe(false);
    expect(queued).toMatchObject({ id: job.id, state: 'queued', resolution: null });
    await expect(jobs.reprocess(pageId, job.id, {})).rejects.toMatchObject({ code: 'import_not_resumable' });
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const done = await jobs.get(pageId, job.id);
    expect(done.result?.summary?.player?.provider).toBe('Panda Video');
    const [row] = await db.sql`SELECT config FROM vsl_page_import_jobs WHERE id=${job.id}`;
    expect(row!.config).not.toHaveProperty('resolutions');
  });

  it('keeps the upload when files are missing and fetches them after "Informar URL de origem"', async () => {
    const page = Buffer.from('<html><head><link rel="stylesheet" href="/_astro/global.ABCDEFGH.css"></head><body><h1>x</h1></body></html>');
    const { job } = await submit(page, 'missing');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const first = await jobs.get(pageId, job.id);
    expect(first.result?.summary?.missing).toEqual([{ path: '_astro/global.ABCDEFGH.css', file: 'index.html' }]);
    expect(await files(root)).toContain(`vsl/sources/g3/${job.id}/original.html`);

    fetcher = fakeFetcher({ 'https://loja.example.com/_astro/global.ABCDEFGH.css': { contentType: 'text/css', body: 'h1{color:red}' } });
    jobs = new VslPageImportJobs(db.sql, storage, undefined, { fetcher });
    const { job: again, created } = await jobs.reprocess(pageId, job.id, { sourceUrl: 'https://loja.example.com/' });
    expect(created).toBe(true);
    expect(again.id).not.toBe(job.id);
    expect((await jobs.reprocess(pageId, job.id, { sourceUrl: 'https://loja.example.com/' })).job.id).toBe(again.id); // idempotente
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const second = await jobs.get(pageId, again.id);
    expect(second.result?.summary).toMatchObject({ missing: [], recovered: [{ path: '_astro/global.ABCDEFGH.css', from: 'site' }], originFrom: 'config' });
    const [page2] = await db.sql`SELECT current_revision_id FROM vsl_pages WHERE id=${pageId}`;
    expect(page2?.current_revision_id).toBe(second.result?.revisionId);
    // Sem upload guardado: não dá para reprocessar.
    await storage.deletePrefix(`vsl/sources/g3/${job.id}`);
    await expect(jobs.reprocess(pageId, job.id, { sourceUrl: 'https://outra.example.com/' })).rejects.toMatchObject({ code: 'import_source_unavailable' });
  });

  it('imports from a link with the same pipeline (sourceUrl = final address) and maps fetch errors', async () => {
    fetcher = fakeFetcher({
      'https://vsl.example.com/oferta': { contentType: 'text/html; charset=utf-8', body: '<html><body><img src="/img/a.webp"></body></html>', redirect: 'https://vsl.example.com/oferta/' },
      'https://vsl.example.com/img/a.webp': { contentType: 'image/webp', body: webp() },
      'https://vsl.example.com/arquivo.pdf': { contentType: 'application/pdf', body: '%PDF' },
      'https://interno.example.com/': { contentType: 'text/html', body: '', status: 403 },
    });
    jobs = new VslPageImportJobs(db.sql, storage, undefined, { fetcher });
    const { job, created } = await jobs.submitFromUrl({ pageId, url: 'https://vsl.example.com/oferta', idempotencyKey: 'url-1' });
    expect(created).toBe(true);
    const [row] = await db.sql`SELECT kind,config FROM vsl_page_import_jobs WHERE id=${job.id}`;
    expect(row).toMatchObject({ kind: 'html', config: { sourceUrl: 'https://vsl.example.com/oferta/' } });
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    expect((await jobs.get(pageId, job.id)).result?.summary?.localized.images).toBe(1);
    await expect(jobs.submitFromUrl({ pageId, url: 'https://vsl.example.com/arquivo.pdf' })).rejects.toMatchObject({ code: 'import_url_not_html' });
    await expect(jobs.submitFromUrl({ pageId, url: 'https://interno.example.com/' })).rejects.toMatchObject({ code: 'import_url_invalid' });
    await expect(jobs.submitFromUrl({ pageId, url: 'https://sumiu.example.com/' })).rejects.toMatchObject({ code: 'import_url_unreachable', statusCode: 502 });
    await expect(jobs.submitFromUrl({ pageId, url: 42 })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('fails invalid sources without retry and cleans the uploaded source', async () => {
    const { job } = await submit(Buffer.from('PK not really a zip'), 'bad', 'zip');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('failed');
    const view = await jobs.get(pageId, job.id);
    expect(view.error).toMatchObject({ code: 'import_source_invalid' });
    expect(view.error?.message).toMatch(/corrompido/);
    expect(await files(root)).toEqual([]);
  });

  // Regressão (prod 2026-10-08): ZIP real com manifest.json de PWA falhava com "Reserved release path"
  // e a UI dizia "arquivo corrompido". Arquivos que a página não usa agora são ignorados com aviso.
  it('ignores reserved, hidden, unsupported, empty and executable files with warnings instead of failing', async () => {
    const index = Buffer.from('<!doctype html><html><head><link rel="manifest" href="manifest.json"><link rel="stylesheet" href="css/a.css"></head><body><h1>Oferta</h1><script src="js/app.js"></script></body></html>');
    const source = zip([
      { name: 'index.html', bytes: index },
      { name: 'manifest.json', bytes: Buffer.from('{"name":"PWA","start_url":"/"}') },
      { name: 'css/a.css', bytes: Buffer.from('h1{color:red}') },
      { name: 'js/app.js', bytes: Buffer.from('window.ok=1;\n//# sourceMappingURL=app.js.map') },
      { name: 'js/app.js.map', bytes: Buffer.from('{"version":3}') },
      { name: 'LEIAME.txt', bytes: Buffer.from('notas') },
      { name: 'sitemap.xml', bytes: Buffer.from('<urlset/>') },
      { name: 'site.webmanifest', bytes: Buffer.from('{}') },
      { name: 'README.md', bytes: Buffer.from('# x') },
      { name: '.htaccess', bytes: Buffer.from('RewriteEngine On') },
      { name: '.well-known/x.css', bytes: Buffer.from('a{}') },
      { name: '__MACOSX/._index.html', bytes: Buffer.from('meta') },
      { name: 'css/.DS_Store', bytes: Buffer.from('meta') },
      { name: 'css/vazio.css', bytes: Buffer.alloc(0) },
      { name: 'js/tool.js', bytes: Buffer.from('MZ\x90\x00binary') },
      { name: 'img/foto.png', bytes: Buffer.from('<html>not a png</html>') },
      { name: '__vsl/x.js', bytes: Buffer.from('1') },
      { name: 'vendor/sub/.sealed', bytes: Buffer.from('x') },
    ]);
    const { job } = await submit(source, 'zip-noise', 'zip');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const view = await jobs.get(pageId, job.id);
    const codes = new Map(view.result!.findings.map((finding) => [finding.file, finding]));
    // Import inteligente: arquivo que a página não usa só é ignorado (informação).
    expect(codes.get('manifest.json')).toMatchObject({ code: 'discarded_reserved_name', severity: 'info' });
    expect(codes.get('js/app.js.map')).toMatchObject({ code: 'discarded_unsupported_type', severity: 'info' });
    expect(codes.get('LEIAME.txt')?.code).toBe('discarded_unsupported_type');
    expect(codes.get('.htaccess')?.code).toBe('discarded_hidden_file');
    expect(codes.get('css/vazio.css')?.code).toBe('discarded_empty_file');
    expect(codes.get('js/tool.js')?.code).toBe('discarded_executable');
    expect(codes.get('img/foto.png')?.code).toBe('discarded_invalid_content');
    expect(codes.get('__vsl/x.js')?.code).toBe('discarded_reserved_name');
    expect(codes.get('__MACOSX/._index.html')).toMatchObject({ code: 'discarded_os_metadata', severity: 'info' });
    expect(view.result!.findings.find((finding) => finding.code === 'pwa_manifest_removed')?.severity).toBe('warning');
    for (const finding of view.result!.findings) expect(finding.message).not.toBe('Item que precisa de revisão.');
    const [revision] = await db.sql`SELECT manifest,storage_prefix FROM vsl_page_revisions WHERE id=${view.result!.revisionId}`;
    expect(Object.keys((revision!.manifest as { files: object }).files).sort()).toEqual(['css/a.css', 'index.html', 'js/app.js']);
    const entry = await storage.read(`${revision!.storage_prefix}/index.html`);
    expect(entry.toString()).not.toContain('rel="manifest"');
    expect(JSON.parse((await storage.read(`${revision!.storage_prefix}/manifest.json`)).toString())).toMatchObject({ entryPath: 'index.html' });
  });

  it('does not block on mixed inline pixels: the runtime strips original trackers when serving', async () => {
    const page = Buffer.from("<html><body><h1>Quiz</h1><script>var quiz={q:1}; fbq('init','999'); fbq('track','PageView');</script></body></html>");
    const { job } = await submit(page, 'fbq');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const view = await jobs.get(pageId, job.id);
    expect(view.result!.findings.find((finding) => finding.code === 'tracker_mixed')).toMatchObject({ severity: 'warning' });
    const [revision] = await db.sql`SELECT storage_prefix FROM vsl_page_revisions WHERE id=${view.result!.revisionId}`;
    expect((await storage.read(`${revision!.storage_prefix}/index.html`)).toString()).toContain("fbq('init','999')");
  });

  it('explains why a source is invalid in PT-BR', async () => {
    const cases: Array<[Buffer, 'html' | 'zip', RegExp]> = [
      [zip([{ name: 'a.css', bytes: Buffer.from('a{}') }, { name: 'notas.txt', bytes: Buffer.from('x') }]), 'zip', /Nenhum arquivo \.html/],
      [zip([{ name: '../x.html', bytes: html }]), 'zip', /caminho de arquivo inválido/],
      [Buffer.from([0x3c, 0x68, 0x31, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x68, 0x31, 0x3e]), 'html', /UTF-8/],
      [Buffer.from('apenas texto sem tags'), 'html', /não parece ser uma página HTML/],
      [zip([{ name: 'index.html', bytes: Buffer.from('<?php echo 1; ?><html></html>') }]), 'zip', /código de servidor/],
    ];
    for (const [index, [bytes, kind, message]] of cases.entries()) {
      const { job } = await submit(bytes, `bad-${index}`, kind);
      expect(await jobs.process((await jobs.claimNext())!)).toBe('failed');
      const view = await jobs.get(pageId, job.id);
      expect(view.error?.code).toBe('import_source_invalid');
      expect(view.error?.message).toMatch(message);
    }
  });

  it('maps legacy technical reasons to PT-BR and never leaks unknown English details', () => {
    expect(importErrorMessage('import_source_invalid', 'Reserved release path')).toMatch(/manifest\.json/);
    expect(importErrorMessage('import_source_invalid', 'Unsupported or empty file')).toMatch(/ignorado/);
    expect(importErrorMessage('import_source_invalid', 'Invalid ZIP directory')).toBe('Arquivo inválido ou corrompido.');
    expect(importErrorMessage('import_source_invalid', 'O ZIP contém um caminho de arquivo inválido.')).toBe('O ZIP contém um caminho de arquivo inválido.');
    expect(importErrorMessage('import_failed', 'attempts exhausted')).toBe('A importação falhou. Tente enviar o arquivo de novo.');
  });

  it('fences a stale worker: its writes are discarded and the prefix is cleaned', async () => {
    const { job } = await submit(html, 'fence');
    const stale = (await jobs.claimNext())!;
    // Lease expira e outro worker assume o job (novo lease_token).
    await db.sql`UPDATE vsl_page_import_jobs SET lease_until=now()-interval '1 second' WHERE id=${job.id}`;
    const fresh = (await jobs.claimNext())!;
    expect(fresh.lease_token).not.toBe(stale.lease_token);
    expect(await jobs.process(stale)).toBe('fenced');
    expect((await files(root)).filter((file) => file.startsWith('vsl/releases/'))).toEqual([]);
    expect(await jobs.process(fresh)).toBe('succeeded');
  });

  it('retries transient storage failures with backoff and gives up after max attempts', async () => {
    const { job } = await submit(html, 'flaky');
    const broken = new VslPageImportJobs(db.sql, Object.assign(Object.create(storage) as LocalVslStorage, {
      read: async () => { throw new Error('R2 timeout'); },
    }));
    expect(await broken.process((await broken.claimNext())!)).toBe('queued');
    const [row] = await db.sql`SELECT state, attempts, run_after > now() AS delayed, lease_token FROM vsl_page_import_jobs WHERE id=${job.id}`;
    expect(row).toMatchObject({ state: 'queued', attempts: 1, delayed: true, lease_token: null });
    await db.sql`UPDATE vsl_page_import_jobs SET attempts=3, run_after=now() WHERE id=${job.id}`;
    expect(await broken.process((await broken.claimNext())!)).toBe('failed');
    expect((await jobs.get(pageId, job.id)).error?.code).toBe('import_failed');
  });

  it('reuses an identical revision instead of writing a new one', async () => {
    await submit(html, 'one');
    await jobs.process((await jobs.claimNext())!);
    const { job } = await submit(html, 'two');
    expect(await jobs.process((await jobs.claimNext())!)).toBe('succeeded');
    const view = await jobs.get(pageId, job.id);
    expect(view.result?.reused).toBe(true);
    const [count] = await db.sql`SELECT count(*)::int AS n FROM vsl_page_revisions WHERE page_id=${pageId}`;
    expect(count?.n).toBe(1);
    expect((await jobs.list(pageId)).map((item) => item.id)).toContain(job.id);
  });
});
