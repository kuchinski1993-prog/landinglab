// Story 23.1b · loja da PLATAFORMA (multi-loja) dona do dado de uma landing do LandingLab.
// O LandingLab grava as próprias tabelas com o namespace legado `l0i` (fora do multi-loja do
// EPIC-17 — landing_pages/landing_orders/stripe_accounts nascem com store_id = 'l0i'). Até a 23.1b,
// o pixel global e os avisos dessas landings eram SEMPRE os da `default`; isso continua igual para
// `l0i`, `default` e landing sem loja. Uma landing gravada com o id de outra loja real (ex.: a
// SOULRYA) passa a usar o pixel/caixa DESSA loja — nunca o da `default` (sem fallback entre lojas).

export const PLATFORM_DEFAULT_STORE_ID = 'default';
export const LANDINGLAB_LEGACY_STORE_ID = 'l0i';

/** Loja da plataforma para o pixel global e os avisos de uma landing (`landing_pages.store_id`). */
export function landingOwnerStoreId(landingStoreId: string | null | undefined): string {
  const id = typeof landingStoreId === 'string' ? landingStoreId.trim() : '';
  if (id === '' || id === LANDINGLAB_LEGACY_STORE_ID) return PLATFORM_DEFAULT_STORE_ID;
  return id;
}
