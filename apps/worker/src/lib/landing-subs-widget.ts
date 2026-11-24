// Decide se/como o widget Subscribe & Save (§7.4 do apply-bundle) é injetado.
//
// Shopify (inalterado): só com subsEnabled + subsSellingPlanId — o selling plan
//   vai para o cartCreate; o desconto real vem do plano (widget é só visual).
// Stripe (Story 15.6): subsEnabled + subsInterval válido (sem selling plan). O
//   CTA envia `subscribe: true` e o servidor cobra preço × (1 − subsDiscountPercent)
//   em todas as faturas — por isso o % visual vem SÓ de subsDiscountPercent
//   (sem o fallback do label legado, que não existe no servidor).
//   Landing Stripe sem intervalo não ganha widget, mesmo com selling plan
//   antigo salvo (evita "assinatura falsa" cobrada como avulsa).
// External (Story 16.3): checkout do produtor, sem assinatura → nunca há widget,
//   mesmo com selling plan/intervalo antigos salvos.

export interface SubsWidgetPage {
  checkoutProvider?: string | null;
  subsEnabled?: boolean | null;
  subsSellingPlanId?: string | null;
  subsInterval?: string | null;
  subsIntervalCount?: number | null;
  subsDiscountPercent?: number | null;
}

export type SubsWidgetMode =
  | { mode: 'shopify'; planId: string }
  | { mode: 'stripe'; discountPercent: number }
  | null;

const STRIPE_INTERVALS = new Set(['day', 'week', 'month', 'year']);

export function subsWidgetMode(page: SubsWidgetPage): SubsWidgetMode {
  if (!page.subsEnabled) return null;
  if (page.checkoutProvider === 'external') return null;
  if (page.checkoutProvider === 'stripe') {
    if (!page.subsInterval || !STRIPE_INTERVALS.has(page.subsInterval)) return null;
    const count = page.subsIntervalCount ?? 1;
    // QA 15.6 REQ-001: a Stripe limita a recorrência a 1 ano (year → só 1).
    const maxCount = page.subsInterval === 'year' ? 1 : 12;
    if (!Number.isInteger(count) || count < 1 || count > maxCount) return null;
    const pct = page.subsDiscountPercent ?? 0;
    return { mode: 'stripe', discountPercent: Number.isInteger(pct) && pct >= 0 && pct <= 99 ? pct : 0 };
  }
  const planId = String(page.subsSellingPlanId ?? '').trim();
  return planId ? { mode: 'shopify', planId } : null;
}
