// Drizzle client singleton para o LandingLab backoffice.
//
// Lazy init — `getDb()` cria a conexão só quando alguém chama. Importar o
// módulo (build-time, collecting page data) NÃO abre conexão nem exige env.
//
// Usa pool `postgres-js`. Padrão `globalThis.__landingLabDb` evita explosão de
// conexões durante hot-reload em dev — mesma tática recomendada pra Prisma.
//
// Schema utilizado: `schema-landinglab-core` (landing_pages + tabelas core do
// LandingLab). Sem incluir `schema` principal do AuthenLondon — evita coupling
// desnecessário.
//
// TODO(pós-13.7): quando os endpoints REST /api/landinglab/* forem criados em
// apps/api, migrar as server actions pra chamá-los ao invés de bater direto no
// banco.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as landingLabSchema from '@blackshop/db/schema-landinglab-core';

type LandingLabDb = PostgresJsDatabase<typeof landingLabSchema>;

interface GlobalWithLandingLabDb {
  __landingLabDb?: LandingLabDb;
  __landingLabSql?: Sql;
}

const globalWithDb = globalThis as unknown as GlobalWithLandingLabDb;

function createLandingLabDb(): { db: LandingLabDb; sql: Sql } {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for @blackshop/backoffice (LandingLab)');
  }
  // Vercel Serverless: 1 conexão por instance basta (handle 1 req/vez).
  // `max: 5` × N instances estava estourando limite Supabase (200).
  // idle_timeout: fecha conexões idle > 20s (libera pool Supabase).
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema: landingLabSchema });
  return { db, sql };
}

/**
 * Retorna a instância singleton do Drizzle client. Cria na primeira chamada.
 * NÃO chame em top-level de módulos — só dentro de server actions / server
 * components, senão quebra build-time (env vars não disponíveis).
 */
export function getDb(): LandingLabDb {
  if (!globalWithDb.__landingLabDb) {
    const { db, sql } = createLandingLabDb();
    globalWithDb.__landingLabDb = db;
    globalWithDb.__landingLabSql = sql;
  }
  return globalWithDb.__landingLabDb;
}

/**
 * Retorna o client `postgres-js` cru (sem Drizzle). Necessário para colunas
 * ainda não modeladas em Drizzle TS (ex.: `reviews_source`, `skeleton_status`
 * do Skeleton Mode — ver schema-skeleton-mode.ts §Notas) ou para transações
 * atômicas via `sql.begin()`.
 *
 * Compartilha o mesmo pool do Drizzle (mesma singleton). Uso típico:
 *
 *   const sql = getSql();
 *   await sql.begin(async (tx) => {
 *     await tx`UPDATE ... WHERE ...`;
 *   });
 */
export function getSql(): Sql {
  if (!globalWithDb.__landingLabSql) {
    // Lazy init via getDb() garante que sql e db compartilham o pool.
    getDb();
  }
  if (!globalWithDb.__landingLabSql) {
    throw new Error('Failed to initialize postgres client');
  }
  return globalWithDb.__landingLabSql;
}
