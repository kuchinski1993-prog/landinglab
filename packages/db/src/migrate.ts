import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function applyPostMigrations(
  sql: postgres.Sql,
  postMigrationsFolder: string
): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(postMigrationsFolder)).filter((file) => file.endsWith('.sql')).sort();
  } catch {
    // No post-migrations folder is fine; just skip.
    return;
  }

  for (const file of files) {
    const fullPath = resolve(postMigrationsFolder, file);
    const contents = await readFile(fullPath, 'utf8');
    // eslint-disable-next-line no-console
    console.log('[db:migrate] Applying post-migration', file);
    await sql.unsafe(contents);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const migrationsFolder = resolve(packageRoot, 'migrations');
  const postMigrationsFolder = resolve(packageRoot, 'post-migrations');

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const db = drizzle(sql);

  // eslint-disable-next-line no-console
  console.log('[db:migrate] Running migrations from', migrationsFolder);

  try {
    await migrate(db, { migrationsFolder });
    // eslint-disable-next-line no-console
    console.log('[db:migrate] Drizzle migrations applied');

    await applyPostMigrations(sql, postMigrationsFolder);
    // eslint-disable-next-line no-console
    console.log('[db:migrate] All migrations applied successfully');
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[db:migrate] Failed:', error);
  process.exit(1);
});
