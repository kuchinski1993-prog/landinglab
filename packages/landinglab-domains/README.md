# @blackshop/landinglab-domains

Adapters de gerenciamento de domínios pras landings LandingLab.

## Responsabilidade

- Registro de domínios raiz via Spaceship API (mais barato que Namecheap/GoDaddy pra LATAM).
- Attach/verify de domínios em projects Vercel (backoffice e storefront LandingLab).
- Resolver `hostname → landing_page_id` no middleware do storefront.
- Swap `ativo ↔ reserva` (contingência anti-ban por landing).

## Status atual — Story 13.1

Stub. Interfaces `SpaceshipAdapter`, `VercelDomainsAdapter`, `DnsRecord` e
funções `getDomainForHost()` / `swapActiveDomain()` que lançam `Error` até
serem implementadas na Story 13.4.

## Implementação real — Story 13.4

- HTTP client com retry/backoff (Spaceship + Vercel API v10).
- Persistência de state em `landing_domains` (schema-landinglab-core.ts).
- Cache local de `hostname → landing_page_id` pro middleware (evita hit no DB por request).
