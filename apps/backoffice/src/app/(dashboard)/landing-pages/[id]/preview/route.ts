// GET /landing-pages/[id]/preview
// Serve o HTML da landing como text/html puro — sem AppShell, sem Polaris,
// sem chrome de backoffice. Renderiza como se estivesse publicada.
//
// Uso: abrir em nova aba pra ver a landing full-screen. Alternativa ao
// iframe pequeno do painel de edição.

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { landingBundleOffers, landingPages } from '@blackshop/db';
import { editsRuntimeScriptFor } from '@blackshop/shared/landing-edits-runtime';

import { getDb } from '@/lib/landing-db';
import { getLandingPage } from '@/lib/landing-actions';
import type { EditorRecipe } from '@/lib/landing-inline-edit/editor-recipes';
import { prepareInlineEditorHtml } from '@/lib/landing-inline-edit/html';
import { inlineEditorHtml } from '@/lib/landing-inline-edit/inline-editor';

export const dynamic = 'force-dynamic';

// Frameworks JS de site origem que NUNCA funcionam fora do build origem.
// Ex: __next_f push payloads referenciam React chunks compilados por build ID
// específico — servir esses scripts fora do site origem crasha o browser
// com "Application error: client-side exception". Landings React/Next.js
// requerem estratégia diferente (injetar UX genérico próprio).
const FRAMEWORK_SCRIPT_PATTERNS: RegExp[] = [
  /self\.__next_f\.push/,
  /self\.__next_f\s*=/,
  /window\.__NEXT_DATA__/,
  /__NEXT_ROUTER_STATE__/,
  /_next\/static\/chunks/,
  /window\.__NUXT__/,
  /_nuxt\/entry\./,
  /ReactDOM\.hydrateRoot/,
  /ReactDOM\.hydrate/,
];

