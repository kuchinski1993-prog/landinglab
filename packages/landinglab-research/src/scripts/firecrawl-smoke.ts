// Firecrawl bug B smoke — vive dentro do package pra resolver zod nativamente.
//
// Run:
//   pnpm --filter @blackshop/landinglab-research exec dotenv --no-expand \
//     -e ../../apps/worker/.env -- tsx src/scripts/firecrawl-smoke.ts

import { z } from 'zod';

import { createFirecrawlClient } from '../providers/firecrawl.js';

const URL =
  'https://parijanofficial.com/en-en/products/texture-jacquard-cuban-shirt-wrinkle-textured-straight-leg-pants';

const schema = z.object({
  name: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
});

async function main(): Promise<void> {
  const client = createFirecrawlClient();

  console.log('\n=== Bug B: single extract (waitFor removido do body) ===');
  const t0 = Date.now();
  try {
    const result = await client.extract({
      urls: URL,
      schema,
      prompt: 'Extract the product name, price, currency, and short description.',
    });
    const dt = Date.now() - t0;
    console.log(`elapsed=${dt}ms`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`\n✅ Bug D OK — data extracted, cost=$${result.cost_usd}, latency=${result.latency_ms}ms`);
    process.exit(0);
  } catch (err) {
    console.error('\n❌ extract falhou:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
