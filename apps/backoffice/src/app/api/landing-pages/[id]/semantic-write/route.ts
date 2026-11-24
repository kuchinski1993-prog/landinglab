// POST /api/landing-pages/[id]/semantic-write
//
// Sprint Final V1 — Step 3.
//
// Feature flag: LANDINGLAB_SEMANTIC_WRITES (default OFF).
//
// Aplica uma mutação semântica (text ou image) identificada por instanceId.
//
// SECURITY INVARIANTS:
//   - Identity: requireAdminRequest (session + allowlist)
//   - Selector authority: CLIENT NUNCA envia selector. O server re-resolve o
//     instanceId → structuralPath → DOM element via modelo semântico fresh.
//   - Concurrency: htmlSha no request é comparado ao SHA do html_body atual.
//     Divergência → 409 Conflict.
//   - Snapshot: html_body anterior é salvo em landing_html_snapshots ANTES
//     de qualquer escrita.
//   - Rollback: se validação pós-mutação falhar, snapshot é restaurado.
//   - Locality: mutação não pode expandir além da region do instanceId
//     (delta de linhas controlado).
//
// REQUEST BODY:
//   {
//     instanceId: string,          // sha256(structuralPath).slice(0,12)
//     mutationKind: 'text'|'image',
//     value: string,               // new text (plain) or new image URL
//     htmlSha: string,             // SHA-256 hex dos primeiros 32 bytes do html_body
//                                  // (concurrency token)
//   }
//
// RESPONSE:
//   200: { ok: true, applied: true, snapshotId: string, latencyMs: number }
//   400: { ok: false, error: 'validation', message }
//   401/403: auth errors
//   404: landing not found
//   409: { ok: false, error: 'sha_mismatch', message }
//   422: { ok: false, error: 'instance_not_found', message }
//   500: { ok: false, error: 'write_failed', message }
//
// NOTA: Este endpoint escreve APENAS nos slot kinds autorizados:
//   text: headline, subheadline, cta_label, article_paragraph, faq_question,
//         faq_answer, product_title
//   image: product_main, gallery_image, advertorial_image, section_image

import crypto from 'node:crypto';

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import { landingPages, landingHtmlSnapshots } from '@blackshop/db';
import {
  computePageSemanticModel,
  createAdapterRegistry,
  createSharedDetectorRegistry,
  kachingAdapter,
  accordionDetector,
  articleDetector,
  footerDetector,
  shopifyCtaDetector,
  type PageFamily,
  type ImageOcrMetadataEntry,
} from '@blackshop/landinglab-adapters';

import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STORE_ID = 'l0i';

// ─── Feature flag ────────────────────────────────────────────────────────────

function semanticWritesEnabled(): boolean {
  return process.env['LANDINGLAB_SEMANTIC_WRITES'] === 'true';
}

// ─── Registry cache (module-level, same as semantic-model endpoint) ──────────

let cachedAdapterRegistry: ReturnType<typeof createAdapterRegistry> | null = null;
let cachedSharedRegistry: ReturnType<typeof createSharedDetectorRegistry> | null = null;

function getAdapterRegistry() {
  if (cachedAdapterRegistry) return cachedAdapterRegistry;
  const r = createAdapterRegistry();
  r.register(kachingAdapter);
  r.freeze();
  cachedAdapterRegistry = r;
  return r;
}

function getSharedRegistry() {
  if (cachedSharedRegistry) return cachedSharedRegistry;
  const r = createSharedDetectorRegistry();
  r.register(shopifyCtaDetector);
  r.register(articleDetector);
  r.register(accordionDetector);
  r.register(footerDetector);
  r.freeze();
  cachedSharedRegistry = r;
  return r;
}

function mapLandingKindToPageFamily(kind: string | null | undefined): PageFamily | null {
  if (kind === 'sales_page') return 'sales_page';
  if (kind === 'advertorial') return 'advertorial';
  if (kind === 'pdp_derived') return 'pdp_derived';
  return null;
}

