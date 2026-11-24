/* eslint-disable no-console -- CLI de relatório: a saída no terminal é o produto. */
// Story 0.6 (QA F4) — impacto do checklist de publicação nas landings que já
// estão no ar. SOMENTE LEITURA: a sessão do Postgres abre com
// default_transaction_read_only=on (qualquer escrita falharia).
//
// Uso (na raiz do repo, com DATABASE_URL de produção ou réplica):
//   pnpm --filter @blackshop/backoffice exec tsx scripts/publish-check-impact.ts
//   ... --json                  saída JSON (para planilha/automação)
//   ... --include-drafts        inclui rascunhos atualizados nos últimos 30 dias
//
// Lista, para cada landing, se a próxima (re)publicação seria BLOQUEADA
// (itens `blocking`) e os avisos. Não chama Vercel, Shopify nem Stripe.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { blockingFailures, evaluatePublishCheck } from '../src/lib/landing-publish-check';
import { createDrizzlePublishStore } from '../src/lib/publish-store';

interface Row {
  id: string;
  title: string;
  status: string;
  checkout_provider: string;
  landing_kind: string;
  hostname: string | null;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL é obrigatório (use a réplica/produção em modo leitura).');
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const includeDrafts = process.argv.includes('--include-drafts');

  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connection: { default_transaction_read_only: 'on', application_name: 'publish-check-impact' },
  });
  try {
    const db = drizzle(sql) as unknown as Parameters<typeof createDrizzlePublishStore>[0];
    const store = createDrizzlePublishStore(db);

    const rows = await sql<Row[]>`
      SELECT lp.id, lp.title, lp.status, lp.checkout_provider, lp.landing_kind, d.hostname
      FROM landing_pages lp
      LEFT JOIN landing_deployments d ON d.id = lp.current_deployment_id
      WHERE lp.store_id = 'l0i'
        AND (lp.status = 'published'
             OR (${includeDrafts} AND lp.status = 'draft' AND lp.updated_at > now() - interval '30 days'))
      ORDER BY lp.status, lp.title`;

    const report = [];
    for (const row of rows) {
      const snapshot = await store.loadCheckSnapshot(row.id);
      if (!snapshot) continue;
      const result = evaluatePublishCheck(snapshot);
      const blocking = blockingFailures(result.items);
      const warnings = result.items.filter((i) => !i.ok && i.severity === 'warning');
      report.push({
        landingId: row.id,
        title: row.title,
        status: row.status,
        provider: row.checkout_provider,
        kind: row.landing_kind,
        hostname: row.hostname,
        wouldBlock: blocking.length > 0,
        blocking: blocking.map((i) => ({ code: i.code, message: i.message, fixHint: i.fixHint })),
        warnings: warnings.map((i) => ({ code: i.code, message: i.message })),
      });
    }

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const blocked = report.filter((r) => r.wouldBlock);
    console.log(`Landings avaliadas: ${report.length} · seriam BLOQUEADAS: ${blocked.length} · com avisos: ${report.filter((r) => r.warnings.length).length}\n`);
    for (const r of blocked) {
      console.log(`✗ ${r.title} [${r.status}/${r.provider}/${r.kind}] ${r.hostname ?? '(sem host)'} — ${r.landingId}`);
      for (const b of r.blocking) console.log(`    · ${b.code}: ${b.message}`);
    }
    const warnedOnly = report.filter((r) => !r.wouldBlock && r.warnings.length);
    if (warnedOnly.length) {
      console.log('\nSó avisos (publicam normalmente):');
      for (const r of warnedOnly) console.log(`  ! ${r.title} — ${r.warnings.map((w) => w.code).join(', ')}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('Falha no relatório:', err instanceof Error ? err.message : err);
  process.exit(1);
});
