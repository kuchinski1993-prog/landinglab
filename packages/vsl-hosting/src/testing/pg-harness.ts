// Postgres real em memória (PGlite + socket) para testes de integração VSL.
// Aplica fixture LandingLab mínima + 0086 + 0087 + 0088 + 0089 + 0090 (duas vezes, provando idempotência).
// Só para testes: nunca importar em código de produção.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres, { type Sql } from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, '../../../db/migrations');
const fixture = resolve(here, '../../../db/src/__fixtures__/vsl-legacy-base.sql');

export interface VslTestDatabase {
  sql: Sql;
  url: string;
  /** Apaga dados de todas as tabelas VSL (mantém schema). */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export const VSL_MIGRATION_FILES = ['0086_vsl_baseline.sql', '0087_vsl_rls.sql', '0088_vsl_g3_backend.sql', '0089_vsl_f1b_editing.sql', '0090_vsl_meta_capi.sql'];

export async function startVslTestDatabase(): Promise<VslTestDatabase> {
  const db = await PGlite.create();
  let server: PGLiteSocketServer | undefined;
  let port = 0;
  for (let attempt = 0; attempt < 20 && !server; attempt++) {
    port = 41000 + Math.floor(Math.random() * 20000);
    const candidate = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 4 });
    try { await candidate.start(); server = candidate; } catch { /* porta ocupada: tenta outra */ }
  }
  if (!server) throw new Error('Could not start PGlite socket server');
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  // PGlite é uma única sessão; o servidor de socket serializa as conexões e dá prioridade
  // a quem abriu a transação. Use 1 conexão por cliente.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  await sql.unsafe(await readFile(fixture, 'utf8'));
  for (let pass = 0; pass < 2; pass++)
    for (const file of VSL_MIGRATION_FILES) {
      const text = await readFile(resolve(migrations, file), 'utf8');
      await sql.begin((tx) => tx.unsafe(text));
    }
  const tables = (await sql<{ name: string }[]>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`).map((row) => row.name);
  return {
    sql,
    url,
    reset: async () => {
      // TRUNCATE não dispara os triggers de imutabilidade (são por linha, UPDATE/DELETE).
      await sql.unsafe(`TRUNCATE ${tables.map((name) => `"${name}"`).join(',')} CASCADE`);
    },
    close: async () => {
      await sql.end({ timeout: 1 });
      await server!.stop();
      await db.close();
    },
  };
}