// ─── Allowed slot kinds ──────────────────────────────────────────────────────

const ALLOWED_TEXT_KINDS = new Set([
  'headline', 'subheadline', 'product_title', 'cta_label',
  'article_paragraph', 'faq_question', 'faq_answer',
]);

const ALLOWED_IMAGE_KINDS = new Set([
  'product_main', 'gallery_image', 'advertorial_image', 'section_image',
]);

// ─── HTML SHA (concurrency token) ───────────────────────────────────────────

function computeHtmlSha(htmlBody: string): string {
  return crypto.createHash('sha256').update(htmlBody, 'utf8').digest('hex').slice(0, 16);
}

// ─── DOM mutation helpers ────────────────────────────────────────────────────

/**
 * Navega o DOM usando structuralPath ('body>tag:index>tag:index>...') e retorna
 * o elemento Cheerio, ou null se não encontrado.
 * structuralPath format: 'body>div:2>section:0>h1:0'
 */
function findElementByStructuralPath($: cheerio.CheerioAPI, structuralPath: string): ReturnType<cheerio.CheerioAPI> | null {
  const segments = structuralPath.split('>');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = $('html');

  for (const seg of segments) {
    const colonIdx = seg.lastIndexOf(':');
    if (colonIdx < 0) {
      const tag = seg.trim();
      const next = current.find(tag).first();
      if (!next.length) return null;
      current = next;
      continue;
    }
    const tag = seg.slice(0, colonIdx).trim();
    const idx = parseInt(seg.slice(colonIdx + 1), 10);
    if (isNaN(idx)) return null;

    const children = current.children(tag);
    if (idx >= children.length) return null;
    current = children.eq(idx);
  }

  return current.length ? current : null;
}

/**
 * Aplica text mutation: substitui o texto visível do primeiro text node direto.
 * Usa cheerio .contents() para localizar text nodes, evita tipos internos.
 */
function applyTextMutation(html: string, structuralPath: string, newText: string): string | null {
  const $ = cheerio.load(html);
  const el = findElementByStructuralPath($, structuralPath);
  if (!el) return null;

  // Localiza o primeiro text node filho direto via contents()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let foundTextNode = false;
  el.contents().each((_: number, node: any) => {
    if (!foundTextNode && node.type === 'text') {
      node.data = newText;
      foundTextNode = true;
    }
  });

  if (!foundTextNode) {
    // Nenhum text node direto — usa prepend como fallback
    el.prepend(newText);
  }

  return $.html();
}

/**
 * Aplica image mutation: substitui src do <img> dentro do structuralPath.
 * Preserva todos os outros atributos (srcset, sizes, alt, etc).
 */
