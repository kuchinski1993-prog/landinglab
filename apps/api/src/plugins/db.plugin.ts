// Database plugin — wires Drizzle/postgres-js client into Fastify and verifies
// connectivity at boot with a `SELECT 1`. Fails fast if Postgres is unreachable.
import { createClient } from '@blackshop/db';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const { db, sql: pg } = createClient({ databaseUrl: fastify.config.databaseUrl });

  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    fastify.log.error({ err: error }, 'Failed to connect to Postgres on startup');
    throw error;
  }

  fastify.decorate('db', db);
  // Pool ÚNICO das rotas VSL (antes: 7 plugins com pool próprio, até 28 conexões).
  // Não reaproveita o cliente do Drizzle: drizzle(postgres-js) troca os serializers de
  // json/timestamps do cliente, o que quebra sql.json()/Date nos serviços VSL de SQL cru.
  // postgres-js só conecta no primeiro uso.
  const vslPg = postgres(fastify.config.databaseUrl, {
    max: Number.parseInt(process.env['VSL_DB_POOL_MAX'] ?? '4', 10) || 4,
    prepare: false,
  });
  fastify.decorate('pg', vslPg);
  fastify.addHook('onClose', async () => {
    await Promise.all([pg.end({ timeout: 5 }), vslPg.end({ timeout: 5 })]);
  });
};

export default fp(dbPlugin, { name: 'db-plugin' });
