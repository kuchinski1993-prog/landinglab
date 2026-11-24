// Story 20.1 — carregamento do Polaris Web Components 2.x (CDN da Shopify).
//
// Um único bundle, sempre por este módulo: nunca adicione outro <script> Polaris
// (dois bundles registram os mesmos `s-*` e quebram o painel). Ver ADR-003.

/** Série 2.x (acompanha correções). A versão congelada seria `polaris-2.0.js`. */
export const POLARIS_WC_SRC = 'https://cdn.shopify.com/shopifycloud/polaris-2.js';
export const POLARIS_WC_SCRIPT_ID = 'polaris-wc';
/** Evento disparado em `window` quando o <script> do Polaris falha (rede/CDN). */
export const POLARIS_WC_ERROR_EVENT = 'polaris-wc-error';
/** Elemento usado como sinal de "bundle carregado e registrado". */
export const POLARIS_WC_SENTINEL = 's-page';
export const POLARIS_WC_TIMEOUT_MS = 5000;

declare global {
  interface Window {
    __polarisWcError?: boolean;
  }
}

/**
 * Script inline (roda antes do bundle) que registra a falha de carregamento do
 * <script id="polaris-wc">, mesmo que ela aconteça antes do React hidratar.
 */
export const POLARIS_WC_ERROR_TRACKER = `addEventListener('error',function(e){var t=e&&e.target;if(t&&t.id==='${POLARIS_WC_SCRIPT_ID}'){window.__polarisWcError=true;dispatchEvent(new Event('${POLARIS_WC_ERROR_EVENT}'))}},true);`;

export function isPolarisReady(): boolean {
  return typeof window !== 'undefined' && typeof window.customElements?.get(POLARIS_WC_SENTINEL) === 'function';
}

export function hasPolarisLoadFailed(): boolean {
  return typeof window !== 'undefined' && window.__polarisWcError === true;
}

/**
 * Espera o bundle registrar os elementos. Resolve `true` quando prontos e
 * `false` se o <script> falhar ou o tempo acabar — nunca rejeita.
 */
export function waitForPolaris(timeoutMs: number = POLARIS_WC_TIMEOUT_MS): {
  promise: Promise<boolean>;
  cancel: () => void;
} {
  let cancel = (): void => undefined;
  const promise = new Promise<boolean>((resolve) => {
    if (isPolarisReady()) {
      resolve(true);
      return;
    }
    if (typeof window === 'undefined' || !window.customElements) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(POLARIS_WC_ERROR_EVENT, onError);
      resolve(ok);
    };
    const onError = (): void => finish(false);
    const timer = window.setTimeout(() => finish(isPolarisReady()), timeoutMs);
    window.addEventListener(POLARIS_WC_ERROR_EVENT, onError);
    if (hasPolarisLoadFailed()) {
      finish(false);
      return;
    }
    void window.customElements.whenDefined(POLARIS_WC_SENTINEL).then(() => finish(true));
    cancel = () => {
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener(POLARIS_WC_ERROR_EVENT, onError);
    };
  });
  return { promise, cancel: () => cancel() };
}

/** "Tentar de novo": troca o <script> que falhou por um novo (mesma URL, um só no DOM). */
export function reloadPolarisScript(): void {
  if (typeof document === 'undefined' || isPolarisReady()) return;
  window.__polarisWcError = false;
  document.getElementById(POLARIS_WC_SCRIPT_ID)?.remove();
  const script = document.createElement('script');
  script.id = POLARIS_WC_SCRIPT_ID;
  script.src = POLARIS_WC_SRC;
  script.async = true;
  document.head.appendChild(script);
}
