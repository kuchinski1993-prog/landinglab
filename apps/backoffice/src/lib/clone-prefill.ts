// Story 16.2 (AC 12-13) — pré-preenchimento do cloner via query string
// (`/landing-pages/new?mode=clone&url=<URL codificada>`). Só lê: nada inicia sozinho.
// Story 16.3 (AC 15-16) — `&offer=<slug>&funnel=<id>` opcionais: ao concluir a clonagem o cloner
// aplica o checkout externo do funil (rota do catálogo). Sem eles, comportamento da 16.2 inalterado.

export interface ClonePrefill {
  mode: 'clone';
  /** URL https válida; vazia quando ausente ou não-https (ignorada sem erro). */
  url: string;
  /** Slug da oferta do catálogo (só presente junto com `funnel`). */
  offer?: string;
  /** Id do funil escolhido (só presente junto com `offer`). Validado pela rota do catálogo. */
  funnel?: string;
}

function httpsOrEmpty(raw: string | null): string {
  const value = raw?.trim() ?? '';
  if (!value) return '';
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

/** `mode` diferente de `clone` (ausente ou inválido) → null: comportamento atual inalterado. */
export function parseClonePrefill(search: string | URLSearchParams): ClonePrefill | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (params.get('mode') !== 'clone') return null;
  const prefill: ClonePrefill = { mode: 'clone', url: httpsOrEmpty(params.get('url')) };
  const offer = params.get('offer')?.trim() ?? '';
  const funnel = params.get('funnel')?.trim() ?? '';
  // Par incompleto é ignorado (clone segue o fluxo normal, sem checkout externo). O formato é
  // validado só no servidor (rota do catálogo), sem duplicar a regra aqui.
  if (offer && funnel) {
    prefill.offer = offer;
    prefill.funnel = funnel;
  }
  return prefill;
}

/** Link para o cloner com a URL da página já preenchida (e, opcionalmente, oferta + funil). */
export function cloneHref(pageUrl: string, source?: { offer: string; funnel: string }): string {
  const params = new URLSearchParams({ mode: 'clone', url: pageUrl });
  if (source) {
    params.set('offer', source.offer);
    params.set('funnel', source.funnel);
  }
  return `/landing-pages/new?${params.toString()}`;
}
