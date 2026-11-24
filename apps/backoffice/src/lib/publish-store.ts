// Story 0.6 — acesso ao banco da publicação de landings (fonte única).
//
// Duas transações CURTAS e nenhuma chamada de rede dentro delas (pool de 1
// conexão por instância — lib/landing-db.ts):
//   1. reserve()  — deployment em `provisioning` + binding (inativo) numa
//      transação; a trava contra corrida são os índices únicos
//      idx_landing_deployments_hostname e idx_landing_domain_bindings_domain_slug.
//   2. finalize() — deployment `published`/`provisioned` + landing_pages
//      `published`/current_deployment_id/published_at + binding ativo, numa
//      transação.
// Entre as duas, publish-core fala com a Vercel e sonda o HTTPS.

import {
  landingBundleOffers,
  landingDeployments,
  landingDomainBindings,
  landingDomains,
  landingMarkets,
  landingPages,
  landingVariants,
  productVariants,
  stripeAccounts,
} from '@blackshop/db';
import { readExternalCheckoutConfig } from '@blackshop/shared/external-checkout';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';

import { readOffersPlacement } from './landing-offers-placement';
import type { PublishCheckSnapshot } from './landing-publish-check';
import { getDb } from './landing-db';

/** Loja fixa do LandingLab (multi-tenant é a 17.x). */
export const PUBLISH_STORE_ID = 'l0i';

export interface PublishLandingRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  htmlBody: string;
  cloneMetadata: unknown;
  currentDeploymentId: string | null;
}

export interface PublishDomainRow {
  id: string;
  domain: string;
  role: string;
  dnsRecords: unknown;
}

export interface HostOccupant {
  landingId: string;
  landingTitle: string | null;
  hostname: string;
  source: 'binding' | 'deployment';
}

export interface PublishDeploymentRow {
  id: string;
  landingPageId: string;
  hostname: string;
  deploymentType: string;
  deploymentStatus: string;
  sslStatus: string;
  deploymentMetadata: Record<string, unknown> | null;
}

export interface ReserveInput {
  landingPageId: string;
  hostname: string;
  domainId: string;
  slug: string;
  deploymentType: 'subdomain' | 'custom_domain';
  dnsProvider: string;
  verificationUrl: string;
  metadata: Record<string, unknown>;
  now: Date;
}

export interface ReserveResult {
  deploymentId: string;
  /**
   * `true` quando o endereço já estava publicado com SSL comprovado: a reserva
   * NÃO rebaixa o status (só registra a tentativa em metadata).
   */
  wasPublished: boolean;
}

export interface MarkInput {
  deploymentStatus: 'provisioning' | 'awaiting_ssl' | 'publish_failed';
  sslStatus: 'pending' | 'failed';
  metadata: Record<string, unknown>;
  now: Date;
}

export interface FinalizeInput {
  deploymentId: string;
  landingPageId: string;
  domainId: string;
  slug: string;
  publishedUrl: string;
  metadata: Record<string, unknown>;
  now: Date;
}

/** Erro de "slug/hostname já é de outra landing" detectado dentro da reserva. */
export class SlugTakenError extends Error {
  constructor(public readonly hostname: string) {
    super(`hostname ${hostname} ocupado por outra landing`);
    this.name = 'SlugTakenError';
  }
}

/** Violação de índice único do Postgres (23505), direto ou embrulhada pelo drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface PublishStore {
  getLanding(id: string): Promise<PublishLandingRow | null>;
  getDomainById(id: string): Promise<PublishDomainRow | null>;
  getDomainByName(name: string): Promise<PublishDomainRow | null>;
  /** Quem (outra landing) ocupa o hostname ou o (domínio, slug). `null` = livre. */
  findOccupant(params: {
    hostname: string;
    domainId: string;
    slug: string;
    landingPageId: string;
  }): Promise<HostOccupant | null>;
  /** Transação 1. Lança SlugTakenError ou erro 23505 se outra landing levou o slug. */
  reserve(input: ReserveInput): Promise<ReserveResult>;
  getDeployment(id: string): Promise<PublishDeploymentRow | null>;
  /** Estado intermediário honesto (nunca published/provisioned). */
  markDeployment(id: string, input: MarkInput): Promise<void>;
  /**
   * Registra uma tentativa só em metadata, SEM mudar status/SSL (republicação
   * de deployment já publicado — QA 0.6 F1).
   */
  noteAttempt(id: string, metadata: Record<string, unknown>, now: Date): Promise<void>;
  /** Domínio `pending_dns` com prova (Vercel verified + HTTPS) → `active` (QA 0.6 F2). */
  promoteDomain(domainId: string, now: Date): Promise<void>;
  /** Transação 2. */
  finalize(input: FinalizeInput): Promise<void>;
  loadCheckSnapshot(landingId: string): Promise<PublishCheckSnapshot | null>;
}