function applyImageMutation(html: string, structuralPath: string, newUrl: string): string | null {
  const $ = cheerio.load(html);
  const el = findElementByStructuralPath($, structuralPath);
  if (!el) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = el[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let $img: any;
  if (node?.tagName?.toLowerCase() === 'img') {
    $img = el;
  } else {
    $img = el.find('img').first();
  }

  if (!$img || !$img.length) return null;

  const oldSrc: string = $img.attr('src') ?? '';
  $img.attr('src', newUrl);

  // Limpa srcset se CDN diferente (evita servir imagem antiga em srcset)
  const oldHost = tryExtractHost(oldSrc);
  const newHost = tryExtractHost(newUrl);
  if ($img.attr('srcset') && oldHost !== newHost) {
    $img.removeAttr('srcset');
    $img.removeAttr('sizes');
  }

  return $.html();
}

function tryExtractHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

// ─── Structural locality validation ─────────────────────────────────────────
//
// Verifica que a mutação afetou APENAS o nó alvo.
// Estratégia: comparar outerHTML do target antes/depois + SHA do DOM sem o target.
//
// Para text: o outerHTML deve diferir (target mudou), mas o "DOM externo" (tudo
// fora do target) deve ter o mesmo SHA.
// Para image: o src do img alvo deve ser o novo; nenhum outro img com o src
// antigo deve ter sido alterado.

interface LocalityProof {
  ok: boolean;
  reason?: string;
}

function validateTextLocality(
  oldHtml: string,
  newHtml: string,
  structuralPath: string,
  newText: string,
): LocalityProof {
  const $old = cheerio.load(oldHtml);
  const $new = cheerio.load(newHtml);

  const elOld = findElementByStructuralPath($old, structuralPath);
  const elNew = findElementByStructuralPath($new, structuralPath);

  if (!elOld || !elNew) {
    return { ok: false, reason: 'target not found in pre/post DOM' };
  }

  // 1. Target deve ter mudado
  if (elOld.html() === elNew.html()) {
    return { ok: false, reason: 'target outerHTML unchanged after text mutation' };
  }

  // 2. Novo target deve conter o novo texto
  if (!elNew.text().includes(newText.slice(0, Math.min(newText.length, 40)))) {
    return { ok: false, reason: 'target does not contain expected new text' };
  }

  // 3. Atributos do target não devem ter mudado
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attrsOld = (elOld[0] as any).attribs ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attrsNew = (elNew[0] as any).attribs ?? {};
  if (JSON.stringify(attrsOld) !== JSON.stringify(attrsNew)) {
    return { ok: false, reason: 'target element attributes changed unexpectedly' };
  }

  // 4. DOM externo ao target: SHA deve ser idêntico.
  // Implementação: remover target de ambos e comparar SHA do resultado.
  const $oldClone = cheerio.load(oldHtml);
  const $newClone = cheerio.load(newHtml);
  findElementByStructuralPath($oldClone, structuralPath)?.remove();
  findElementByStructuralPath($newClone, structuralPath)?.remove();
  const shaOldOuter = crypto.createHash('sha256').update($oldClone.html() ?? '', 'utf8').digest('hex');
  const shaNewOuter = crypto.createHash('sha256').update($newClone.html() ?? '', 'utf8').digest('hex');
  if (shaOldOuter !== shaNewOuter) {
    return { ok: false, reason: 'DOM nodes outside target changed after text mutation' };
  }

  return { ok: true };
}

function validateImageLocality(
  oldHtml: string,
  newHtml: string,
  structuralPath: string,
  oldSrc: string,
  newSrc: string,
): LocalityProof {
  const $old = cheerio.load(oldHtml);
  const $new = cheerio.load(newHtml);

  const elOld = findElementByStructuralPath($old, structuralPath);
  const elNew = findElementByStructuralPath($new, structuralPath);
  if (!elOld || !elNew) {
    return { ok: false, reason: 'target not found in pre/post DOM' };
  }

  // 1. Img alvo deve ter novo src
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeOld: any = elOld[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeNew: any = elNew[0];
  const $imgOld = nodeOld?.tagName?.toLowerCase() === 'img' ? elOld : elOld.find('img').first();
  const $imgNew = nodeNew?.tagName?.toLowerCase() === 'img' ? elNew : elNew.find('img').first();

  if (!$imgOld.length || !$imgNew.length) {
    return { ok: false, reason: 'img not found in target in pre/post DOM' };
  }
  if ($imgNew.attr('src') !== newSrc) {
    return { ok: false, reason: `img src after mutation is "${$imgNew.attr('src')}", expected "${newSrc}"` };
  }

  // 2. Nenhum outro img com oldSrc deve ter sido alterado para newSrc
  // (proteção contra mutações em múltiplos elementos com mesma URL)
  const allImgsNewWithNewSrc = $new('img').filter((_: number, el: any) => $new(el).attr('src') === newSrc).length;
  const allImgsOldWithOldSrc = $old('img').filter((_: number, el: any) => $old(el).attr('src') === oldSrc).length;
  // Deve haver exatamente 1 img com newSrc em newHtml (o target)
  if (allImgsNewWithNewSrc !== 1) {
    return {
      ok: false,
      reason: `${allImgsNewWithNewSrc} images with newSrc after mutation — expected exactly 1`,
    };
  }
  // Imgs com oldSrc em newHtml devem ser (allImgsOldWithOldSrc - 1) — apenas o target foi substituído
  const allImgsNewWithOldSrc = $new('img').filter((_: number, el: any) => $new(el).attr('src') === oldSrc).length;
  if (allImgsNewWithOldSrc !== allImgsOldWithOldSrc - 1) {
    return {
      ok: false,
      reason: `old src count mismatch: expected ${allImgsOldWithOldSrc - 1} remaining, got ${allImgsNewWithOldSrc}`,
    };
  }

  // 3. DOM externo ao target deve ser idêntico
  const $oldClone = cheerio.load(oldHtml);
  const $newClone = cheerio.load(newHtml);
  findElementByStructuralPath($oldClone, structuralPath)?.remove();
  findElementByStructuralPath($newClone, structuralPath)?.remove();
  const shaOldOuter = crypto.createHash('sha256').update($oldClone.html() ?? '', 'utf8').digest('hex');
  const shaNewOuter = crypto.createHash('sha256').update($newClone.html() ?? '', 'utf8').digest('hex');
  if (shaOldOuter !== shaNewOuter) {
    return { ok: false, reason: 'DOM nodes outside target changed after image mutation' };
  }

  return { ok: true };
}

// ─── URL validation ──────────────────────────────────────────────────────────

function isValidImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host.length > 0;
  } catch { return false; }
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

async function persistSnapshot(
  db: ReturnType<typeof getDb>,
  landingPageId: string,
  htmlBody: string,
  trigger: string,
): Promise<string> {
  const sha256 = crypto.createHash('sha256').update(htmlBody, 'utf8').digest('hex');
  const bytes = Buffer.byteLength(htmlBody, 'utf8');
  const [row] = await db
    .insert(landingHtmlSnapshots)
    .values({
      landingPageId,
      htmlBody,
      reason: trigger,
      actor: 'semantic-write-endpoint',
      bytes,
      sha256,
    })
    .returning({ id: landingHtmlSnapshots.id });
  return row?.id ?? 'unknown';
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  // 1. Auth
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  // 2. Feature flag (fail-closed)
  if (!semanticWritesEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'feature_disabled', message: 'LANDINGLAB_SEMANTIC_WRITES is not enabled' },
      { status: 403 },
    );
  }

  // 3. Parse + validate request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'validation', message: 'JSON inválido' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const instanceId = typeof b['instanceId'] === 'string' ? b['instanceId'].trim() : '';
  const mutationKind = b['mutationKind'];
  const value = typeof b['value'] === 'string' ? b['value'] : null;
  const htmlSha = typeof b['htmlSha'] === 'string' ? b['htmlSha'].trim() : '';

  if (!instanceId) {
    return NextResponse.json({ ok: false, error: 'validation', message: 'instanceId obrigatório' }, { status: 400 });
  }
  if (mutationKind !== 'text' && mutationKind !== 'image') {
    return NextResponse.json({ ok: false, error: 'validation', message: 'mutationKind deve ser "text" ou "image"' }, { status: 400 });
  }
  if (value === null || value === '') {
    return NextResponse.json({ ok: false, error: 'validation', message: 'value obrigatório' }, { status: 400 });
  }
  if (!htmlSha) {
    return NextResponse.json({ ok: false, error: 'validation', message: 'htmlSha obrigatório (concurrency token)' }, { status: 400 });
  }

  // 4. Validação de value por kind
  if (mutationKind === 'image') {
    if (!isValidImageUrl(value)) {
      return NextResponse.json(
        { ok: false, error: 'validation', message: 'value deve ser URL HTTPS válida para mutationKind=image' },
        { status: 400 },
      );
    }
  } else {
    // text: trim + tamanho máximo
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return NextResponse.json({ ok: false, error: 'validation', message: 'value não pode ser string vazia para mutationKind=text' }, { status: 400 });
    }
    if (trimmed.length > 2000) {
      return NextResponse.json({ ok: false, error: 'validation', message: 'value text excede 2000 caracteres' }, { status: 400 });
    }
  }

  const cleanValue = mutationKind === 'text' ? value.trim() : value;

  // 5. Carregar landing do DB
  const db = getDb();
  const landingId = params.id;

  const [row] = await db
    .select({
      id: landingPages.id,
      htmlBody: landingPages.htmlBody,
      landingKind: landingPages.landingKind,
      imageOcrMetadata: landingPages.imageOcrMetadata,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
    .limit(1);

  if (!row) {
    return NextResponse.json({ ok: false, error: 'not_found', message: 'Landing não encontrada' }, { status: 404 });
  }

  if (!row.htmlBody) {
    return NextResponse.json({ ok: false, error: 'not_found', message: 'Landing sem html_body' }, { status: 422 });
  }

  // 6. Concurrency guard — SHA do html_body atual vs token enviado pelo client
  const currentSha = computeHtmlSha(row.htmlBody);
  if (currentSha !== htmlSha) {
    return NextResponse.json(
      {
        ok: false,
        error: 'sha_mismatch',
        message: 'html_body foi modificado por outra sessão. Recarregue o editor.',
        currentSha,
      },
      { status: 409 },
    );
  }

  // 7. Re-resolve modelo semântico server-side (sem confiar no client)
  const ocrMetadata = Array.isArray(row.imageOcrMetadata)
    ? (row.imageOcrMetadata as ImageOcrMetadataEntry[])
    : undefined;

  const model = computePageSemanticModel({
    html: row.htmlBody,
    landingPageId: row.id,
    userHint: mapLandingKindToPageFamily(row.landingKind),
    adapterRegistry: getAdapterRegistry(),
    sharedRegistry: getSharedRegistry(),
    ...(ocrMetadata ? { ocrMetadata } : {}),
    computedAt: new Date().toISOString(),
  });

  // 8. Localizar instanceId no modelo e validar kind autorizado
  let structuralPath: string | null = null;

  if (mutationKind === 'text') {
    const block = model.textBlocks.find((b) => b.instanceId === instanceId);
    if (!block) {
      return NextResponse.json(
        { ok: false, error: 'instance_not_found', message: `instanceId "${instanceId}" não encontrado nos textBlocks do modelo atual` },
        { status: 422 },
      );
    }
    if (!ALLOWED_TEXT_KINDS.has(block.blockKind)) {
      return NextResponse.json(
        { ok: false, error: 'mutation_not_allowed', message: `blockKind "${block.blockKind}" não é editável nesta versão` },
        { status: 422 },
      );
    }
    structuralPath = block.structuralPath;
  } else {
    const slot = model.imageSlots.find((s) => s.instanceId === instanceId);
    if (!slot) {
      return NextResponse.json(
        { ok: false, error: 'instance_not_found', message: `instanceId "${instanceId}" não encontrado nos imageSlots do modelo atual` },
        { status: 422 },
      );
    }
    if (!ALLOWED_IMAGE_KINDS.has(slot.slotKind)) {
      return NextResponse.json(
        { ok: false, error: 'mutation_not_allowed', message: `slotKind "${slot.slotKind}" não é editável nesta versão` },
        { status: 422 },
      );
    }
    structuralPath = slot.structuralPath;
  }

  if (!structuralPath) {
    return NextResponse.json(
      { ok: false, error: 'instance_not_found', message: 'structuralPath vazio — inconsistência no modelo' },
      { status: 422 },
    );
  }

  // 9. Capturar oldSrc para image locality validation
  let oldSrc = '';
  if (mutationKind === 'image') {
    const $pre = cheerio.load(row.htmlBody);
    const elPre = findElementByStructuralPath($pre, structuralPath);
    if (elPre) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodePre: any = elPre[0];
      const $imgPre = nodePre?.tagName?.toLowerCase() === 'img' ? elPre : elPre.find('img').first();
      oldSrc = $imgPre.attr('src') ?? '';
    }
  }

  // 10. Snapshot ANTES de escrever
  const snapshotId = await persistSnapshot(db, landingId, row.htmlBody, `semantic-write:${mutationKind}:${instanceId}`);

  // 11. Aplicar mutação no DOM
  let newHtml: string | null;
  if (mutationKind === 'text') {
    newHtml = applyTextMutation(row.htmlBody, structuralPath, cleanValue);
  } else {
    newHtml = applyImageMutation(row.htmlBody, structuralPath, cleanValue);
  }

  if (!newHtml) {
    return NextResponse.json(
      {
        ok: false,
        error: 'write_failed',
        message: `Elemento com structuralPath "${structuralPath}" não encontrado no DOM.`,
        snapshotId,
      },
      { status: 500 },
    );
  }

  // 12. Byte-delta guard (defesa em profundidade — primeiro check rápido)
  const delta = Math.abs(newHtml.length - row.htmlBody.length);
  if (delta > 50_000) {
    return NextResponse.json(
      {
        ok: false,
        error: 'write_failed',
        message: `Delta de ${delta} bytes excede 50KB. Abortado antes de persistir.`,
        snapshotId,
      },
      { status: 500 },
    );
  }

  // 13. Structural locality validation (garante que apenas o target mudou)
  let localityProof: LocalityProof;
  if (mutationKind === 'text') {
    localityProof = validateTextLocality(row.htmlBody, newHtml, structuralPath, cleanValue);
  } else {
    localityProof = validateImageLocality(row.htmlBody, newHtml, structuralPath, oldSrc, cleanValue);
  }

  if (!localityProof.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: 'locality_violation',
        message: `Locality check falhou: ${localityProof.reason}`,
        snapshotId,
      },
      { status: 500 },
    );
  }

  // 14. Persistir
  try {
    await db
      .update(landingPages)
      .set({
        htmlBody: newHtml,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));
  } catch (err) {
    // DB write falhou — snapshot já existe, nada foi alterado — sem rollback necessário
    return NextResponse.json(
      {
        ok: false,
        error: 'write_failed',
        message: `DB update falhou: ${err instanceof Error ? err.message : 'unknown'}`,
        snapshotId,
      },
      { status: 500 },
    );
  }

  // 15. Post-persist validation: re-ler o DB e confirmar SHA
  // Se falhar, executa rollback automático (restaura html_body para originalHtml).
  let finalSha: string;
  try {
    const [persisted] = await db
      .select({ htmlBody: landingPages.htmlBody })
      .from(landingPages)
      .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
      .limit(1);

    if (!persisted?.htmlBody) {
      throw new Error('re-read retornou row vazia');
    }

    finalSha = computeHtmlSha(persisted.htmlBody);
    const expectedSha = computeHtmlSha(newHtml);

    if (finalSha !== expectedSha) {
      throw new Error(`SHA pós-persist divergiu: got ${finalSha}, expected ${expectedSha}`);
    }
  } catch (postErr) {
    // Rollback automático: restaurar html_body para o estado original
    try {
      await db
        .update(landingPages)
        .set({ htmlBody: row.htmlBody, updatedAt: new Date() })
        .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)));
    } catch {
      // rollback falhou — situação irrecuperável, snapshot garante auditoria
    }
    return NextResponse.json(
      {
        ok: false,
        error: 'write_failed',
        message: `Post-persist validation falhou, rollback executado: ${postErr instanceof Error ? postErr.message : 'unknown'}`,
        snapshotId,
        rolledBack: true,
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      applied: true,
      snapshotId,
      newHtmlSha: finalSha,
      mutationKind,
      instanceId,
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
