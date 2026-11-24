// Ajudantes puros do checkout no browser (Stripe Elements) — QA 15.3.
//   UX-008: tarifas do Express Checkout com o frete atual da sessão primeiro
//           (a folha Apple Pay / Google Pay abre com a 1ª tarifa selecionada).
//   MNT-004: Elements recebe valores na unidade da Stripe (COP: 2 casas);
//            a sessão/API guardam a unidade da aplicação (Intl).
//   REL-001: uma troca de frete por vez no cliente.
import { toStripeAmount } from '@blackshop/payments/currency';

import type { ShippingOptionView } from './checkout-api';

export function elementsAmount(amountMinor: number, currency: string): number {
  return toStripeAmount(amountMinor, currency);
}

export function expressShippingRates(
  options: ShippingOptionView[],
  currentMethod: ShippingOptionView['method'] | null | undefined,
  currency: string,
) {
  const ordered = [...options].sort((a, b) => Number(b.method === currentMethod) - Number(a.method === currentMethod));
  return ordered.map((o) => ({
    id: o.method,
    displayName: o.label,
    amount: elementsAmount(o.amountMinor, currency),
    deliveryEstimate: {
      minimum: { unit: 'business_day' as const, value: o.minDays },
      maximum: { unit: 'business_day' as const, value: o.maxDays },
    },
  }));
}

/**
 * Serializa as trocas de frete: enquanto uma está pendente, novos pedidos são
 * ignorados (retornam false) — os rádios ficam desabilitados via `onPending`.
 */
export function createShippingSwitch<M extends string>(
  change: (method: M) => Promise<boolean>,
  onPending: (pending: boolean) => void,
): (method: M) => Promise<boolean> {
  let busy = false;
  return async (method) => {
    if (busy) return false;
    busy = true;
    onPending(true);
    try {
      return await change(method);
    } finally {
      busy = false;
      onPending(false);
    }
  };
}
