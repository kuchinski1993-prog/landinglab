// LandingLab Stripe — contas e eventos de webhook (Story 15.1).
//
// Migration: packages/db/migrations/0079_stripe_accounts.sql
// Spec:      docs/architecture/landinglab-stripe-checkout.md §4.1, §4.7
//
// Segredos (*_enc/*_iv/*_salt) são criptografados na aplicação com
// @blackshop/vault encrypt/decrypt — nunca devolver ao cliente.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const stripeAccounts = pgTable(
  'stripe_accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    nickname: text('nickname').notNull(),
    // 1 = principal; menor prioridade é escolhida primeiro na rotação.
    priority: integer('priority').notNull().default(1),
    // active | inactive (CHECK no banco).
    status: text('status').notNull().default('active'),
    // test | live — derivado do prefixo das chaves.
    mode: text('mode').notNull(),
    publishableKey: text('publishable_key').notNull(),
    secretKeyEnc: bytea('secret_key_enc').notNull(),
    secretKeyIv: bytea('secret_key_iv').notNull(),
    secretKeySalt: bytea('secret_key_salt').notNull(),
    webhookSecretEnc: bytea('webhook_secret_enc'),
    webhookSecretIv: bytea('webhook_secret_iv'),
    webhookSecretSalt: bytea('webhook_secret_salt'),
    // acct_… e moeda de saque, obtidos no teste de conexão.
    stripeAccountRef: text('stripe_account_ref'),
    defaultCurrency: text('default_currency'),
    chargesEnabled: boolean('charges_enabled'),
    // Unidade mínima de defaultCurrency. NULL = sem limite.
    dailyLimitMinor: bigint('daily_limit_minor', { mode: 'number' }),
    // Reservado (D7): domínio de checkout dedicado por conta, modelo Shoply.
    checkoutDomain: text('checkout_domain'),
    // ok | error | NULL (nunca testada).
    testStatus: text('test_status'),
    testMessage: text('test_message'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
    // Dia (UTC) em que o owner já foi avisado do limite — evita aviso repetido.
    limitNotifiedOn: date('limit_notified_on'),
    // Story 15.3 — domínios registrados na conta (Apple Pay / Google Pay).
    paymentMethodDomains: text('payment_method_domains').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storePriorityIdx: index('idx_stripe_accounts_store_priority').on(t.storeId, t.priority),
  }),
);

export const stripeWebhookEvents = pgTable(
  'stripe_webhook_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    stripeEventId: text('stripe_event_id').notNull(),
    stripeAccountId: uuid('stripe_account_id')
      .notNull()
      .references(() => stripeAccounts.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    livemode: boolean('livemode').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: uniqueIndex('idx_stripe_webhook_events_event').on(t.stripeEventId),
    accountIdx: index('idx_stripe_webhook_events_account').on(t.stripeAccountId, t.receivedAt),
  }),
);

export type StripeAccount = typeof stripeAccounts.$inferSelect;
export type NewStripeAccount = typeof stripeAccounts.$inferInsert;
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────
// landing_markets (Story 15.2, migration 0080)
// ─────────────────────────────────────────────────────────────────────────
// País(es) → idioma, moeda, frete e prazos. A landing herda tudo via
// landing_pages.market_id; landing_pages.currency é sincronizada daqui.

export const landingMarkets = pgTable(
  'landing_markets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    name: text('name').notNull(),
    // ISO 3166-1 alpha-2 aceitos no endereço de entrega (ex.: {IT}).
    countryCodes: text('country_codes').array().notNull().default(sql`'{}'::text[]`),
    // Idioma dos textos de checkout/e-mails (ex.: 'it').
    locale: text('locale').notNull(),
    currency: text('currency').notNull(),
    shippingFreeEnabled: boolean('shipping_free_enabled').notNull().default(true),
    shippingFreeLabel: text('shipping_free_label').notNull(),
    shippingFreeMinDays: integer('shipping_free_min_days').notNull(),
    shippingFreeMaxDays: integer('shipping_free_max_days').notNull(),
    shippingExpressEnabled: boolean('shipping_express_enabled').notNull().default(true),
    shippingExpressLabel: text('shipping_express_label').notNull(),
    // Unidade mínima de currency.
    shippingExpressMinor: bigint('shipping_express_minor', { mode: 'number' }).notNull().default(0),
    shippingExpressMinDays: integer('shipping_express_min_days').notNull(),
    shippingExpressMaxDays: integer('shipping_express_max_days').notNull(),
    preferredStripeAccountId: uuid('preferred_stripe_account_id').references(() => stripeAccounts.id, {
      onDelete: 'set null',
    }),
    // Políticas do mercado (Story 15.4): {"<slug>": {status, html?, updatedAt, publishedAt?}}.
    policies: jsonb('policies').notNull().default(sql`'{}'::jsonb`),
    // Identidade jurídica usada nas políticas (Story 15.4, migration 0082):
    // {legalName, legalAddress, vatId?, refundWindowDays?, returnShippingPayer?}.
    sellerInfo: jsonb('seller_info').notNull().default(sql`'{}'::jsonb`),
    // active | archived.
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeNameIdx: uniqueIndex('idx_landing_markets_store_name').on(t.storeId, sql`lower(${t.name})`),
  }),
);

export type LandingMarket = typeof landingMarkets.$inferSelect;
export type NewLandingMarket = typeof landingMarkets.$inferInsert;
