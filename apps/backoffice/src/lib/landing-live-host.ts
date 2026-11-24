// Host REAL em que a landing está no ar (E2E Stripe B-1).
//
// O "Republicar" do editor pré-preenchia o slug com landing_pages.slug (ex.:
// chemistry-club-clone-muqrb8ue), que não é o subdomínio publicado
// (chemistry-club.cubipiccanti.online). Republicar ali criava OUTRO binding.
// A fonte da verdade é landing_domain_bindings (o que o storefront resolve):
// hostname = "<slug>.<domínio>" (slug vazio = raiz do domínio).

export interface LiveBindingRow {
  domainId: string;
  domain: string;
  /** Subdomínio do binding ('' = raiz). */
  slug: string;
  role: string;
  updatedAt: Date | string | null;
}

export interface LiveHost {
  hostname: string;
  domainId: string;
  domain: string;
  slug: string;
}

const PUBLISHABLE_ROLES = new Set(['active', 'pending_dns']);
const SUB_PREFIX_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function hostOf(row: Pick<LiveBindingRow, 'slug' | 'domain'>): string {
  return row.slug ? `${row.slug}.${row.domain}` : row.domain;
}

/**
 * Escolhe o binding vivo: o do deployment atual (landing_pages.current_deployment_id)
 * quando existir entre os bindings; senão o binding atualizado mais recentemente.
 * Ignora domínios desativados e slugs que não são subdomínio (modelo path legado).
 */
export function pickLiveHost(rows: LiveBindingRow[], currentDeploymentHostname: string | null): LiveHost | null {
  const usable = rows.filter(
    (r) => PUBLISHABLE_ROLES.has(r.role) && r.domain && (r.slug === '' || SUB_PREFIX_RE.test(r.slug)),
  );
  if (usable.length === 0) return null;
  const current = currentDeploymentHostname?.toLowerCase() ?? null;
  const time = (r: LiveBindingRow) => (r.updatedAt ? new Date(r.updatedAt).getTime() || 0 : 0);
  const chosen =
    (current ? usable.find((r) => hostOf(r).toLowerCase() === current) : undefined) ??
    [...usable].sort((a, b) => time(b) - time(a))[0]!;
  return { hostname: hostOf(chosen), domainId: chosen.domainId, domain: chosen.domain, slug: chosen.slug };
}

/**
 * O operador manteve no formulário o domínio/slug do host vivo? Então o
 * "Republicar landing" (Stripe) vai para o host vivo — inclusive raiz de
 * domínio, que não tem slug e não passaria na validação do campo.
 */
export function isLiveSelection(live: LiveHost | null, domainId: string, normalizedSlug: string): live is LiveHost {
  return Boolean(live && domainId === live.domainId && normalizedSlug === live.slug);
}
