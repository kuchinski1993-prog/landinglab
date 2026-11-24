// Importa uma landing exportada por `export-landing.mjs` no banco desta instalação. Idempotente: se a
// landing (mesmo id) já existe, não faz nada. Entra como rascunho, sem domínio nem deploy — publique
// pelo editor depois de configurar um domínio. Uso:
//   DATABASE_URL=... node packages/db/scripts/seed-landing.mjs <arquivo.json>
// Loja: SEED_STORE_ID, senão a primeira loja do banco, senão cria a loja "LandingLab".
import { readFileSync } from 'node:fs';

import postgres from 'postgres';

const file = process.argv[2];
if (!file) {
  console.error('uso: seed-landing.mjs <arquivo.json>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definido');
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, 'utf8'));
const page = data.landing_page;

// Vínculos que só existem no banco de origem.
const RESET = {
  status: 'draft',
  published_at: null,
  current_deployment_id: null,
  published_version_id: null,
  pir_document_id: null,
  parent_landing_page_id: null,
  parent_sales_page_id: null,
  family_id: null,
  market_id: null,
  shopify_product_gid: null,
  preview_token: null,
};

const sql = postgres(url, { max: 1, prepare: false });
try {
  const [exists] = await sql`select 1 from landing_pages where id = ${page.id}`;
  if (exists) {
    console.log(`já existe: ${page.title} (${page.id}) — nada a fazer`);
    process.exit(0);
  }

  let storeId = process.env.SEED_STORE_ID;
  if (!storeId) {
    const [store] = await sql`select id::text from stores order by created_at limit 1`;
    storeId = store?.id ?? (await sql`insert into stores (name) values ('LandingLab') returning id::text`)[0].id;
  }

  await sql.begin(async (tx) => {
    const row = { ...page, ...RESET, store_id: storeId };
    // json_populate_record ignora colunas que não existem no destino e usa NULL nas ausentes.
    await tx`insert into landing_pages select * from json_populate_record(null::landing_pages, ${tx.json(row)})`;
    for (const offer of data.bundle_offers ?? []) {
      await tx`insert into landing_bundle_offers select * from json_populate_record(null::landing_bundle_offers, ${tx.json(offer)})`;
    }
  });
  console.log(`ok: ${page.title} (${page.id}) na loja ${storeId}, ${data.bundle_offers?.length ?? 0} ofertas`);
} finally {
  await sql.end();
}
