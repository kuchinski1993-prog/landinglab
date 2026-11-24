import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface ClientOptions {
  databaseUrl?: string;
  max?: number;
}

export function createClient(options: ClientOptions = {}): {
  db: Database;
  sql: Sql;
} {
  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to create a database client');
  }

  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    prepare: false,
  });

  const db = drizzle(sql, { schema });

  return { db, sql };
}
