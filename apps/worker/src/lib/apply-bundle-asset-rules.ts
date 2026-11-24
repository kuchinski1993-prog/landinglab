// Regras do apply-bundle sobre os assets que o cloner re-hospedou no storage
// (`cloned-landings/landings/<id>/<hash16>.js`). O cloner nomeia TODO asset por hash hex de 16
// chars — nome sozinho não diz se o script é lixo do Shopify ou o JS da própria landing.

// Qualquer projeto Supabase (o storage desta instalação vem de SUPABASE_URL).
const SUPABASE_STORAGE = /\.supabase\.co\/storage/i;
const HASH16_JS = /\/[0-9a-f]{16}\.js(?:\?|$)/i;
const REHOSTED_LANDING_ASSET = /\/cloned-landings\/landings\//i;

/**
 * Entry ESM do shop-cart-sync (QA 2026-09-29): arquivo hash16 no storage que só faz `import` de
 * chunks `*.esm.js` nunca uploadados. `import` estático exige `type="module"` — script clássico com
 * hash16 é JS da landing (galeria, carrossel de vídeo, tabs) e fica.
 */
export function isShopHashModuleLoader(src: string, type: string | undefined): boolean {
  return (type ?? '').trim().toLowerCase() === 'module' && SUPABASE_STORAGE.test(src) && HASH16_JS.test(src);
}

/**
 * Landing com CSS/JS próprios re-hospedados não é tema Shopify sem assets — é página autocontida.
 * A recuperação de tema (§3.6) injetaria CSS/JS de OUTRA landing da loja e mudaria o layout.
 */
export function hasRehostedLandingAssets(urls: readonly string[]): boolean {
  return urls.some((u) => REHOSTED_LANDING_ASSET.test(u));
}
