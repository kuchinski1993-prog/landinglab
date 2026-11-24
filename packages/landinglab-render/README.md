# @blackshop/landinglab-render

Sanitização e render helpers para landing pages LandingLab.

## Responsabilidade

- Sanitizar HTML custom vindo do editor do backoffice LandingLab antes de renderizar no storefront.
- Aplicar scoping de CSS custom (evita vazar `body`/`html` do usuário pro tema do storefront).
- Gerar diff da sanitização pra auditoria no backoffice.

## Status atual — Story 13.1

Stub. Apenas o esqueleto do package. `sanitizeHtml()` retorna a string sem
modificação — NÃO usar em produção.

## Implementação real — Story 13.6

- `isomorphic-dompurify` (SSR-compatível) como sanitizer.
- Retorno `{ sanitized: string; diff: string | null }`.
- Whitelist de tags/atributos alinhada com CSP do storefront.
