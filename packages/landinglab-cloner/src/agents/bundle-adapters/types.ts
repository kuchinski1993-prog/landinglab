// Types comuns pra Bundle Adapters (Engine V2, set/2026).

/** Oferta padronizada extraída de qualquer app de bundle. */
export interface DetectedBundleOffer {
  position: number;
  title: string;
  qty: number;
  /** Cents na moeda da landing. */
  priceCents: number;
  compareAtCents: number | null;
  saveText: string | null;
  badge: string | null;
  /** Variant ID do concorrente detectado (pode ser Shopify GID). Painel troca pelo seu. */
  detectedVariantId: string | null;
  isPreselected: boolean;
  /** Story 25.1: bullets do card (lista marcada com data-ll-bullets), na ordem visual. */
  bullets: string[];
}

export interface BundleAdapterResult {
  /** Nome do adapter que casou. */
  adapter: 'kaching' | 'generic' | 'none';
  /** Ofertas detectadas (ordem visual). */
  offers: DetectedBundleOffer[];
  /** HTML pós-transformações (scripts do app removidos, data-ll-* adicionados). */
  html: string;
  /** Notas humanas pra UI: "Kaching detectado, 3 ofertas, 3 preços mapeados". */
  notes: string;
}

export interface BundleAdapter {
  name: 'kaching' | 'generic';
  /** Retorna true se o HTML tem sinais desse app. */
  detect(html: string): boolean;
  /** Aplica: extrai offers + limpa scripts + marca data-ll-*. */
  apply(html: string): BundleAdapterResult;
}
