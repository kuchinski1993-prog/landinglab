// Landing Domains routes — sugestão e compra de domínio via Spaceship.
//
// Endpoints:
//   - POST /landing-domains/suggest — retorna 3-6 candidatos de domínio
//     baseados no nome do produto/landing. Cada candidato inclui
//     disponibilidade real (via Spaceship checkAvailability).
//   - POST /landing-domains/purchase — compra o domínio escolhido +
//     configura DNS + adiciona no Vercel + persiste em landing_domains.
//
// Auth: privado (usa fastify.authenticate).

import { landingDomains, landingPages } from '@blackshop/db';
import { createSpaceshipClient } from '@blackshop/landinglab-deploy';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import '../types.js';

const STORE_ID = 'l0i';

// ─── /suggest ────────────────────────────────────────────────────────────

interface SuggestBody {
  landingId?: string;
  productName?: string;
  limit?: number;
  tlds?: string[];
}

interface SuggestionOutput {
  domain: string;
  tld: string;
  estimatedPriceUsd: number;
  reason: string;
  available: boolean | null;
  /** Preço real retornado pela Spaceship (ou null se não conseguiu consultar). */
  actualPriceUsd: number | null;
}

const landingDomainsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: SuggestBody }>(
    '/landing-domains/suggest',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            landingId: { type: 'string' },
            productName: { type: 'string', minLength: 1, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
            tlds: {
              type: 'array',
              items: { type: 'string', pattern: '^\\.[a-z]{2,10}$' },
              maxItems: 5,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { landingId, productName: bodyProductName, limit, tlds } = request.body;

      // Resolve nome do produto: se veio landingId, busca no DB; senão usa productName direto.
      let productName = bodyProductName?.trim();
      if (!productName && landingId) {
        const rows = await fastify.db
          .select({ title: landingPages.title })
          .from(landingPages)
          .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
          .limit(1);
        if (rows[0]) productName = rows[0].title;
      }
      if (!productName) {
        return reply.code(400).send({
          error: 'É necessário informar landingId (com título válido) ou productName.',
          statusCode: 400,
        });
      }

      // Import subpath dedicado pra evitar arrastar deps DOM (renderer.ts) do
      // barrel — a exports do package expõe './domain-suggester' isolado.
      const mod = (await import('@blackshop/landinglab-cloner/domain-suggester')) as {
        suggestDomains: (
          name: string,
          opts?: { limit?: number; tlds?: string[] },
        ) => Array<{ domain: string; tld: string; estimatedPriceUsd: number; reason: string }>;
      };

      const opts: { limit?: number; tlds?: string[] } = {};
      if (limit !== undefined) opts.limit = limit;
      if (tlds !== undefined) opts.tlds = tlds;
      const candidates = mod.suggestDomains(productName, opts);

      if (candidates.length === 0) {
        return reply.code(200).send({ suggestions: [] });
      }

      // Consulta disponibilidade real em paralelo via Spaceship.
      // Se Spaceship não configurado (LANDINGLAB_SPACESHIP_API_KEY missing),
      // retorna available=null pra cada — UI mostra "verificação indisponível".
      let spaceship: ReturnType<typeof createSpaceshipClient> | null = null;
      try {
        spaceship = createSpaceshipClient();
      } catch (err) {
        fastify.log.warn(
          { err },
          'landing-domains/suggest — Spaceship não configurado, availability=null',
        );
      }

      const results: SuggestionOutput[] = await Promise.all(
        candidates.map(async (c) => {
          if (!spaceship) {
            return {
              ...c,
              available: null,
              actualPriceUsd: null,
            };
          }
          try {
            const check = await spaceship.checkAvailability(c.domain);
            return {
              ...c,
              available: check.available,
              actualPriceUsd: check.price ?? null,
            };
          } catch (err) {
            fastify.log.warn(
              { err, domain: c.domain },
              'landing-domains/suggest — checkAvailability falhou pra este domínio',
            );
            return {
              ...c,
              available: null,
              actualPriceUsd: null,
            };
          }
        }),
      );

      return reply.code(200).send({ suggestions: results });
    },
  );

  // ─── /purchase ─────────────────────────────────────────────────────────

  interface PurchaseBody {
    landingId: string;
    domain: string;
    years?: number;
    /** Se true, também adiciona domain no Vercel e configura DNS. Default true. */
    autoDeploy?: boolean;
  }

  fastify.post<{ Body: PurchaseBody }>(
    '/landing-domains/purchase',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['landingId', 'domain'],
          properties: {
            landingId: { type: 'string', minLength: 1 },
            domain: {
              type: 'string',
              minLength: 4,
              maxLength: 255,
              pattern: '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\\.[a-z]{2,10}$',
            },
            years: { type: 'integer', minimum: 1, maximum: 10 },
            autoDeploy: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { landingId, domain, years = 1, autoDeploy = true } = request.body;

      // Valida landing existe.
      const lpRows = await fastify.db
        .select({ id: landingPages.id, title: landingPages.title })
        .from(landingPages)
        .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, STORE_ID)))
        .limit(1);
      if (lpRows.length === 0) {
        return reply.code(404).send({
          error: 'Landing não encontrada.',
          statusCode: 404,
        });
      }

      // Cliente Spaceship é obrigatório aqui (compra real).
      let spaceship: ReturnType<typeof createSpaceshipClient>;
      try {
        spaceship = createSpaceshipClient();
      } catch (err) {
        fastify.log.error(
          { err, domain },
          'landing-domains/purchase — Spaceship API key ausente',
        );
        return reply.code(503).send({
          error: 'Registrar não configurado. Adicione LANDINGLAB_SPACESHIP_API_KEY.',
          statusCode: 503,
        });
      }

      // Race protection: reconfirma disponibilidade antes de comprar.
      try {
        const check = await spaceship.checkAvailability(domain);
        if (!check.available) {
          return reply.code(409).send({
            error: `Domínio ${domain} não está mais disponível.`,
            statusCode: 409,
          });
        }
      } catch (err) {
        fastify.log.error(
          { err, domain },
          'landing-domains/purchase — checkAvailability falhou',
        );
        return reply.code(502).send({
          error: 'Não foi possível verificar disponibilidade. Tente novamente.',
          statusCode: 502,
        });
      }

      // Compra o domínio (COBRA DO CARTÃO).
      let registrarDomainId: string;
      // Spaceship API atual retorna só orderId — expiresAt e priceUsd não vêm
      // no register. Assumimos expiresAt = agora + years (adapter futuro pode
      // enriquecer via GET /domains/{orderId} pra pegar dados reais).
      const expiresAt: Date = new Date(
        Date.now() + years * 365 * 24 * 60 * 60 * 1000,
      );
      try {
        const registered = await spaceship.register(domain, { years });
        registrarDomainId = registered.orderId;
        fastify.log.info(
          { landingId, domain, years, orderId: registrarDomainId, expiresAt },
          'landing-domains/purchase — domínio registrado com sucesso',
        );
      } catch (err) {
        fastify.log.error(
          { err, landingId, domain, years },
          'landing-domains/purchase — Spaceship register falhou',
        );
        return reply.code(502).send({
          error: `Falha ao registrar domínio: ${err instanceof Error ? err.message : String(err)}`,
          statusCode: 502,
        });
      }

      // Configura DNS apontando pro Vercel (CNAME padrão).
      // Storefront landing usa cname.vercel-dns.com como target.
      const dnsRecords = [
        { type: 'CNAME' as const, name: '@', value: 'cname.vercel-dns.com', ttl: 3600 },
        { type: 'CNAME' as const, name: 'www', value: 'cname.vercel-dns.com', ttl: 3600 },
      ];
      let dnsConfigured = false;
      if (autoDeploy) {
        try {
          await spaceship.configureDNS(domain, dnsRecords);
          dnsConfigured = true;
        } catch (err) {
          fastify.log.warn(
            { err, domain },
            'landing-domains/purchase — configureDNS falhou (domínio comprado mas DNS pendente)',
          );
          // Não fatal — operator pode configurar manualmente depois.
        }
      }

      // Persiste em landing_domains.
      const inserted = await fastify.db
        .insert(landingDomains)
        .values({
          landingPageId: landingId,
          domain,
          role: 'active',
          registrar: 'spaceship',
          registrarDomainId,
          dnsRecords: dnsConfigured ? { records: dnsRecords, configuredAt: new Date().toISOString() } : {},
          expiresAt,
        })
        .returning({ id: landingDomains.id });

      return reply.code(201).send({
        ok: true,
        domainRowId: inserted[0]?.id,
        domain,
        registrarDomainId,
        expiresAt: expiresAt.toISOString(),
        dnsConfigured,
        message: dnsConfigured
          ? 'Domínio comprado e DNS configurado. Aguarde propagação (~5-30min).'
          : 'Domínio comprado mas DNS falhou — configure manualmente ou retente.',
      });
    },
  );
};

export default landingDomainsRoutes;