type Db = ReturnType<typeof getDb>;

function mergeMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${landingDeployments.deploymentMetadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/** Domínio pertence à loja (store_id nulo = legado anterior à coluna, tratado como l0i). */
const domainInStore = () => or(eq(landingDomains.storeId, PUBLISH_STORE_ID), isNull(landingDomains.storeId));

export function createDrizzlePublishStore(dbArg?: Db): PublishStore {
  const db = (): Db => dbArg ?? getDb();

  const domainColumns = {
    id: landingDomains.id,
    domain: landingDomains.domain,
    role: landingDomains.role,
    dnsRecords: landingDomains.dnsRecords,
  };

  return {
    async getLanding(id) {
      const [row] = await db()
        .select({
          id: landingPages.id,
          slug: landingPages.slug,
          title: landingPages.title,
          status: landingPages.status,
          htmlBody: landingPages.htmlBody,
          cloneMetadata: landingPages.cloneMetadata,
          currentDeploymentId: landingPages.currentDeploymentId,
        })
        .from(landingPages)
        .where(and(eq(landingPages.id, id), eq(landingPages.storeId, PUBLISH_STORE_ID)))
        .limit(1);
      return row ?? null;
    },

    async getDomainById(id) {
      const [row] = await db()
        .select(domainColumns)
        .from(landingDomains)
        .where(and(eq(landingDomains.id, id), domainInStore()))
        .limit(1);
      return row ?? null;
    },

    async getDomainByName(name) {
      const [row] = await db()
        .select(domainColumns)
        .from(landingDomains)
        .where(and(eq(landingDomains.domain, name), domainInStore()))
        .limit(1);
      return row ?? null;
    },

    async findOccupant({ hostname, domainId, slug, landingPageId }) {
      const [binding] = await db()
        .select({
          landingId: landingDomainBindings.landingPageId,
          landingTitle: landingPages.title,
        })
        .from(landingDomainBindings)
        .leftJoin(landingPages, eq(landingPages.id, landingDomainBindings.landingPageId))
        .where(
          and(
            eq(landingDomainBindings.domainId, domainId),
            eq(landingDomainBindings.slug, slug),
            ne(landingDomainBindings.landingPageId, landingPageId),
          ),
        )
        .limit(1);
      if (binding) {
        return { landingId: binding.landingId, landingTitle: binding.landingTitle ?? null, hostname, source: 'binding' };
      }
      const [deployment] = await db()
        .select({
          landingId: landingDeployments.landingPageId,
          landingTitle: landingPages.title,
        })
        .from(landingDeployments)
        .leftJoin(landingPages, eq(landingPages.id, landingDeployments.landingPageId))
        .where(
          and(
            eq(landingDeployments.hostname, hostname),
            ne(landingDeployments.landingPageId, landingPageId),
          ),
        )
        .limit(1);
      if (deployment) {
        return {
          landingId: deployment.landingId,
          landingTitle: deployment.landingTitle ?? null,
          hostname,
          source: 'deployment',
        };
      }
      return null;
    },

    async reserve(input) {
      return db().transaction(async (tx) => {
        const [existing] = await tx
          .select({
            id: landingDeployments.id,
            landingPageId: landingDeployments.landingPageId,
            deploymentStatus: landingDeployments.deploymentStatus,
            sslStatus: landingDeployments.sslStatus,
          })
          .from(landingDeployments)
          .where(eq(landingDeployments.hostname, input.hostname))
          .limit(1);
        if (existing && existing.landingPageId !== input.landingPageId) {
          throw new SlugTakenError(input.hostname);
        }

        let deploymentId: string;
        const wasPublished =
          existing?.deploymentStatus === 'published' && existing.sslStatus === 'provisioned';
        if (existing && wasPublished) {
          // Republicação no mesmo endereço já no ar: o status só muda quando a
          // nova prova confirmar (finalize) — aqui só a tentativa em metadata.
          await tx
            .update(landingDeployments)
            .set({
              deploymentMetadata: mergeMetadata({
                last_attempt_at: input.now.toISOString(),
                last_attempt_source: input.metadata['source'] ?? null,
                domain_id: input.domainId,
              }),
              updatedAt: input.now,
            })
            .where(eq(landingDeployments.id, existing.id));
          deploymentId = existing.id;
        } else if (existing) {
          await tx
            .update(landingDeployments)
            .set({
              deploymentStatus: 'provisioning',
              sslStatus: 'pending',
              verificationUrl: input.verificationUrl,
              unpublishedAt: null,
              deploymentMetadata: mergeMetadata(input.metadata),
              updatedAt: input.now,
            })
            .where(eq(landingDeployments.id, existing.id));
          deploymentId = existing.id;
        } else {
          const [inserted] = await tx
            .insert(landingDeployments)
            .values({
              landingPageId: input.landingPageId,
              deploymentType: input.deploymentType,
              hostname: input.hostname,
              dnsProvider: input.dnsProvider,
              dnsRecords: [],
              sslStatus: 'pending',
              verificationUrl: input.verificationUrl,
              deploymentStatus: 'provisioning',
              deploymentMetadata: input.metadata,
              costUsd: '0',
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning({ id: landingDeployments.id });
          if (!inserted) throw new Error('insert landing_deployments sem retorno');
          deploymentId = inserted.id;
        }

        const [binding] = await tx
          .select({ id: landingDomainBindings.id, landingPageId: landingDomainBindings.landingPageId })
          .from(landingDomainBindings)
          .where(
            and(
              eq(landingDomainBindings.domainId, input.domainId),
              eq(landingDomainBindings.slug, input.slug),
            ),
          )
          .limit(1);
        if (binding && binding.landingPageId !== input.landingPageId) {
          // Nunca reapontar o binding de outra landing (AC5).
          throw new SlugTakenError(input.hostname);
        }
        if (!binding) {
          // Inativo até a finalização: o storefront só serve o novo endereço
          // depois que a Vercel aceitou e o HTTPS respondeu.
          await tx.insert(landingDomainBindings).values({
            domainId: input.domainId,
            landingPageId: input.landingPageId,
            slug: input.slug,
            isDefaultRoot: input.slug === '',
            isActive: false,
            createdAt: input.now,
            updatedAt: input.now,
          });
        }
        return { deploymentId, wasPublished };
      });
    },

    async noteAttempt(id, metadata, now) {
      await db()
        .update(landingDeployments)
        .set({ deploymentMetadata: mergeMetadata(metadata), updatedAt: now })
        .where(eq(landingDeployments.id, id));
    },

    async promoteDomain(domainId, now) {
      await db()
        .update(landingDomains)
        .set({ role: 'active', dnsVerifiedAt: now, updatedAt: now })
        .where(and(eq(landingDomains.id, domainId), eq(landingDomains.role, 'pending_dns')));
    },

    async getDeployment(id) {
      const [row] = await db()
        .select({
          id: landingDeployments.id,
          landingPageId: landingDeployments.landingPageId,
          hostname: landingDeployments.hostname,
          deploymentType: landingDeployments.deploymentType,
          deploymentStatus: landingDeployments.deploymentStatus,
          sslStatus: landingDeployments.sslStatus,
          deploymentMetadata: landingDeployments.deploymentMetadata,
        })
        .from(landingDeployments)
        .innerJoin(landingPages, eq(landingPages.id, landingDeployments.landingPageId))
        .where(and(eq(landingDeployments.id, id), eq(landingPages.storeId, PUBLISH_STORE_ID)))
        .limit(1);
      if (!row) return null;
      const meta = row.deploymentMetadata;
      return {
        ...row,
        deploymentMetadata: meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null,
      };
    },

    async markDeployment(id, input) {
      await db()
        .update(landingDeployments)
        .set({
          deploymentStatus: input.deploymentStatus,
          sslStatus: input.sslStatus,
          deploymentMetadata: mergeMetadata(input.metadata),
          updatedAt: input.now,
        })
        .where(eq(landingDeployments.id, id));
    },

    async finalize(input) {
      await db().transaction(async (tx) => {
        const updated = await tx
          .update(landingDeployments)
          .set({
            deploymentStatus: 'published',
            sslStatus: 'provisioned',
            verificationUrl: input.publishedUrl,
            publishedAt: input.now,
            unpublishedAt: null,
            deploymentMetadata: mergeMetadata(input.metadata),
            updatedAt: input.now,
          })
          .where(
            and(
              eq(landingDeployments.id, input.deploymentId),
              eq(landingDeployments.landingPageId, input.landingPageId),
            ),
          )
          .returning({ id: landingDeployments.id });
        if (updated.length === 0) throw new Error('deployment não encontrado na finalização');

        await tx
          .update(landingPages)
          .set({
            status: 'published',
            currentDeploymentId: input.deploymentId,
            publishedAt: input.now,
            updatedAt: input.now,
          })
          .where(and(eq(landingPages.id, input.landingPageId), eq(landingPages.storeId, PUBLISH_STORE_ID)));

        await tx
          .update(landingDomainBindings)
          .set({ isActive: true, updatedAt: input.now })
          .where(
            and(
              eq(landingDomainBindings.domainId, input.domainId),
              eq(landingDomainBindings.slug, input.slug),
              eq(landingDomainBindings.landingPageId, input.landingPageId),
            ),
          );
      });
    },

    async loadCheckSnapshot(landingId) {
      const [landing] = await db()
        .select({
          id: landingPages.id,
          checkoutProvider: landingPages.checkoutProvider,
          landingKind: landingPages.landingKind,
          htmlBody: landingPages.htmlBody,
          currency: landingPages.currency,
          price: landingPages.price,
          marketId: landingPages.marketId,
          checkoutLogoUrl: landingPages.checkoutLogoUrl,
          useNewBundleEngine: landingPages.useNewBundleEngine,
          ctaConfig: landingPages.ctaConfig,
          offersSource: landingPages.offersSource,
        })
        .from(landingPages)
        .where(and(eq(landingPages.id, landingId), eq(landingPages.storeId, PUBLISH_STORE_ID)))
        .limit(1);
      if (!landing) return null;

      const [market] = landing.marketId
        ? await db()
            .select({ status: landingMarkets.status, currency: landingMarkets.currency, name: landingMarkets.name })
            .from(landingMarkets)
            .where(eq(landingMarkets.id, landing.marketId))
            .limit(1)
        : [];

      const variants = await db()
        .select({
          id: landingVariants.id,
          name: landingVariants.name,
          price: landingVariants.price,
          productVariantId: landingVariants.productVariantId,
          mirrorVariantId: productVariants.mirrorVariantId,
          updatedAt: landingVariants.updatedAt,
          createdAt: landingVariants.createdAt,
        })
        .from(landingVariants)
        .leftJoin(productVariants, eq(productVariants.id, landingVariants.productVariantId))
        .where(eq(landingVariants.landingPageId, landingId))
        .orderBy(asc(landingVariants.sortOrder));

      const offers = await db()
        .select({
          position: landingBundleOffers.position,
          title: landingBundleOffers.title,
          priceCents: landingBundleOffers.priceCents,
          variantId: landingBundleOffers.variantId,
          checkoutUrl: landingBundleOffers.checkoutUrl,
        })
        .from(landingBundleOffers)
        .where(eq(landingBundleOffers.landingPageId, landingId))
        .orderBy(asc(landingBundleOffers.position));

      // Story 16.3: `external` não consulta Stripe nem Shopify (checkout do produtor).
      let hasActiveStripeAccount = false;
      if (landing.checkoutProvider === 'stripe') {
        const [account] = await db()
          .select({ id: stripeAccounts.id })
          .from(stripeAccounts)
          .where(and(eq(stripeAccounts.storeId, PUBLISH_STORE_ID), eq(stripeAccounts.status, 'active')))
          .limit(1);
        hasActiveStripeAccount = Boolean(account);
      }

      return {
        landingId: landing.id,
        checkoutProvider: landing.checkoutProvider,
        landingKind: landing.landingKind,
        htmlBody: landing.htmlBody,
        currency: landing.currency,
        price: landing.price,
        marketId: landing.marketId,
        market: market ?? null,
        checkoutLogoUrl: landing.checkoutLogoUrl,
        useNewBundleEngine: landing.useNewBundleEngine,
        ...(landing.checkoutProvider === 'external'
          ? { externalCheckout: readExternalCheckoutConfig(landing.ctaConfig) }
          : {}),
        variants: variants.map(({ updatedAt: _u, createdAt: _c, ...v }) => v),
        variantsChangedAt: variants.reduce<Date | null>((latest, v) => {
          const t = [v.updatedAt, v.createdAt].filter(Boolean).map((d) => new Date(d as Date));
          const max = t.length ? new Date(Math.max(...t.map((d) => d.getTime()))) : null;
          return max && (!latest || max > latest) ? max : latest;
        }, null),
        offers,
        // Story 25.1: modo das ofertas e resultado da última resolução da posição do bloco.
        offersSource: landing.offersSource,
        offersPlacement: readOffersPlacement(landing.ctaConfig),
        hasActiveStripeAccount,
      };
    },
  };
}
