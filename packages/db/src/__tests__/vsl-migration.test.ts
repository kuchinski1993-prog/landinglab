import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { assertDisposableDatabaseUrl } from './helpers/disposable-database.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../__fixtures__/vsl-legacy-base.sql');
const baselinePath = resolve(here, '../../migrations/0086_vsl_baseline.sql');
const rlsPath = resolve(here, '../../migrations/0087_vsl_rls.sql');
const journalPath = resolve(here, '../../migrations/meta/_journal.json');
const databaseUrl = process.env['VSL_TEST_DATABASE_URL'];

const VSL_TABLE_COUNT = 39;

function executable(sqlText: string): string {
  return sqlText
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('VSL baseline migration safety (static)', () => {
  it('never changes the LandingLab-owned landing_domains table', async () => {
    const sqlText = executable(await readFile(baselinePath, 'utf8'));

    expect(sqlText).not.toMatch(/ALTER\s+TABLE\s+landing_domains/i);
    expect(sqlText).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|TRIGGER|FUNCTION|INDEX)/i);
    expect(sqlText).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|UPDATE\s+landing_domains)\b/i);
  });

  it('is idempotent and transaction-neutral', async () => {
    const sqlText = executable(await readFile(baselinePath, 'utf8'));

    expect(sqlText).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sqlText).not.toMatch(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/CREATE\s+FUNCTION/i);
    expect(sqlText).not.toMatch(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i);
    // Triggers só dentro de blocos guardados por pg_trigger.
    const triggers = sqlText.match(/CREATE\s+TRIGGER/gi) ?? [];
    const guards = sqlText.match(/FROM\s+pg_trigger/gi) ?? [];
    expect(triggers.length).toBeGreaterThan(0);
    expect(guards.length).toBe(triggers.length);
    expect(sqlText.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi)).toHaveLength(VSL_TABLE_COUNT);
  });

  it('enables RLS on every baseline table', async () => {
    const baseline = executable(await readFile(baselinePath, 'utf8'));
    const rls = executable(await readFile(rlsPath, 'utf8'));
    const tables = [...baseline.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map(
      (m) => m[1]
    );
    const rlsTables = [...rls.matchAll(/ALTER\s+TABLE\s+public\.(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map(
      (m) => m[1]
    );
    expect(rlsTables.sort()).toEqual(tables.sort());
    expect(rls).toMatch(/rolbypassrls/);
  });

  it('keeps VSL migrations out of the drizzle journal', async () => {
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    expect(journal.entries.filter((e) => /vsl/i.test(e.tag))).toEqual([]);
    expect(journal.entries.filter((e) => e.when > 1812349700000)).toEqual([]);
  });
});

describe.skipIf(!databaseUrl)('VSL baseline on a disposable database', () => {
  it('preserves legacy rows, keeps landing_domains CASCADE and is idempotent', async () => {
    const sql = postgres(assertDisposableDatabaseUrl(databaseUrl), { max: 1, prepare: false });
    try {
      await sql.unsafe(
        'DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
      );
      await sql.unsafe(await readFile(fixturePath, 'utf8'));

      const [before] = await sql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'landing_domains'::regclass AND contype = 'f'
      `;

      const baseline = await readFile(baselinePath, 'utf8');
      await sql.begin((tx) => tx.unsafe(baseline));
      await sql.begin((tx) => tx.unsafe(baseline));
      const rls = await readFile(rlsPath, 'utf8');
      await sql.begin((tx) => tx.unsafe(rls));

      const [legacy] = await sql<{ content_mode: string; title: string; html_body: string }[]>`
        SELECT content_mode, title, html_body FROM landing_pages
        WHERE id = '11111111-1111-4111-8111-111111111111'
      `;
      expect(legacy).toEqual({
        content_mode: 'legacy',
        title: 'Legacy VSL page',
        html_body: '<main>legacy</main>',
      });

      const [after] = await sql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'landing_domains'::regclass AND contype = 'f'
      `;
      expect(after?.definition).toBe(before?.definition);
      expect(after?.definition).toContain('ON DELETE CASCADE');

      const [rlsCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity
      `;
      expect(rlsCount?.count).toBe(VSL_TABLE_COUNT);

      await sql.unsafe(`
        INSERT INTO landing_page_families (id, title, source_locale)
        VALUES ('33333333-3333-4333-8333-333333333333', 'Hosted family', 'en');
        INSERT INTO landing_pages (store_id, slug, title, currency, fulfillment_type, html_body, price, content_mode, family_id, locale)
        VALUES ('l0i', 'hosted-vsl-page', 'Hosted VSL page', 'USD', 'info_product', '', 0, 'hosted', '33333333-3333-4333-8333-333333333333', 'en');
      `);
      const [hosted] = await sql<{ id: string }[]>`
        SELECT id FROM landing_pages WHERE slug = 'hosted-vsl-page'
      `;
      expect(hosted?.id).toBeTruthy();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('VSL 0088 G3 backend migration (static)', () => {
  const deltaPath = resolve(here, '../../migrations/0088_vsl_g3_backend.sql');
  const rollbackPath = resolve(here, '../../migrations/0088_vsl_g3_backend.rollback.sql');

  it('is idempotent, transaction-neutral and never touches LandingLab tables', async () => {
    const sqlText = executable(await readFile(deltaPath, 'utf8'));
    expect(sqlText).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sqlText).not.toMatch(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/CREATE\s+FUNCTION/i);
    expect(sqlText).not.toMatch(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TRIGGER|FUNCTION|INDEX)/i);
    expect(sqlText).not.toMatch(/landing_(domains|pages)\b/i);
    const triggers = sqlText.match(/CREATE\s+TRIGGER/gi) ?? [];
    expect(triggers).toHaveLength(2);
    expect(sqlText.match(/FROM\s+pg_trigger/gi)).toHaveLength(2);
  });

  it('enables RLS on every table it creates and makes releases immutable', async () => {
    const sqlText = executable(await readFile(deltaPath, 'utf8'));
    const created = [...sqlText.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    const rls = [...sqlText.matchAll(/ALTER\s+TABLE\s+public\.(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => m[1]);
    expect(rls.sort()).toEqual(created.sort());
    expect(sqlText).toMatch(/BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+vsl_project_releases/i);
    expect(sqlText).toMatch(/BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+vsl_step_releases/i);
    expect(sqlText).toMatch(/rolbypassrls/);
  });

  it('has an idempotent rollback that undoes every object', async () => {
    const rollback = executable(await readFile(rollbackPath, 'utf8'));
    for (const object of ['vsl_page_import_jobs', 'vsl_block_release_mutation', 'vsl_project_releases_immutable', 'vsl_step_releases_immutable',
      'vsl_events_project_received_idx', 'vsl_watch_sessions_project_updated_idx', 'sample_sha256', 'reconcile_attempts', 'last_check'])
      expect(rollback).toContain(object);
    expect(rollback).not.toMatch(/DROP\s+(TABLE|INDEX|TRIGGER|FUNCTION)\s+(?!IF\s+EXISTS)/i);
  });
});

describe('VSL 0089 F1b editing migration (static)', () => {
  const deltaPath = resolve(here, '../../migrations/0089_vsl_f1b_editing.sql');
  const rollbackPath = resolve(here, '../../migrations/0089_vsl_f1b_editing.rollback.sql');

  it('is idempotent, transaction-neutral, guarded and never touches LandingLab tables', async () => {
    const sqlText = executable(await readFile(deltaPath, 'utf8'));
    expect(sqlText).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sqlText).not.toMatch(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TRIGGER|FUNCTION|INDEX)/i);
    expect(sqlText).not.toMatch(/landing_(domains|pages)\b/i);
    expect(sqlText).toMatch(/rolbypassrls/);
    const constraints = sqlText.match(/ADD\s+CONSTRAINT/gi) ?? [];
    expect(sqlText.match(/FROM\s+pg_constraint/gi)).toHaveLength(constraints.length);
  });

  it('enables RLS on every table it creates', async () => {
    const sqlText = executable(await readFile(deltaPath, 'utf8'));
    const created = [...sqlText.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    const rls = [...sqlText.matchAll(/ALTER\s+TABLE\s+public\.(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => m[1]);
    expect(created.sort()).toEqual(['vsl_page_translation_units', 'vsl_page_translations']);
    expect(rls.sort()).toEqual(created.sort());
  });

  it('has an idempotent rollback that undoes every object', async () => {
    const rollback = executable(await readFile(rollbackPath, 'utf8'));
    for (const object of ['vsl_page_translation_units', 'vsl_page_translations', 'vsl_page_import_jobs_operation_check', 'vsl_page_import_jobs_source_check',
      'vsl_page_import_jobs_derived_check', 'base_revision_id', 'payload', 'operation', 'storage_deleted_at', 'vsl_pages_locale_check', 'locale'])
      expect(rollback).toContain(object);
    expect(rollback).not.toMatch(/DROP\s+(TABLE|INDEX|TRIGGER|FUNCTION|COLUMN|CONSTRAINT)\s+(?!IF\s+EXISTS)/i);
  });
});

describe('VSL 0090 Meta CAPI deliveries migration (static, VSL-13)', () => {
  const deltaPath = resolve(here, '../../migrations/0090_vsl_meta_capi.sql');
  const rollbackPath = resolve(here, '../../migrations/0090_vsl_meta_capi.rollback.sql');

  it('is idempotent, transaction-neutral, guarded and never touches LandingLab tables', async () => {
    const sqlText = executable(await readFile(deltaPath, 'utf8'));
    expect(sqlText).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sqlText).not.toMatch(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i);
    expect(sqlText).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TRIGGER|FUNCTION|INDEX)/i);
    expect(sqlText).not.toMatch(/landing_(domains|pages)\b/i);
    expect(sqlText).toMatch(/rolbypassrls/);
    expect(sqlText).toMatch(/UNIQUE\s*\(event_id,\s*pixel_id\)/i);
  });

  it('enables RLS on the table it creates and stores no token/PII column', async () => {
    const sqlText = executable(await readFile(deltaPath, 'utf8'));
    const created = [...sqlText.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    const rls = [...sqlText.matchAll(/ALTER\s+TABLE\s+public\.(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => m[1]);
    expect(created).toEqual(['vsl_meta_capi_deliveries']);
    expect(rls).toEqual(created);
    expect(sqlText).not.toMatch(/\b(token|access_token|ip|ip_address|user_agent|fbp|fbc|fbclid|url|event_source_url)\s+(text|inet|varchar)/i);
  });

  it('has an idempotent rollback that undoes every object', async () => {
    const rollback = executable(await readFile(rollbackPath, 'utf8'));
    for (const object of ['vsl_meta_capi_deliveries', 'vsl_meta_capi_deliveries_created_idx', 'vsl_meta_capi_deliveries_project_time_idx'])
      expect(rollback).toContain(object);
    expect(rollback).not.toMatch(/DROP\s+(TABLE|INDEX|TRIGGER|FUNCTION|COLUMN|CONSTRAINT)\s+(?!IF\s+EXISTS)/i);
  });
});
