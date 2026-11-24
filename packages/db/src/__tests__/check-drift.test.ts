// Smoke test do db:check: garante que o script identifica corretamente
// o estado atual (sem drift) e reporta erro quando o schema declara uma
// coluna que nenhuma migration cria.
//
// Sem esse teste, o próprio guardião podia quebrar silenciosamente (regex
// muda, dependência falha, etc.) e voltaríamos ao cenário original —
// GET /products 500 em produção porque schema.ts foi editado sem migration.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, '..', 'schema.ts');
const SCRIPT_PATH = resolve(HERE, '..', 'check-drift.ts');
const JOURNAL_PATH = resolve(HERE, '..', '..', 'migrations', 'meta', '_journal.json');
const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'migrations');

function runCheck(migrationsDir?: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', SCRIPT_PATH], {
      cwd: resolve(HERE, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: migrationsDir ? { ...process.env, CHECK_DRIFT_MIGRATIONS_DIR: migrationsDir } : process.env,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.status ?? 1,
    };
  }
}

describe('check-drift script', () => {
  const originalSchema = readFileSync(SCHEMA_PATH, 'utf8');

  afterEach(() => {
    writeFileSync(SCHEMA_PATH, originalSchema, 'utf8');
  });

  it('reports 0 drift on the current committed schema', () => {
    const { stdout, code } = runCheck();
    expect(code).toBe(0);
    expect(stdout).toContain('Sem drift');
  });

  it('detects a new column added to schema.ts that has no migration', () => {
    // Injeta uma coluna fake em `products` (que existe como pgTable) e
    // confirma que o script sai com code=1 e reporta a coluna.
    const injected = originalSchema.replace(
      "id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),\n    storeId:",
      "id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),\n    ghostColumnDoNotCommit: text('ghost_column_do_not_commit'),\n    storeId:",
    );
    expect(injected).not.toBe(originalSchema); // Sanity: replace worked.
    writeFileSync(SCHEMA_PATH, injected, 'utf8');

    const { stderr, code } = runCheck();
    expect(code).toBe(1);
    expect(stderr).toContain('ghost_column_do_not_commit');
  });
});

// Guard adicionado 2026-07-10: pega migration órfã do _journal.json.
// Bug pai: 0040_color_schemes.sql existia mas não estava no journal;
// drizzle migrate() ignorava; nada em nenhum ambiente aplicava.
describe('check-drift · journal orphan detection', () => {
  const originalJournal = readFileSync(JOURNAL_PATH, 'utf8');
  const orphanFile = resolve(MIGRATIONS_DIR, '9999_orphan_test.sql');

  afterEach(() => {
    writeFileSync(JOURNAL_PATH, originalJournal, 'utf8');
    try { unlinkSync(orphanFile); } catch { /* ok se já não existe */ }
  });

  it('detects a .sql file with no entry in _journal.json', () => {
    // Cria arquivo .sql que não está no journal.
    writeFileSync(orphanFile, '-- orphan test\nSELECT 1;\n', 'utf8');

    const { stderr, code } = runCheck();
    expect(code).toBe(1);
    expect(stderr).toContain('9999_orphan_test');
    expect(stderr).toMatch(/sem entrada no _journal\.json|IGNORAR/);
  });

  it('detects a journal entry with no matching .sql file', () => {
    // Adiciona entrada fantasma no journal apontando para um arquivo
    // inexistente.
    const journal = JSON.parse(originalJournal) as {
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    journal.entries.push({
      idx: 9998,
      version: '7',
      when: 9999999999999,
      tag: '9998_ghost_entry',
      breakpoints: true,
    });
    writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2), 'utf8');

    const { stderr, code } = runCheck();
    expect(code).toBe(1);
    expect(stderr).toContain('9998_ghost_entry');
    expect(stderr).toMatch(/sem arquivo|FALHAR/);
  });
});

// Story 0.12 · `*.rollback.sql` não conta; migration fora do journal precisa estar na lista congelada
// `meta/applied-outside-journal.json` (append-only). Casos novos rodam numa CÓPIA da pasta (tmpdir).
const APPLIED_OUTSIDE_PATH = resolve(MIGRATIONS_DIR, 'meta', 'applied-outside-journal.json');

