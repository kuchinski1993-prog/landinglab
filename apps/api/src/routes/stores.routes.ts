// Stores CRUD — Story 8.1. Multi-store enablement.
// id is a text PK (slug or random). The 'default' store is seeded by migration 0005.
import { randomUUID } from 'node:crypto';

import { stores } from '@blackshop/db';
import { COMMON_CATALOG } from '@blackshop/errors';
import { sendError } from '@blackshop/errors/fastify';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import { buildRegionPatch } from '../lib/store-region.js';

import '../types.js';

interface CreateStoreBody {
  id?: string;
  name?: string;
  domain?: string | null;
  shopifyDomain?: string | null;
  isActive?: boolean;
  // Story 17.4a · região da loja já no cadastro (gravada em `settings`).
  currency?: string | null;
  locale?: string | null;
  timezone?: string | null;
}

interface PatchStoreBody {
  name?: string;
  domain?: string | null;
  shopifyDomain?: string | null;
  isActive?: boolean;
}

interface StoreParams {
  id: string;
}

interface StoreRow {
  id: string;
  name: string;
  domain: string | null;
  shopifyDomain: string | null;
  isActive: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const storesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /stores — list all stores (auth required).
  fastify.get('/', { preHandler: fastify.authenticate }, async (_request, reply) => {
    try {
      const rows = (await fastify.db.select().from(stores)) as StoreRow[];
      return reply.code(200).send({ items: rows });
    } catch (err) {
      fastify.log.error({ err }, 'Failed to list stores');
      return reply.code(500).send({ error: 'Failed to list stores', statusCode: 500 });
    }
  });

  // GET /stores/:id — single store details.
  fastify.get<{ Params: StoreParams }>(
    '/:id',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const rows = (await fastify.db
          .select()
          .from(stores)
          .where(eq(stores.id, id))
          .limit(1)) as StoreRow[];

        const row = rows[0];
        if (!row) {
          return reply.code(404).send({ error: 'Store not found', statusCode: 404 });
        }
        return reply.code(200).send(row);
      } catch (err) {
        fastify.log.error({ err, storeId: id }, 'Failed to load store');
        return reply.code(500).send({ error: 'Failed to load store', statusCode: 500 });
      }
    },
  );

  // POST /stores — create a new store. id is derived from the name if not provided.
  fastify.post<{ Body: CreateStoreBody }>(
    '/',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            domain: { type: ['string', 'null'] },
            shopifyDomain: { type: ['string', 'null'] },
            isActive: { type: 'boolean' },
            currency: { type: ['string', 'null'] },
            locale: { type: ['string', 'null'] },
            timezone: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const name = (body.name ?? '').trim();
      if (name.length === 0) {
        return reply.code(400).send({ error: 'name is required', statusCode: 400 });
      }

      // Story 17.4a · região validada ANTES do insert: inválida = 400 e nenhuma loja criada.
      const region = buildRegionPatch(body as Record<string, unknown>);
      if (!region.ok) {
        return sendError(reply, COMMON_CATALOG, 'validation_failed', { field: region.field, reason: region.reason });
      }
      const regionSettings = Object.fromEntries(Object.entries(region.patch).filter(([, v]) => v !== null));

      const baseId =
        typeof body.id === 'string' && body.id.trim().length > 0
          ? body.id.trim()
          : slugify(name) || `store-${randomUUID().slice(0, 8)}`;

      try {
        // Reject duplicates on PK.
        const existing = (await fastify.db
          .select()
          .from(stores)
          .where(eq(stores.id, baseId))
          .limit(1)) as StoreRow[];
        if (existing[0]) {
          return reply
            .code(409)
            .send({ error: `Store with id '${baseId}' already exists`, statusCode: 409 });
        }

        const inserted = (await fastify.db
          .insert(stores)
          .values({
            id: baseId,
            name,
            domain: body.domain ?? null,
            shopifyDomain: body.shopifyDomain ?? null,
            isActive: body.isActive ?? true,
            ...(Object.keys(regionSettings).length > 0 ? { settings: regionSettings } : {}),
          })
          .returning()) as StoreRow[];

        // Story 17.2a · esquece o "não existe" em cache: a loja nova vale na hora.
        fastify.storeResolver.invalidate(baseId);
        return reply.code(201).send(inserted[0]);
      } catch (err) {
        fastify.log.error({ err }, 'Failed to create store');
        return reply.code(500).send({ error: 'Failed to create store', statusCode: 500 });
      }
    },
  );

  // PATCH /stores/:id — update mutable fields.
  fastify.patch<{ Params: StoreParams; Body: PatchStoreBody }>(
    '/:id',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            domain: { type: ['string', 'null'] },
            shopifyDomain: { type: ['string', 'null'] },
            isActive: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};

      const updates: Record<string, unknown> = {};
      if (typeof body.name === 'string') updates['name'] = body.name.trim();
      if (Object.prototype.hasOwnProperty.call(body, 'domain')) {
        updates['domain'] = body.domain ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'shopifyDomain')) {
        updates['shopifyDomain'] = body.shopifyDomain ?? null;
      }
      if (typeof body.isActive === 'boolean') updates['isActive'] = body.isActive;

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'No editable fields provided', statusCode: 400 });
      }

      updates['updatedAt'] = new Date();

      try {
        const updated = (await fastify.db
          .update(stores)
          .set(updates)
          .where(eq(stores.id, id))
          .returning()) as StoreRow[];

        const row = updated[0];
        if (!row) {
          return reply.code(404).send({ error: 'Store not found', statusCode: 404 });
        }
        // Story 17.2a · desativar/reativar vale na hora neste processo (cache do X-Store-Id).
        fastify.storeResolver.invalidate(id);
        return reply.code(200).send(row);
      } catch (err) {
        fastify.log.error({ err, storeId: id }, 'Failed to update store');
        return reply.code(500).send({ error: 'Failed to update store', statusCode: 500 });
      }
    },
  );
};

export default storesRoutes;
