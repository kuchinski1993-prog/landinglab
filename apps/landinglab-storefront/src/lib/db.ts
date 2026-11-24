// Singleton Drizzle client pro storefront LandingLab.
// Lazy init — não abre conexão em build-time.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as landingLabSchema from '@blackshop/db/schema-landinglab-core';

type LandingLabDb = PostgresJsDatabase<typeof landingLabSchema>;

interface GlobalWithLandingLabDb {
  __storefrontDb?: LandingLabDb;
  __storefrontSql?: Sql;
}

const g = globalThis as unknown as GlobalWithLandingLabDb;

export function getDb(): LandingLabDb {
  if (!g.__storefrontDb) {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for storefront');
    }
    // Vercel Serverless: cada instance handle 1 request por vez (não é
    // multi-threaded). `max: 5` × 40 instances = 200 conexões = limite Supabase.
    // Reduzimos pra `max: 1` — cada instance abre 1 conexão só, muito mais
    // instances cabem antes de estourar EMAXCONN.
    // `idle_timeout: 20` fecha connections idle > 20s (libera pool Supabase).
    const sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
    g.__storefrontSql = sql;
    g.__storefrontDb = drizzle(sql, { schema: landingLabSchema });
  }
  return g.__storefrontDb;
}
