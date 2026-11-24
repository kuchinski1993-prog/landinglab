# Migrations VSL substituídas (não aplicar)

Estes arquivos são as migrations originais do VSL Hosting (branch
`rescue/vsl-hosting-review`). Foram **substituídos** na Fase F0 (2026-10-07) por:

- `../0086_vsl_baseline.sql` — shape final de todas as tabelas, colunas, funções,
  triggers, constraints e índices VSL/foundation (39 tabelas), idempotente, sem
  BEGIN/COMMIT. + `0086_vsl_baseline.rollback.sql` (só dev; com trava).
- `../0087_vsl_rls.sql` — RLS deny-all nas 39 tabelas (guardrail de BYPASSRLS).
  + `0087_vsl_rls.rollback.sql`.

Ficam aqui só como histórico (citadas nas stories `docs/stories/vsl-hosting/*`).
O diretório não é lido pelo migrator do Drizzle nem pelo `db:check`
(ambos só listam `migrations/*.sql` no nível de cima).

| Original | Onde está agora na baseline |
|---|---|
| `0074_vsl_hosted_foundation.sql` | **Não usada.** Alterava a FK `landing_domains.landing_page_id` (CASCADE → SET NULL) e o `NOT NULL`. A baseline usa o conteúdo equivalente da 0088, sem tocar em `landing_domains`. |
| `0088_vsl_prod_compat.sql` | Seção 1 (foundation) |
| `0076_vsl_import_lifecycle.sql` | Seção 2 |
| `0077_vsl_stream_uploads.sql` | Seção 3 |
| `0078_vsl_domain_publication.sql` | Seção 4 |
| `0079_vsl_variant_persistence.sql` | Seção 5 |
| `0080_vsl_translation_extraction.sql`, `0081_vsl_translation_review.sql` | Seção 6 |
| `0082_blackshop_domain_registry_vsl_bindings.sql` | Seção 7 |
| `0083_vsl_projects_steps.sql` | Seção 8 |
| `0084_vsl_independent_assets.sql` | Seção 9 |
| `0085_vsl_funnel_publication.sql` | Seção 10 |
| `0086_vsl_analytics.sql` | Seção 11 |
| `0087_vsl_legacy_bridge.sql` | Seção 12 |

## Por que consolidar (decisão do plano, opção B)

- O main **não usa `drizzle migrate` em produção**: desde `0076_enable_rls_landing_tables`
  as migrations são aplicadas por SQL manual no Supabase, com `.rollback.sql`, e
  **não são registradas** no `meta/_journal.json` (ele para em `0075`).
- As entradas VSL do journal (`when` = 1812349700001…1812349700014, jun/2027)
  foram **removidas**: com timestamps no futuro, o migrator do Drizzle 0.36 só
  aplica migrations com `folderMillis > max(created_at)` e passaria a ignorar em
  silêncio qualquer migration nova. O `_journal.json` voltou a ser idêntico ao do main.
  Observação: o main já tinha `0042_leads` com `when` 1812349700000 (pré-existente,
  não alterado aqui).
- Numeração: 0076–0085 colidiam com as migrations Stripe/LandingLab do main.
- Várias originais tinham `BEGIN/COMMIT` dentro do arquivo e não eram idempotentes.

## Produção (Supabase `wedgklpuelrhqzauopze`)

- As 39 tabelas já existem (vazias), com as colunas da 0088 em `landing_pages`.
  `landing_domains` continua `ON DELETE CASCADE` (a 0074 nunca foi aplicada).
- RLS já ligado nas 39 tabelas (hotfix 2026-10-07).
- `drizzle.__drizzle_migrations` tem linhas com `created_at` 1812349700001..014.
  Ficam órfãs (inofensivas enquanto produção não roda `drizzle migrate`).
  **Não rodar `pnpm db:migrate` contra produção.**
- Nada deste diretório nem da baseline precisa ser reaplicado em produção.
  Mudanças futuras de schema VSL entram como novas migrations numeradas (0088+),
  aplicadas por SQL manual auditado, com rollback.

## Bancos dev/CI

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0086_vsl_baseline.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f packages/db/migrations/0087_vsl_rls.sql
```

Após o merge, o Drizzle de `landing_pages` seleciona `content_mode`, `family_id`,
`locale` e `published_version_id`: **qualquer banco sem a baseline quebra as queries
LandingLab** — aplicar a 0086 em todo banco dev/CI/staging antes de rodar o código.
