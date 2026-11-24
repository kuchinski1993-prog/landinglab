export type { SpaceshipAdapter, DnsRecord } from './spaceship.js';
export type { VercelDomainsAdapter } from './vercel.js';
export {
  createVercelDomainsClient,
  VercelDomainsConfigError,
  VercelDomainsHttpError,
} from './vercel.js';

/**
 * Resolve landing_page_id a partir do hostname público (usado pelo middleware
 * do storefront L0i pra multi-domain routing).
 *
 * Stub — implementação real em Story 13.4.
 */
export async function getDomainForHost(_host: string): Promise<string | null> {
  throw new Error('Not implemented — Story 13.4');
}

/**
 * Troca o domínio ATIVO ↔ RESERVA de uma landing (contingência anti-ban).
 *
 * Stub — implementação real em Story 13.4.
 */
export async function swapActiveDomain(_landingPageId: string): Promise<void> {
  throw new Error('Not implemented — Story 13.4');
}
