// Marca do header do checkout (Story 15.7). Módulo sem 'use client': as
// páginas (server components) chamam headerBrandOf antes de renderizar.
import type { CheckoutBrand } from '@/lib/checkout-api';

/** Marca do header: logo (Story 15.7) ou só o nome da marca. */
export type HeaderBrand = Pick<CheckoutBrand, 'name'> & Partial<Omit<CheckoutBrand, 'name'>>;

export const LOGO_HEIGHT = { min: 16, max: 120, default: 32 } as const;

/**
 * Marca do header a partir da view da API: `brand` (com logo) quando existe;
 * senão o `brandName` antigo (API anterior à 15.7). Defesa em profundidade:
 * logo só https, altura 16–120, alinhamento conhecido.
 */
export function headerBrandOf(view: { brand?: CheckoutBrand | null; brandName?: string | null }): HeaderBrand | null {
  const name = view.brand?.name?.trim() || view.brandName?.trim() || null;
  const logoUrl = view.brand?.logoUrl && /^https:\/\//.test(view.brand.logoUrl) ? view.brand.logoUrl : null;
  if (!name && !logoUrl) return null;
  const h = view.brand?.logoHeight;
  const align = view.brand?.logoAlign;
  return {
    name,
    logoUrl,
    logoHeight: Number.isInteger(h) && h! >= LOGO_HEIGHT.min && h! <= LOGO_HEIGHT.max ? h! : LOGO_HEIGHT.default,
    logoAlign: align === 'center' || align === 'right' ? align : 'left',
  };
}
