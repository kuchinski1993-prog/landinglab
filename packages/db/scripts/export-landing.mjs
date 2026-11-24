// Exporta uma landing (linha de `landing_pages` + ofertas de `landing_bundle_offers`) para JSON,
// para virar seed em outra instalação. Só lê. Uso:
//   DATABASE_URL=... node packages/db/scripts/export-landing.mjs <landing_id> <arquivo.json>
import { writeFileSync } from 'node:fs';

import postgres from 'postgres';

const [id, out] = process.argv.slice(2);
if (!id || !out) {
  console.error('uso: export-landing.mjs <landing_id> <arquivo.json>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definido');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
try {
  const [page] = await sql`select row_to_json(lp) as row from landing_pages lp where id = ${id}`;
  if (!page) throw new Error(`landing ${id} não encontrada`);
  const offers = await sql`select row_to_json(o) as row from landing_bundle_offers o where landing_page_id = ${id}`;
  const data = { exported_at: new Date().toISOString(), landing_page: page.row, bundle_offers: offers.map((o) => o.row) };
  writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(`ok: ${out} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB, ${offers.length} ofertas)`);
} finally {
  await sql.end();
}
