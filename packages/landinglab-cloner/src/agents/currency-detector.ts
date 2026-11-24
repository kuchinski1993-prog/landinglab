// Detecta a moeda da loja de origem no HTML clonado (Story 15.2).
//
// Só marcadores explícitos de código ISO — nunca o símbolo ("$" é ambíguo).
// Ordem: moeda ativa da sessão Shopify > mercado > metas de preço > JSON-LD.
// Leitura pura: não altera o HTML.

const PATTERNS: readonly RegExp[] = [
  // Shopify.currency = {"active":"EUR","rate":"1.0"}  /  Shopify.currency.active = 'EUR'
  /Shopify\.currency\s*=\s*\{[^}]*?["']?active["']?\s*:\s*["']([A-Za-z]{3})["']/,
  /Shopify\.currency\.active\s*=\s*["']([A-Za-z]{3})["']/,
  // Tema/apps (Kaching, product-json): "marketCurrencyCode":"EUR" — cru ou HTML-escaped.
  /["']marketCurrencyCode["']\s*:\s*["']([A-Za-z]{3})["']/,
  /&quot;marketCurrencyCode&quot;\s*:\s*&quot;([A-Za-z]{3})&quot;/,
  // <meta property="og:price:currency" content="EUR"> (qualquer ordem de atributos).
  /<meta[^>]+(?:og|product):price:currency["'][^>]*content=["']([A-Za-z]{3})["']/i,
  /<meta[^>]+content=["']([A-Za-z]{3})["'][^>]*(?:og|product):price:currency["']/i,
  // JSON-LD Offer.
  /["']priceCurrency["']\s*:\s*["']([A-Za-z]{3})["']/,
];

function isIsoCurrency(code: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export function detectSourceCurrency(html: string): string | null {
  for (const pattern of PATTERNS) {
    const match = pattern.exec(html);
    const code = match?.[1]?.toUpperCase();
    if (code && isIsoCurrency(code)) return code;
  }
  return null;
}