function stripFrameworkScripts(html: string): string {
  return html.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    (match) => {
      if (/type=["']application\/ld\+json["']/i.test(match)) return match;
      if (FRAMEWORK_SCRIPT_PATTERNS.some((re) => re.test(match))) return '';
      return match;
    },
  );
}

interface Ctx {
  params: { id: string };
}

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const landing = await getLandingPage(params.id);
  if (!landing) {
    return new NextResponse('Landing não encontrada.', { status: 404 });
  }

  const url = new URL(req.url);
  // ?edit=1     → overlay de regeneração por bloco (LivePreview antigo)
  // ?edit=inline → overlay de edição inline PageFly-style (novo /edit)
  // sem flag    → HTML limpo (preview público ou publicação)
  const editParam = url.searchParams.get('edit');

  // Bundle Engine V2: se landing tem flag ligada, injeta window.__LL_BUNDLE_OFFERS__
  // no <head> (mesmo comportamento do landinglab-storefront/[host]/[[...slug]]).
  const db = getDb();
  const [flagRow] = await db
    .select({
      useNewBundleEngine: landingPages.useNewBundleEngine,
      currency: landingPages.currency,
    })
    .from(landingPages)
    .where(and(eq(landingPages.id, params.id), eq(landingPages.storeId, 'l0i')))
    .limit(1);
  let bundleInjection = '';
  if (flagRow?.useNewBundleEngine) {
    const offers = await db
      .select({
        position: landingBundleOffers.position,
        title: landingBundleOffers.title,
        qty: landingBundleOffers.qty,
        priceCents: landingBundleOffers.priceCents,
        compareAtCents: landingBundleOffers.compareAtCents,
        saveText: landingBundleOffers.saveText,
        badge: landingBundleOffers.badge,
        variantId: landingBundleOffers.variantId,
        isPreselected: landingBundleOffers.isPreselected,
      })
      .from(landingBundleOffers)
      .where(eq(landingBundleOffers.landingPageId, params.id))
      .orderBy(landingBundleOffers.position);
    const shopifyStoreUrl = process.env['LANDINGLAB_SHOPIFY_STORE_URL'] ?? '';
    bundleInjection = `<script>window.__LL_BUNDLE_OFFERS__=${JSON.stringify({
      currency: flagRow.currency,
      shopifyStoreUrl,
      offers,
    })};</script>`;
  }

  // Story 26.1: no editor, seções/botões/preços/textos/imagens são marcados no servidor sobre o HTML cru
  // (mesmos IDs do PATCH); as receitas recolocam as marcas nos blocos que os scripts da landing redesenham.
  const rawHtml = landing.htmlBody.trim();
  const prepared = editParam === 'inline' ? prepareInlineEditorHtml(rawHtml) : null;
  const html = stripFrameworkScripts(prepared ? prepared.html : rawHtml);
  const isFullDoc = /^<!doctype/i.test(html) || /^<html/i.test(html);

  let body = isFullDoc ? html : buildEnvelope(landing.title, html, landing.customCss);

  // Injeta o payload de bundles logo após <head> pra rodar antes do runtime script
  if (bundleInjection && /<head\b[^>]*>/i.test(body)) {
    body = body.replace(/<head\b[^>]*>/i, (m) => `${m}\n${bundleInjection}`);
  }

  // Story 26.1: preview limpo roda como a página publicada — links de botão e textos travados do editor.
  const editsRuntime = editParam ? '' : editsRuntimeScriptFor(rawHtml);
  if (editsRuntime && /<head\b[^>]*>/i.test(body)) {
    body = body.replace(/<head\b[^>]*>/i, (m) => `${m}\n${editsRuntime}`);
  }

  if (editParam === '1') {
    body = injectEditOverlay(body, landing.id);
  } else if (editParam === 'inline') {
    body = injectInlineEditor(body, prepared?.recipes ?? []);
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

// Injeta CSS + JS de overlay dentro do </body>. Só ativa em ?edit=1.
// Overlay funciona assim:
//   1. Hover em [data-block-id] mostra um botão "✏ Regenerar" no canto.
//   2. Click envia postMessage pro parent frame com { type, blockId, kind, textContent }.
//   3. Parent (LivePreview) abre modal com input "hint" e chama server action.
//   4. Ao concluir, parent recarrega o iframe (nonce++).
function injectEditOverlay(html: string, landingPageId: string): string {
  const overlay = `
<style id="ll-edit-overlay-style">
  [data-block-id]{position:relative;transition:outline 120ms ease}
  [data-block-id]:hover{outline:2px dashed rgba(44,110,203,.6);outline-offset:-2px}
  .ll-edit-btn{position:absolute;top:8px;right:8px;background:#2c6ecb;color:#fff;border:0;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;z-index:999;opacity:0;transition:opacity 120ms;box-shadow:0 2px 6px rgba(0,0,0,.15);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  [data-block-id]:hover .ll-edit-btn{opacity:1}
  .ll-edit-btn:hover{background:#1a56b0}
</style>
<script id="ll-edit-overlay-script">
(function(){
  var LANDING_ID=${JSON.stringify(landingPageId)};
  var blocks=document.querySelectorAll('[data-block-id]');
  blocks.forEach(function(el){
    var btn=document.createElement('button');
    btn.className='ll-edit-btn';
    btn.type='button';
    btn.textContent='✏ Regenerar';
    btn.setAttribute('aria-label','Regenerar bloco');
    btn.addEventListener('click',function(e){
      e.stopPropagation();e.preventDefault();
      var blockId=el.getAttribute('data-block-id');
      var kind=el.getAttribute('data-block-kind');
      var text=(el.innerText||'').slice(0,500);
      window.parent.postMessage({
        type:'landinglab:regenerate-block-requested',
        landingId:LANDING_ID,
        blockId:blockId,
        kind:kind,
        preview:text
      },'*');
    });
    el.appendChild(btn);
  });
})();
</script>
`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${overlay}</body>`);
  }
  return html + overlay;
}

function injectInlineEditor(html: string, recipes: EditorRecipe[]): string {
  const overlay = inlineEditorHtml(recipes);
  if (html.includes('</body>')) {
    return html.replace('</body>', `${overlay}</body>`);
  }
  return html + overlay;
}

function buildEnvelope(title: string, bodyHtml: string, customCss: string | null): string {
  const cssBlock = customCss ? `<style>${customCss}</style>` : '';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${cssBlock}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
