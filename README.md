# LandingLab

Sistema para **clonar ou gerar landing pages**, editar no editor visual e publicar em domínio próprio.

- **Landings**: lista, editor inline (textos, imagens, preços, links dos botões), exportar ZIP
- **Gerar ou clonar**: clona uma URL (Playwright) ou gera com IA a partir de um produto
- **Domínios**: comprar/conectar domínio e publicar a landing nele (Vercel + Porkbun/Spaceship)
- **Seed**: scripts para levar uma landing pronta de um banco para outro (`packages/db/scripts`)

Monorepo pnpm: `apps/backoffice` (painel), `apps/api` (auth e filas), `apps/worker` (jobs BullMQ),
`apps/landinglab-storefront` (serve as landings), `packages/*` (db, cloner, render, deploy, domínios...).

## Instalação

Siga o **[INSTALL.md](./INSTALL.md)**. Ele foi escrito para o Claude Code executar passo a passo:

> Clone https://github.com/kuchinski1993-prog/landinglab e siga o INSTALL.md para instalar tudo.

Resumo: `pnpm install` → preencher `.env` → `pnpm db:migrate` → buckets no Supabase → `pnpm create-owner` → `pnpm dev`.
