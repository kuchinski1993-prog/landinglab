// Story 20.10a (retrabalho) — HTML da landing para a MINIATURA do cartão da lista
// (`/api/landing-preview/<id>?thumb=1`).
//
// A miniatura é só uma imagem da página: nada pode rodar nem "contar visita". A segurança vem do
// iframe (`sandbox=""`: sem scripts, origem opaca, sem formulário/popup/navegação do topo) e da CSP
// abaixo (sem script, sem conexão, sem frame, sem formulário). Este corte tira o que pesa ou o que
// dispararia sozinho num iframe sem scripts:
//   - <script>: não roda mesmo (sandbox + CSP); sai para não baixar à toa;
//   - <noscript>: com scripts desligados o navegador MOSTRA o noscript — é onde ficam os pixels de
//     rastreio (`<img src="https://www.facebook.com/tr?…">`); cada abertura da lista contaria uma
//     visita falsa no pixel do anúncio;
//   - <iframe>/<object>/<embed>/<frame>: vídeos e widgets de terceiros (pesados; a CSP já bloqueia);
//   - <meta http-equiv="refresh">: redirecionamento sozinho;
//   - <link rel="preload|prefetch|modulepreload|preconnect|dns-prefetch">: downloads antecipados;
//   - <img> de pixel conhecido FORA do noscript (facebook.com/tr, google-analytics, doubleclick, TikTok,
//     Bing, Pinterest, LinkedIn, X/Twitter): a CSP libera imagem de qualquer origem (a página precisa da
//     CDN), então esse é o único jeito de não contar visita falsa (QA 20.10a v2).
// É um corte por texto (não um sanitizador): o que escapar dele continua bloqueado pela CSP/sandbox.

const STRIP_BLOCKS = ['script', 'noscript', 'iframe', 'object', 'frameset', 'template'] as const;

const BLOCK_RES = STRIP_BLOCKS.map((tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'));
/** Abertura sem fechamento (HTML cortado) ou tags vazias: some só a tag. */
const LONE_RES = [
  /<\/?(?:script|noscript|iframe|object|frameset|template)\b[^>]*>/gi,
  /<(?:embed|frame)\b[^>]*>/gi,
  /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi,
  /<link\b[^>]*rel\s*=\s*["']?(?:preload|prefetch|modulepreload|preconnect|dns-prefetch)\b[^>]*>/gi,
  /<img\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com\/tr|google-analytics\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|analytics\.tiktok\.com|bat\.bing\.com|ct\.pinterest\.com|px\.ads\.linkedin\.com|analytics\.twitter\.com|t\.co\/i\/adsct)[^>]*>/gi,
];

export function thumbnailHtml(html: string): string {
  let out = html;
  for (const re of BLOCK_RES) out = out.replace(re, '');
  for (const re of LONE_RES) out = out.replace(re, '');
  return out;
}

/**
 * CSP da miniatura: imagem, CSS e fonte de qualquer origem (a landing usa CDN da Shopify/Supabase);
 * nada de script, conexão, frame, formulário, `<base>` nem objeto.
 */
export const THUMBNAIL_CSP = [
  "default-src 'none'",
  'img-src * data: blob:',
  "style-src * 'unsafe-inline'",
  'font-src * data:',
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  // QA 20.10a v2: a própria resposta se isola (origem opaca, sem script, sem meta refresh/navegação)
  // mesmo aberta direto na aba, fora do iframe `sandbox=""` — o corte por texto não pega
  // `http-equiv="&#114;efresh"` (entidade), o sandbox pega.
  'sandbox',
].join('; ');

/** HTML da miniatura quando a landing ainda não tem página (o cartão nem pede, mas a rota responde algo). */
export const EMPTY_THUMBNAIL_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
