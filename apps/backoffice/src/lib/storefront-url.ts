// Story 20.5f — endereço público da vitrine para os botões "Ver na loja" / "Ver loja" / "Ver ao vivo".
//
// O valor vem de NEXT_PUBLIC_STOREFRONT_URL (inlinado no build). Em produção não existe fallback:
// sem a variável, ou com ela apontando para a máquina local (localhost, 127.0.0.1…), o botão fica
// desabilitado com aviso em vez de mandar o dono para http://localhost:3002. Em desenvolvimento o
// endereço local continua valendo (é onde a vitrine roda).

export type StorefrontUrlProblem = 'missing' | 'invalid' | 'local_in_production';

export type StorefrontUrlResolution =
  | { ok: true; url: string }
  | { ok: false; reason: StorefrontUrlProblem };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(host) || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Decide se o endereço da vitrine pode ir para um link. Sem barra no fim (`${url}/products/…`). */
export function resolveStorefrontUrl(raw: string | null | undefined, options: { production: boolean }): StorefrontUrlResolution {
  const value = (raw ?? '').trim();
  if (!value) return { ok: false, reason: 'missing' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'invalid' };
  if (options.production && isLocalHostname(parsed.hostname)) return { ok: false, reason: 'local_in_production' };
  return { ok: true, url: value.replace(/\/+$/, '') };
}

/** Aviso mostrado junto do botão desabilitado. */
export function storefrontUrlProblemMessage(reason: StorefrontUrlProblem): string {
  switch (reason) {
    case 'local_in_production':
      return 'O endereço da vitrine está apontando para este computador (localhost). Configure o endereço público da loja para ver a vitrine.';
    case 'invalid':
      return 'O endereço da vitrine configurado é inválido. Corrija o endereço público da loja para ver a vitrine.';
    default:
      return 'O endereço da vitrine não está configurado. Configure o endereço público da loja para ver a vitrine.';
  }
}

/** Endereço da vitrine deste build (NEXT_PUBLIC_STOREFRONT_URL + NODE_ENV inlinados pelo Next). */
export function getStorefrontUrl(): StorefrontUrlResolution {
  return resolveStorefrontUrl(process.env.NEXT_PUBLIC_STOREFRONT_URL, {
    production: process.env.NODE_ENV === 'production',
  });
}
