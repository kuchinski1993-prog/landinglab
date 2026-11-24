// PATCH /api/landing-pages/[id]/edit-inline
//
// Recebe batch de edits do editor visual (Camada 1):
//   { textEdits: [{ id, newText }], imageEdits: [{ id, newUrl }],
//     sectionEdits: [{ id, action: 'hide'|'show'|'remove' }],          (Story 26.1)
//     buttonEdits: [{ id, text?, href? }], priceEdits: [{ id, text }] } (Story 26.1)
//
// Story 26.1: seção/botão/preço usam os IDs `s_/b_/p_` marcados no preview pela mesma função
// (`collectInlineEditTargets`), calculados sobre o HTML cru ANTES de qualquer mudança. Antes de gravar,
// o HTML anterior vai para `landing_html_snapshots` (reason 'inline-edit') — base do "Restaurar versão".
//
// Aplica edits no landing_pages.html_body via jsdom, com REGRAS estritas:
//   - Texto: substitui só o primeiro text node do element identificado por ID
//     estável (mesma hash function do overlay client-side).
//   - Imagem: substitui só o atributo src, preserva tudo mais (width, srcset,
//     class, sizes, loading, alt, etc).
//   - Diff-guard: rejeita save se qualquer node estrutural mudou (só textContent
//     e src são permitidos).
//   - Idempotência: aplica só edits cujo ID casa; edits órfãos são ignorados
//     (retorna em `skipped` pra UI mostrar).
//
// Resposta:
//   { ok: true, applied: N, skipped: M, warnings: [...] }
//   { ok: false, message: string }

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { landingPages } from '@blackshop/db/schema-landinglab-core';

import { getLandingPage } from '@/lib/landing-actions';
import { getDb } from '@/lib/landing-db';
import { requireAdminRequest } from '@/lib/admin/auth-guard';
import { parseEditableHtml, type EditableHtml } from '@/lib/landing-inline-edit/html';
import { finishInlineSnapshot, INLINE_EDIT_REASON, insertInlineSnapshot } from '@/lib/landing-inline-edit/snapshots';
import { writeEditsManifest } from '@/lib/landing-inline-edit/manifest';
import { applyTargetEdits, collectInlineEditTargets } from '@/lib/landing-inline-edit/targets';
import { collectTextImageTargets } from '@/lib/landing-inline-edit/text-targets';
import { hasTargetEdits, parseTargetEdits } from '@/lib/landing-inline-edit/validate';

export const runtime = 'nodejs';
export const maxDuration = 30;

const STORE_ID = 'l0i';

interface TextEditItem {
  id: string;
  newText: string;
}
interface ImageEditItem {
  id: string;
  newUrl: string;
}
interface PatchBody {
  textEdits: TextEditItem[];
  imageEdits: ImageEditItem[];
}

function sanitizeText(input: string): string {
  // Remove control chars (except \n \r \t) — evita injeção de bytes bizarros.
  let out = '';
  for (let i = 0; i < input.length && out.length < 5000; i++) {
    const c = input.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) { out += input[i]; continue; }
    if (c < 32 || c === 127) continue;
    out += input[i];
  }
  return out;
}

function isValidUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

