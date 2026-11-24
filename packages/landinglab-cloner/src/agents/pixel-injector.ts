// Meta Pixel injector — Fase D.1 (2026-09-15).
//
// Injeta o snippet oficial do Meta Pixel + PageView + ViewContent no HTML
// clonado. Roda DEPOIS do checkout-handler-injector (etapa 8 do orchestrator).
//
// Config vem de landing_pixels (persistido pelo backoffice):
//   - pixelId: Facebook Pixel ID (obrigatório)
//   - eventsEnabled: array de eventos (ex: ["PageView","ViewContent","Purchase"])
//   - eventTestCode: opcional, dispara em test mode do Events Manager
//   - contentIds: array de IDs de produto (usado em ViewContent)
//   - contentName: nome do produto (usado em ViewContent)
//   - value: preço (usado em ViewContent + Purchase)
//   - currency: ISO 4217 (default USD)
//
// Attribution é AUTO-COLETADA pelo próprio pixel:
//   - Pixel salva _fbp cookie na primeira visita
//   - Query param `fbclid` → salvo em _fbc cookie automaticamente
//   - checkout-handler-injector já lê esses cookies e envia ao CAPI
//
// Purchase NÃO é disparado aqui — é disparado server-side via CAPI
// pelo tracker-capi.processor (Fase Set/2026), quando o pedido Shopify
// gera webhook. Isso garante attribution mesmo com adblocker.
//
// Sanitize (etapa 5) remove todos os <script> antes desse injector rodar
// (na etapa 8), então garante que nenhum pixel legado sobreviveu.
//
// Zero deps externas. ES5 puro pra máxima compat.

/** Config do pixel — subset de landing_pixels + tracking-payload joins. */
export interface PixelConfig {
  /** Facebook Pixel ID (numérico como string, ex: "123456789012345"). */
  pixelId: string;
  /** Eventos a emitir client-side no load. Default: ['PageView']. */
  eventsEnabled?: string[];
  /** Test event code do Events Manager (só em dev). */
  eventTestCode?: string | null;
  /** IDs de produto pra ViewContent (ex: ["shopify-gid-xxx"]). */
  contentIds?: string[];
  /** Nome do produto pra ViewContent. */
  contentName?: string | null;
  /** Valor monetário pra ViewContent (float, ex: 49.90). */
  value?: number | null;
  /** ISO 4217 currency (default 'USD'). */
  currency?: string | null;
  /** Content type pra ViewContent (default 'product'). */
  contentType?: 'product' | 'product_group' | null;
}

/**
 * Escapa string pra uso seguro dentro de string literal JS.
 * Evita XSS via injeção de aspas/quebras no pixelId ou contentName.
 */
function escapeJs(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/<\//g, '<\\/');
}

/**
 * Valida pixelId — deve ser 15-16 dígitos numéricos.
 * Formato Meta Pixel padrão.
 */
function isValidPixelId(id: string): boolean {
  return /^\d{13,17}$/.test(id.trim());
}

/**
 * Gera o snippet base do Meta Pixel (fbq loader).
 * Copiado da doc oficial: https://developers.facebook.com/docs/meta-pixel/get-started
 */
function buildBaseSnippet(pixelId: string, testCode: string | null | undefined): string {
  const testCodeInit = testCode
    ? `fbq('set','autoConfig','false','${escapeJs(pixelId)}');\n  fbq('init','${escapeJs(pixelId)}',{},{eventID:'${escapeJs(testCode)}'});`
    : `fbq('init','${escapeJs(pixelId)}');`;

  // data-landinglab-pixel="loader" marca o script como legítimo (injetado por nós)
  // pra o sanitizer do storefront (sanitize-landing-html.ts) preservar. Sem esse
  // marker, TRACKER_PATTERNS.connect\.facebook\.net removeria o loader.
  return `<!-- Meta Pixel Code (LandingLab) -->
<script data-landinglab-pixel="loader">
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
${testCodeInit}
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${escapeJs(pixelId)}&ev=PageView&noscript=1"/></noscript>
<!-- End Meta Pixel Code -->`;
}

/**
 * Gera fbq calls pra cada evento habilitado.
 * PageView é sempre disparado (mesmo se não estiver no eventsEnabled), pois
 * é o baseline pra retargeting funcionar.
 */
function buildEventCalls(config: PixelConfig): string {
  const events = new Set(config.eventsEnabled ?? []);
  events.add('PageView'); // baseline obrigatório

  const calls: string[] = [];

  for (const event of events) {
    if (event === 'PageView') {
      calls.push(`fbq('track','PageView');`);
    } else if (event === 'ViewContent') {
      // ViewContent só faz sentido com dados de produto.
      const params: Record<string, unknown> = {};
      if (config.contentIds && config.contentIds.length > 0) {
        params['content_ids'] = config.contentIds;
      }
      if (config.contentName) {
        params['content_name'] = config.contentName;
      }
      if (config.contentType) {
        params['content_type'] = config.contentType;
      }
      if (typeof config.value === 'number' && config.value > 0) {
        params['value'] = config.value;
        params['currency'] = config.currency ?? 'USD';
      }
      const hasParams = Object.keys(params).length > 0;
      calls.push(
        hasParams
          ? `fbq('track','ViewContent',${JSON.stringify(params)});`
          : `fbq('track','ViewContent');`,
      );
    } else if (event === 'InitiateCheckout' || event === 'AddToCart') {
      // Esses são disparados no CLIQUE do botão, não no load. Skip.
      // O checkout-handler-injector emite via fbq('track','InitiateCheckout')
      // quando o botão é clicado (adicionar na Fase D.2 se quisermos).
    } else if (event === 'Purchase') {
      // Purchase é server-side via CAPI. Skip no client.
    } else {
      // Eventos customizados: emite raw.
      calls.push(`fbq('trackCustom',${JSON.stringify(event)});`);
    }
  }

  if (calls.length === 0) return '';

  return `<script data-landinglab-pixel="events">
${calls.join('\n')}
</script>`;
}

/**
 * Injeta o Meta Pixel completo (base + eventos) antes de </head>.
 * Se não tiver </head>, prepend no início do HTML.
 * Idempotente: skip se já contém 'fbq(' na página.
 *
 * Se config for null/undefined ou pixelId inválido, retorna HTML original.
 * Nunca throw — falhar silenciosamente é preferível a bloquear o clone.
 */
export function injectMetaPixel(html: string, config: PixelConfig | null | undefined): string {
  if (!config) return html;
  if (!isValidPixelId(config.pixelId)) return html;
  if (html.includes('fbq(') && html.includes('facebook.net/en_US/fbevents.js')) {
    // Pixel já injetado (raro — sanitize remove scripts, mas defensivo).
    return html;
  }

  const baseSnippet = buildBaseSnippet(config.pixelId, config.eventTestCode ?? null);
  const eventCalls = buildEventCalls(config);
  const fullSnippet = `${baseSnippet}\n${eventCalls}`;

  if (html.includes('</head>')) {
    return html.replace('</head>', `${fullSnippet}\n</head>`);
  }
  // Sem </head> → prepend (browsers renderizam mesmo assim).
  return `${fullSnippet}\n${html}`;
}
