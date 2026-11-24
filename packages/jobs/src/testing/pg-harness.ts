// Postgres real em memória (PGlite + socket) para testes do ledger job_runs (migration 0097).
// Mesmo desenho do harness do VSL (packages/vsl-hosting/src/testing/pg-harness.ts).
// Só para testes: nunca importar em código de produção.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type Database } from '@blackshop/db';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres, { type Sql } from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
export const JOB_RUNS_MIGRATIONS_DIR = resolve(here, '../../../db/migrations');
export const JOB_RUNS_MIGRATION = '0097_job_runs.sql';
export const JOB_RUNS_ROLLBACK = '0097_job_runs.rollback.sql';

export interface JobRunsTestDatabase {
  /** Cliente SQL cru (1 conexão) para asserts e para "derrubar" o banco. */
  sql: Sql;
  url: string;
  /** Novo cliente Drizzle (cada um com 1 conexão própria — dois "workers"). */
  drizzle: () => Database;
  migration: (file: string) => Promise<string>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startJobRunsTestDatabase(): Promise<JobRunsTestDatabase> {
  const db = await PGlite.create();
  let server: PGLiteSocketServer | undefined;
  let port = 0;
  for (let attempt = 0; attempt < 20 && !server; attempt++) {
    port = 41000 + Math.floor(Math.random() * 20000);
    const candidate = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 8 });
    try {
      await candidate.start();
      server = candidate;
    } catch {
      /* porta ocupada: tenta outra */
    }
  }
  if (!server) throw new Error('Could not start PGlite socket server');
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  const migration = (file: string): Promise<string> => readFile(resolve(JOB_RUNS_MIGRATIONS_DIR, file), 'utf8');
  // Duas passadas: prova a idempotência (IF NOT EXISTS). O arquivo tem BEGIN/COMMIT próprios.
  for (let pass = 0; pass < 2; pass++) await sql.unsafe(await migration(JOB_RUNS_MIGRATION));
  const clients: Array<{ sql: { end: (opts?: { timeout?: number }) => Promise<void> } }> = [];
  return {
    sql,
    url,
    migration,
    drizzle: () => {
      const client = createClient({ databaseUrl: url, max: 1 });
      clients.push(client);
      return client.db;
    },
    reset: async () => {
      await sql.unsafe('TRUNCATE "job_runs"');
    },
    close: async () => {
      for (const client of clients) await client.sql.end({ timeout: 1 }).catch(() => undefined);
      await sql.end({ timeout: 1 });
      await server!.stop();
      await db.close();
    },
  };
}