/** As 41 migrations fora do journal no baseline de 2026-11-05 — a lista nunca perde nenhuma. */
const FROZEN_OUTSIDE_TAGS = [
  '0061_tracker_campaigns_target_countries', '0062_tracker_access_rules_datacenter_blacklist',
  '0068_landing_generation_runs_translate_squad', '0069_landing_bundle_offers', '0070_backfill_bundle_offers_from_variants',
  '0071_landing_html_snapshots', '0072_landing_html_snapshots_data_fingerprint', '0073_landing_html_snapshots_clone_initial_unique',
  '0076_enable_rls_landing_tables', '0077_landing_shopify_product_gid', '0078_subs_presentation_mode', '0079_stripe_accounts',
  '0080_landing_markets', '0081_stripe_checkout', '0082_landing_post_sale', '0083_landing_support', '0084_landing_subscriptions',
  '0085_checkout_logo', '0086_vsl_baseline', '0087_vsl_rls', '0088_vsl_g3_backend', '0089_vsl_f1b_editing', '0090_vsl_meta_capi',
  '0091_inbox_email_flags', '0092_rls_deny_all_public', '0093_all_orders_view_lockdown', '0094_webhook_delivery_attempts',
  '0095_fx_guard', '0096_store_modules', '0097_job_runs', '0098_products_source_url_por_loja',
  '0099_inbound_emails_message_id_por_loja', '0100_store_support_addresses', '0101_auth_users_tokens_audit',
  '0102_auth_seed_owner', '0103_auth_sessions', '0104_assistant_tables', '0105_ai_usage_log_cache_tokens',
  '0106_store_soulrya', '0107_fulfillment_policy', '0108_custom_fields',
] as const;

interface OutsideFile {
  $comment?: string;
  entries: Array<{ tag: string; appliedBy: string; note: string }>;
}

describe('0.12 · check-drift com lista congelada (cópia em tmpdir)', () => {
  let dir: string;
  const metaPath = (name: string) => join(dir, 'meta', name);
  const readJson = <T,>(name: string): T => JSON.parse(readFileSync(metaPath(name), 'utf8')) as T;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-drift-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a cópia de main passa (exit 0)', () => {
    const { stdout, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(stdout).toContain('Sem drift');
  });

  it('(b) `.rollback.sql` fora do journal e da lista NÃO é acusado', () => {
    writeFileSync(join(dir, '9997_sintetica.rollback.sql'), '-- rollback\nSELECT 1;\n', 'utf8');
    const { stdout, code } = runCheck(dir);
    expect(code).toBe(0);
    expect(stdout).toContain('Sem drift');
  });

  it('(a) migration nova fora do journal e fora da lista → falha e nomeia o arquivo', () => {
    writeFileSync(join(dir, '9997_sintetica.sql'), '-- nova\nSELECT 1;\n', 'utf8');
    writeFileSync(join(dir, '9997_sintetica.rollback.sql'), '-- rollback\nSELECT 1;\n', 'utf8');
    const { stderr, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('9997_sintetica.sql');
    expect(stderr).not.toContain('9997_sintetica.rollback');
  });

  it('migration nova registrada na lista no mesmo PR → passa', () => {
    writeFileSync(join(dir, '9997_sintetica.sql'), '-- nova\nSELECT 1;\n', 'utf8');
    const list = readJson<OutsideFile>('applied-outside-journal.json');
    list.entries.push({ tag: '9997_sintetica', appliedBy: 'manual', note: 'teste' });
    writeFileSync(metaPath('applied-outside-journal.json'), JSON.stringify(list), 'utf8');
    expect(runCheck(dir).code).toBe(0);
  });

  it('(c) tag duplicada (no journal E na lista) → falha', () => {
    const journal = readJson<{ entries: Array<{ tag: string }> }>('_journal.json');
    const list = readJson<OutsideFile>('applied-outside-journal.json');
    list.entries.push({ tag: journal.entries[0]!.tag, appliedBy: 'manual', note: 'duplicata' });
    writeFileSync(metaPath('applied-outside-journal.json'), JSON.stringify(list), 'utf8');
    const { stderr, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('Tag duplicada');
    expect(stderr).toContain(journal.entries[0]!.tag);
  });

  it('entrada da lista sem arquivo .sql → falha', () => {
    const list = readJson<OutsideFile>('applied-outside-journal.json');
    list.entries.push({ tag: '9996_fantasma', appliedBy: 'manual', note: 'sem arquivo' });
    writeFileSync(metaPath('applied-outside-journal.json'), JSON.stringify(list), 'utf8');
    const { stderr, code } = runCheck(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('9996_fantasma');
  });
});

describe('0.12 · (d) lista congelada append-only', () => {
  const list = JSON.parse(readFileSync(APPLIED_OUTSIDE_PATH, 'utf8')) as OutsideFile;
  const tags = list.entries.map((e) => e.tag);

  it('contém as 41 migrations do baseline, na ordem, sem repetição', () => {
    expect(tags.slice(0, FROZEN_OUTSIDE_TAGS.length)).toEqual([...FROZEN_OUTSIDE_TAGS]);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('toda entrada tem tag, appliedBy e note preenchidos', () => {
    for (const e of list.entries) {
      expect(e.tag).toMatch(/^\d{4}_[a-z0-9_]+$/);
      expect(e.appliedBy.length).toBeGreaterThan(0);
      expect(e.note.length).toBeGreaterThan(0);
    }
  });
});
