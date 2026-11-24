// Story 16.3 — modo `external` no storefront (AC 4, 7, 12, 13).
//
// Landing `external` = checkout do produtor: nada de POST /api/landing-checkout, stripeCheckout
// nem Shopify. O script de navegação direta vem de `@blackshop/shared/external-checkout`, com o
// mapa kit->URL revalidado de `cta_config.externalCheckout` (fonte: servidor, nunca a query).
import {
  applySphereTrackerPolicy,
  buildExternalCheckoutScript,
  type CheckoutProvider,
  type ExternalCheckoutConfig,
} from '@blackshop/shared/external-checkout';

/**
 * Remove scripts legados de checkout que o cloner/worker possa ter persistido no HTML antes da
 * landing virar `external` (handler POST `__LL_CHECKOUT_API__` / `/api/landing-checkout`).
 */
export function stripLegacyCheckoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (match) =>
    /__LL_CHECKOUT_API__|\/api\/landing-checkout|\/landing-checkout\b/.test(match) ? '' : match,
  );
}

/**
 * Aplica a política do tracker do Sphere (default: removido; opt-in preserva só o tracker exato)
 * e, no modo `external`, remove os scripts legados de checkout.
 */
export function prepareLandingHtmlForProvider(
  html: string,
  provider: CheckoutProvider,
  external: ExternalCheckoutConfig,
): string {
  if (provider !== 'external') return applySphereTrackerPolicy(html, false);
  return applySphereTrackerPolicy(stripLegacyCheckoutScripts(html), external.allowSphereTracker === true);
}

/** `<script>` do modo `external` (string vazia se nenhum kit válido: CTA não reescrito). */
export function externalCheckoutHeadScript(external: ExternalCheckoutConfig): string {
  return buildExternalCheckoutScript(external);
}