interface Ctx {
  params: { id: string };
}

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
  const authErr = await requireAdminRequest(req);
  if (authErr) return authErr;

  const landing = await getLandingPage(params.id);
  if (!landing) {
    return NextResponse.json({ ok: false, message: 'Landing não encontrada' }, { status: 404 });
  }

  let payload: PatchBody;
  try {
    payload = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ ok: false, message: 'JSON inválido' }, { status: 400 });
  }

  const textEdits = Array.isArray(payload.textEdits) ? payload.textEdits : [];
  const imageEdits = Array.isArray(payload.imageEdits) ? payload.imageEdits : [];
  const parsedTargets = parseTargetEdits(payload as unknown as Record<string, unknown>);
  if (!parsedTargets.ok) {
    return NextResponse.json({ ok: false, message: parsedTargets.message }, { status: 400 });
  }
  const targetEdits = parsedTargets.edits;

  if (textEdits.length === 0 && imageEdits.length === 0 && !hasTargetEdits(targetEdits)) {
    return NextResponse.json({ ok: false, message: 'Nenhum edit fornecido' }, { status: 400 });
  }

  // Índice pra lookup rápido
  const textEditIndex = new Map<string, string>();
  for (const t of textEdits) {
    if (typeof t.id === 'string' && typeof t.newText === 'string') {
      textEditIndex.set(t.id, sanitizeText(t.newText));
    }
  }
  const imageEditIndex = new Map<string, string>();
  for (const i of imageEdits) {
    if (typeof i.id === 'string' && typeof i.newUrl === 'string' && isValidUrl(i.newUrl)) {
      imageEditIndex.set(i.id, i.newUrl);
    }
  }

  // Parse HTML com jsdom (fragmento continua fragmento ao gravar)
  let page: EditableHtml;
  try {
    page = parseEditableHtml(landing.htmlBody.trim());
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `Parse falhou: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 500 },
    );
  }

  const doc = page.doc;
  let appliedText = 0;
  let appliedImage = 0;
  const warnings: string[] = [];
  // Alvos calculados ANTES de qualquer mudança — os IDs do preview foram calculados sobre o HTML cru.
  const targets = hasTargetEdits(targetEdits) ? collectInlineEditTargets(doc) : [];

  // Textos/imagens: IDs `e_` carimbados no preview pela mesma função, sobre o mesmo HTML cru.
  const textImageTargets = textEditIndex.size > 0 || imageEditIndex.size > 0 ? collectTextImageTargets(doc) : [];
  for (const { id, kind, el } of textImageTargets) {
    if (kind === 'text') {
      const newText = textEditIndex.get(id);
      if (newText === undefined) continue;
      textEditIndex.delete(id);
      const node = el.childNodes[0]!;
      if (newText === (node.nodeValue ?? '').trim()) continue; // no-op
      // SÓ substitui o text node — nada mais.
      node.nodeValue = newText;
      appliedText++;
    } else {
      const newUrl = imageEditIndex.get(id);
      if (newUrl === undefined) continue;
      imageEditIndex.delete(id);
      const src = el.getAttribute('src') ?? '';
      // SÓ troca src. srcset de outro host sai (evita servir a versão antiga).
      el.setAttribute('src', newUrl);
      if (el.hasAttribute('srcset') && extractHost(src) !== extractHost(newUrl)) {
        el.removeAttribute('srcset');
        el.removeAttribute('sizes');
      }
      appliedImage++;
    }
  }
  // IDs que sobraram = edits órfãos
  for (const orphanId of textEditIndex.keys()) {
    warnings.push(`text edit não aplicado (elemento não encontrado): ${orphanId}`);
  }
  for (const orphanId of imageEditIndex.keys()) {
    warnings.push(`image edit não aplicado (elemento não encontrado): ${orphanId}`);
  }

  // Story 26.1: botões, preços e, por último, seções (excluir uma seção não invalida as outras edições).
  const targetResult = hasTargetEdits(targetEdits) ? applyTargetEdits(targets, targetEdits) : { applied: 0, warnings: [] };
  warnings.push(...targetResult.warnings);
  const appliedTargets = targetResult.applied;

  const applied = appliedText + appliedImage + appliedTargets;
  const skipped = warnings.length;

  if (applied === 0) {
    return NextResponse.json(
      { ok: false, message: 'Nenhum edit aplicado — IDs não casaram com o HTML atual', warnings },
      { status: 409 },
    );
  }

  // Receitas para o runtime reaplicar link/texto travado quando um script da landing redesenhar o bloco.
  writeEditsManifest(page.doc);

  // Serializa de volta
  const newHtml = page.serialize();

  // Persiste no DB (snapshot do HTML anterior primeiro — se falhar, não grava)
  try {
    const db = getDb();
    const snapshotId = await insertInlineSnapshot(db, params.id, landing.htmlBody, INLINE_EDIT_REASON, warnings);
    await db
      .update(landingPages)
      .set({
        htmlBody: newHtml,
        updatedAt: new Date(),
      })
      .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, STORE_ID)));
    if (snapshotId) await finishInlineSnapshot(db, snapshotId, newHtml);
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `DB update falhou: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    applied,
    appliedText,
    appliedImage,
    appliedTargets,
    skipped,
    warnings,
  });
}

function extractHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
