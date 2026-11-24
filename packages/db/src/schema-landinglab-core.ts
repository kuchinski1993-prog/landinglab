// LandingLab Landing Page System — core schema (Onda 1).
//
// Separado do schema.ts principal pra não inflar arquivo já com 1200+ linhas.
// Referências:
//   - Migration:  packages/db/migrations/0045_l0i_landing_page_system.sql
//     (filename immutable — Drizzle journal integrity; ver Story 13.7)
//   - PRD:        docs/prd/landinglab-system-prd.md
//   - Research:   docs/research/2026-08-04-landinglab-system-latam.md §4
//
// Re-exportado em packages/db/src/index.ts.
//
// Convenções idênticas ao schema.ts principal:
//   - camelCase no TS ↔ snake_case no SQL (via 2º arg do coluna(name))
//   - IDs uuid PK gen_random_uuid()
//   - timestamptz para todos os timestamps
//   - store_id text default 'l0i' — valor legado imutável (Story 13.7).
//     Rename mecânico l0i → landinglab NÃO aplica a valores persistidos:
//     rows existentes em landing_pages com store_id='l0i' devem continuar
//     visíveis. Se um dia migrar, requer migration de dados dedicada.
//   - jsonb com defaults via sql`'{}'::jsonb`
//   - Text arrays via .array().notNull().default(sql`'{}'::text[]`)

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  char,
  timestamp,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  check,
  foreignKey,
  unique,
  type AnyPgColumn,
  type PgTableExtraConfig,
} from 'drizzle-orm/pg-core';

import { landingMarkets, stripeAccounts } from './schema-payments.js';
import { credentials, productVariants } from './schema.js';

// Hosted VSL families group independent locale pages without reusing the
// legacy parentLandingPageId/parentSalesPageId semantics.
export const landingPageFamilies = pgTable(
  'landing_page_families',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    storeId: text('store_id').notNull().default('l0i'),
    title: text('title').notNull(),
    sourceLocale: text('source_locale').notNull().default('en'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    idxLandingPageFamiliesStoreTitle: index('idx_landing_page_families_store_title').on(
      t.storeId,
      t.title
    ),
  })
);

// ─────────────────────────────────────────────────────────────────────────
// 1. landing_pages
// ─────────────────────────────────────────────────────────────────────────

export const landingPages = pgTable(
  'landing_pages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    // draft | published | archived (CHECK constraint no banco).
    status: text('status').notNull().default('draft'),
    // ISO-4217 3-letter (USD, BRL, MXN, ARS, CLP, COP, UYU). CHECK no banco.
    // Story 15.2: com market_id definido, é sincronizada a partir do mercado.
    currency: text('currency').notNull(),
    // Story 15.2 (migration 0080) — mercado (idioma/moeda/frete) da landing.
    marketId: uuid('market_id').references((): AnyPgColumn => landingMarkets.id, {
      onDelete: 'set null',
    }),
    // shopify (padrão) | stripe | external (Story 16.3, migration 0110) —
    // decidido no servidor (CHECK no banco). Coluna text: sem enum a ajustar.
    checkoutProvider: text('checkout_provider').notNull().default('shopify'),
    // Story 15.3 (migration 0081) — nome/imagem no checkout, sem a marca de origem.
    checkoutProductName: text('checkout_product_name'),
    checkoutProductImage: text('checkout_product_image'),
    // Story 15.7 (migration 0085) — logo do header do checkout Stripe.
    // NULL = header mostra o nome da marca (brand_to). CHECKs no banco:
    // altura 16–120 px, alinhamento left|center|right.
    checkoutLogoUrl: text('checkout_logo_url'),
    checkoutLogoHeight: integer('checkout_logo_height').notNull().default(32),
    checkoutLogoAlign: text('checkout_logo_align').notNull().default('left'),
    // dropship | info_product | physical_own (Onda 2). CHECK no banco.
    fulfillmentType: text('fulfillment_type').notNull(),
    htmlBody: text('html_body').notNull(),
    customCss: text('custom_css'),
    mediaUrls: text('media_urls').array().notNull().default(sql`'{}'::text[]`),
    videoUrls: text('video_urls').array().notNull().default(sql`'{}'::text[]`),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    seoImage: text('seo_image'),
    manufacturer: text('manufacturer'),
    productType: text('product_type'),
    countryOfOrigin: text('country_of_origin'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    compareAtPrice: numeric('compare_at_price', { precision: 12, scale: 2 }),
    // Vendas simuladas iniciais (fake urgency). Aplicação soma com
    // COUNT(landing_orders WHERE status='paid') no display.
    soldOutCounter: integer('sold_out_counter').notNull().default(0),
    disclaimerHtml: text('disclaimer_html'),
    anvisaNotificationNumber: text('anvisa_notification_number'),
    cofeprisRegistrationNumber: text('cofepris_registration_number'),
    // Token secreto pra rota /preview/[id]?token=xxx (F5). Gerado no
    // backoffice ao criar landing. NULL em drafts antigos.
    previewToken: text('preview_token'),
    // Cache do html_body pós-DOMPurify (concatenado com custom_css sanitizado).
    // Invalidar quando html_body ou custom_css muda. Aplicação compara
    // sanitizedAt vs updatedAt pra decidir re-sanitizar (ver migration 0046).
    sanitizedHtmlBody: text('sanitized_html_body'),
    // Timestamp da última sanitização. Se < updated_at → cache inválido.
    sanitizedAt: timestamp('sanitized_at', { withTimezone: true }),
    // ─── Autopilot columns (migration 0047 — Story 13.3) ────────────────
    // Additive-only: rows manuais existentes preservam generation_mode='manual'.
    // CHECK constraints em SQL garantem enum válido:
    //   generation_mode: 'manual' | 'autopilot'
    //   source_type:      'aliexpress_link' | 'photo_upload' | 'other_url' | NULL
    //   target_language:  'de' | 'it' | 'en' | 'es' | 'fr' | NULL
    generationMode: text('generation_mode').notNull().default('manual'),
    sourceType: text('source_type'),
    sourceUrl: text('source_url'),
    sourceImageUrl: text('source_image_url'),
    targetLanguage: text('target_language'),
    // ─── Squad 2 (Copy) column (migration 0048 — Story 13.4) ───────────
    // Array de idiomas pro Squad 2 gerar (ex.: ['en','de']). EN sempre incluso.
    // Complementa targetLanguage singular (Squad 1) sem substituir.
    // NULL em modo manual ou landings pré-Story 13.4.
    targetLanguages: text('target_languages').array(),
    // FK pro PIR mais recente. Setado pelo worker Squad 1 após persistir PIR.
    // ON DELETE SET NULL na SQL (definido na migration 0047).
    pirDocumentId: uuid('pir_document_id'),
    // ─── Squad 4 (Build HTML) columns (migration 0050 — Story 13.6) ─────
    // Self-FK. NULL para row base/EN. Aponta pra row base nas variantes
    // de idioma (DE/IT/FR/ES). ON DELETE SET NULL preserva variantes.
    parentLandingPageId: uuid('parent_landing_page_id').references(
      (): AnyPgColumn => landingPages.id,
      { onDelete: 'set null' },
    ),
    // ISO-639-1 do idioma do html_body/copy. CHECK IN ('en','de','it','fr','es')
    // na SQL (migration 0050). NULL em rows legadas pré-autopilot.
    contentLanguage: char('content_language', { length: 2 }),
    // Audit trail do Squad 4: { template_used, generation_notes (min 10),
    // agents_used[], seo_scores?, lighthouse_estimate? }. Shape Zod em
    // packages/landinglab-build/src/schema/build-output.ts (BuildMetadataSchema).
    // Article IV: sempre preenchido pós-build. NULL apenas em rows manuais.
    buildMetadata: jsonb('build_metadata'),
    // ─── Squad 5 (Deploy) column (migration 0051 — Story 13.8) ─────────
    // Aponta pro deployment ativo. Atualizado pelo Deploy Chief ao marcar
    // deployment_status='published'. NULL para landings nunca publicadas.
    // FK em landing_deployments(id) ON DELETE SET NULL enforced via SQL
    // (definido na migration 0051 pra evitar circular ref no Drizzle TS).
    currentDeploymentId: uuid('current_deployment_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // ─── Squad 0 (Cloner) columns (migration 0053 — Fase 5.A) ───────────
    // Preenchidos pelo /api/clone-landing quando generation_mode='cloned'.
    // NULL em landings não-clonadas.
    clonedAt: timestamp('cloned_at', { withTimezone: true }),
    // JSONB com stats do clone: bytes, assets_ok, assets_failed, images_count,
    // latency_ms, source_platform ('shopify'|'woocommerce'|'framer'|'html').
    // Consumido pela aba Clone do EditWorkspace.
    cloneMetadata: jsonb('clone_metadata'),
    // ─── CTA rewrite config (migration 0060 — set/2026) ─────────────────
    // Snapshot da última configuração de reescrita de CTAs aplicada.
    // Shape: { mappings: [{selector, originalHref, newHref, category}],
    //          lastRewriteAt: iso-timestamp }. NULL antes da 1ª reescrita.
    // Permite: (a) re-editar sem re-detectar; (b) audit trail; (c) desfazer
    // apontando de volta pra originalHref.
    ctaConfig: jsonb('cta_config'),
    // ─── Landing kind classification (migration 0062 — set/2026) ────────
    // Tipo semântico da landing pro Wizard de fluxo:
    //   - advertorial: aquece lead, aponta pra sales_page via parent_sales_page_id
    //   - sales_page: oferta com produto Shopify vinculado (variantes, checkout)
    //   - unknown: rows legadas ainda não classificadas
    // CHECK constraint na SQL garante os 3 valores.
    landingKind: text('landing_kind').notNull().default('unknown'),
    // FK opcional: advertorial → sua sales_page pai. Permite CTA "Continue
    // lendo" resolver URL da sales page dinamicamente. NÃO confundir com
    // parentLandingPageId (linha 108) que vincula variantes de idioma.
    parentSalesPageId: uuid('parent_sales_page_id').references(
      (): AnyPgColumn => landingPages.id,
      { onDelete: 'set null' },
    ),
    // ─── Translation state machine (migration 0063 — Fase S.2 + T) ──────
    // Máquina de estado da tradução integrada ao pipeline de clone. UI polleia
    // GET /api/landing-pages/[id] enquanto status ∈ (*_pending, *_running).
    translationStatus: text('translation_status').notNull().default('idle'),
    // Contadores ao vivo emitidos pelos processors. Shape (não estrito):
    //   { phase, imagesDone, imagesTotal, imagesFailed, imagesSkipped,
    //     stringsTranslated, costUsd, message, lastUpdatedAt }.
    translationProgress: jsonb('translation_progress').notNull().default(sql`'{}'::jsonb`),
    // Intenção do usuário no Wizard (antes do clone). Setado pelo endpoint
    // /api/clone-landing quando body inclui targetLanguage. NULL = clone puro
    // sem tradução automática.
    initialTargetLanguage: text('initial_target_language'),
    // Flag do Wizard: se true e initialTargetLanguage != null, o processor
    // translate-text encadeia translate-images ao final.
    initialTranslateImages: boolean('initial_translate_images').notNull().default(false),
    // ─── Brand swap + demographic (Fase Q — brand rebrand) ──────────────
    // Marca detectada no clone original (ex.: "Cayenne Max"). Usada como
    // "from" no rebrand automático (tradução de texto e imagens substituem
    // pela brandTo).
    brandFrom: text('brand_from'),
    // Marca destino do rebrand (ex.: "Vigorex"). NULL = sem rebrand.
    brandTo: text('brand_to'),
    // Demografia-alvo pra face adaptation nas imagens (Fase R). Ex.:
    // "adult male, latin american". NULL = mantém demografia original.
    targetDemographic: text('target_demographic'),
    // ─── Wizard V2 state (migration 0065 — set/2026) ────────────────────
    // Máquina de estado do Wizard V2 (linear step-by-step).
    // Valores: branding | images_selection | progress | pricing | product | publish | done
    // CHECK constraint enforce em SQL.
    wizardStep: text('wizard_step').notNull().default('branding'),
    // Escolhas feitas em cada etapa do wizard (idempotência + retomar).
    // Shape documentado na migration 0065. Nunca sobrescreve sem merge no code side.
    wizardState: jsonb('wizard_state').notNull().default(sql`'{}'::jsonb`),
    // Cache OCR das imagens da landing (populado no clone processor).
    // Shape: [{ url, hasText, hasBrandOrigin, wordCount, ocrText, ocrConfidence }]
    // Usado pela etapa "Seleção de imagens" pra grid com filtros sem re-rodar OCR.
    imageOcrMetadata: jsonb('image_ocr_metadata'),
    // Moeda dos preços dos bundles (ISO 4217). Editável a qualquer momento
    // — só troca símbolo/label na landing, não converte valor.
    displayCurrency: text('display_currency'),
    // ─── Subscription Presentation Mode (migrations add_subs_columns + 0078) ─
    // subsEnabled: mostra o widget Subscribe & Save na landing (visible toggle).
    subsEnabled: boolean('subs_enabled').notNull().default(false),
    // Shopify SellingPlan.id numérico. Apenas passado pro cartCreate — Shopify
    // gerencia billing, desconto real, contratos. Blackshop é só camada visual.
    subsSellingPlanId: text('subs_selling_plan_id'),
    // Badge visual legado ("20% off"). Mantido por backward-compat.
    // Novo campo autoritativo para cálculo: subsDiscountPercent.
    subsDiscountLabel: text('subs_discount_label'),
    // Se true, checkbox nasce pré-selecionado (opt-out). false = opt-in. (migration 0078)
    subsPreselected: boolean('subs_preselected').notNull().default(false),
    // Percentual numérico (0-99) para desconto visual dos preços dos bundles. (migration 0078)
    // Fonte autoritativa para o JS de pricing. NÃO altera Shopify nem preço canônico.
    subsDiscountPercent: integer('subs_discount_percent'),
    // Story 15.6 (migration 0084) — intervalo da assinatura no checkout Stripe
    // (day|week|month|year, CHECK no banco) e contagem 1–12. Shopify ignora.
    subsInterval: text('subs_interval'),
    subsIntervalCount: integer('subs_interval_count').notNull().default(1),
    // Bundle Engine V2 (migration 0069): quando true, storefront lê
    // landing_bundle_offers e injeta window.__LL_BUNDLE_OFFERS__. Script
    // universal popula data-ll-* nos cards. Bepurex/legacy ficam false até
    // migração manual (feature flag).
    useNewBundleEngine: boolean('use_new_bundle_engine').notNull().default(false),
    // Adapter que detectou os bundles no clone: 'kaching' | 'generic' | 'manual' | 'none'.
    bundleAdapter: text('bundle_adapter'),
    bundleAdapterNotes: text('bundle_adapter_notes'),
    // Story 25.1 (migration 0115): 'page' usa as ofertas da página clonada;
    // 'system' troca o bloco original pelo bloco de ofertas do sistema (CHECK no banco).
    offersSource: text('offers_source').notNull().default('page'),
    // GID Shopify do produto criado via publish-shopify (migration 0077).
    // Usado pra idempotência: se setado, adapter usa existingProductGid (retry mode).
    shopifyProductGid: text('shopify_product_gid'),
    // Hosted VSL mode. Legacy rows remain `legacy`; hosted rows use the
    // family/locale/revision fields below and bypass Shopify injectors.
    contentMode: text('content_mode').notNull().default('legacy'),
    familyId: uuid('family_id'),
    locale: text('locale'),
    publishedVersionId: uuid('published_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    storeSlugUniq: uniqueIndex('idx_landing_pages_store_slug').on(t.storeId, t.slug),
    slugIdx: index('idx_landing_pages_slug').on(t.slug),
    statusIdx: index('idx_landing_pages_status').on(t.status),
    // Índice parcial: 99% dos requests do storefront filtram por published.
    publishedIdx: index('idx_landing_pages_published')
      .on(t.storeId, t.slug)
      .where(sql`status = 'published'`),
    previewTokenIdx: uniqueIndex('idx_landing_pages_preview_token')
      .on(t.previewToken)
      .where(sql`preview_token IS NOT NULL`),
    // Squad 4 (0050): filtragem de variantes por landing base.
    parentIdx: index('idx_landing_pages_parent')
      .on(t.parentLandingPageId)
      .where(sql`parent_landing_page_id IS NOT NULL`),
    // Squad 4 (0050): filtragem por idioma no backoffice/storefront.
    contentLanguageIdx: index('idx_landing_pages_content_language')
      .on(t.contentLanguage)
      .where(sql`content_language IS NOT NULL`),
    hostedFamilyLocaleUniq: uniqueIndex('idx_landing_pages_hosted_family_locale')
      .on(t.familyId, t.locale)
      .where(sql`family_id IS NOT NULL AND locale IS NOT NULL`),
    // VSL foundation (0086_vsl_baseline): nomes iguais aos do SQL.
    familyFk: foreignKey({
      name: 'landing_pages_family_id_fkey',
      columns: [t.familyId],
      foreignColumns: [landingPageFamilies.id],
    }).onDelete('set null'),
    publishedVersionFk: foreignKey({
      name: 'landing_pages_published_version_fk',
      columns: [t.publishedVersionId],
      foreignColumns: [landingPageVersions.id],
    }).onDelete('set null'),
    // Fase S.2/T (0063): polling de landings com tradução em andamento.
    translationActiveIdx: index('idx_landing_pages_translation_active')
      .on(t.storeId, t.translationStatus, t.updatedAt)
      .where(sql`translation_status IN ('text_pending','text_running','images_pending','images_running')`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 2. landing_variants
// ─────────────────────────────────────────────────────────────────────────

export const landingVariants = pgTable(
  'landing_variants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // (sem story — redesign incompleto, ver MAPA-DO-SISTEMA; antes citada como "14.1") — FK opcional pra product_variants (interno). Resolve
    // mirror_variant_id Shopify GID via join no /checkout (reuso Story 6.3
    // AuthenLondon). Padrão validado no research
    // 2026-09-09-landing-shopify-integration-patterns/03-recommendations.md §Recomendação 1.
    // ON DELETE SET NULL: apagar produto NÃO derruba landing_variant
    // (preserva histórico; operador re-vincula via backoffice, (sem story — redesign incompleto, ver MAPA-DO-SISTEMA; antes citada como "14.2")).
    productVariantId: uuid('product_variant_id').references(() => productVariants.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    quantityOfItems: integer('quantity_of_items').notNull().default(1),
    followersCount: integer('followers_count'),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    compareAtPrice: numeric('compare_at_price', { precision: 12, scale: 2 }),
    // NULL = ilimitado. Número = decrementa a cada landing_orders.status=paid.
    stock: integer('stock'),
    ean: text('ean'),
    logoUrl: text('logo_url'),
    bannerUrl: text('banner_url'),
    // HTML custom por variant (embed Stripe/dLocal). NULL = checkout default.
    paymentHtml: text('payment_html'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lpIdx: index('idx_landing_variants_lp').on(t.landingPageId, t.sortOrder),
    // (sem story — redesign incompleto, ver MAPA-DO-SISTEMA; antes citada como "14.1") · index parcial pra otimizar lookup no /checkout
    productVariantIdx: index('idx_landing_variants_product_variant')
      .on(t.productVariantId)
      .where(sql`product_variant_id IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 3. landing_domains
// ─────────────────────────────────────────────────────────────────────────

export const landingDomains = pgTable(
  'landing_domains',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // Fase 5.D (migration 0054): NULLABLE agora. Domínio novo criado pelo
    // gerenciador vive sozinho até ser bindado a uma landing via
    // landing_domain_bindings (M:N).
    landingPageId: uuid('landing_page_id').references(() => landingPages.id, {
      onDelete: 'cascade',
    }),
    domain: text('domain').notNull().unique(),
    // active | reserve | blocked | pending_dns | disabled (CHECK no banco).
    role: text('role').notNull(),
    // spaceship | manual | vercel — quem registrou.
    registrar: text('registrar'),
    registrarDomainId: text('registrar_domain_id'),
    vercelProjectId: text('vercel_project_id'),
    // valid | pending | error — vindo do Vercel API poll.
    vercelDomainStatus: text('vercel_domain_status'),
    // Records DNS setados via Spaceship (A + CNAME). Debug futuro.
    dnsRecords: jsonb('dns_records').notNull().default(sql`'{}'::jsonb`),
    dnsVerifiedAt: timestamp('dns_verified_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    // meta_ban | takedown | manual | dns_error.
    blockedReason: text('blocked_reason'),
    // Fase 5.D — apelido user-friendly ("dominio-beleza-#1", "vigorax-fresh").
    nickname: text('nickname'),
    // Tags pra organização por nicho/status ("beleza", "queimado", "fresh").
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    // Observações livres do usuário sobre o domínio.
    notes: text('notes'),
    // Alertas de expiração — 30 dias antes do vencimento, dashboard warn.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // ─── Colunas Porkbun/ad-hoc (adicionadas em setembro/2026) ─────────
    // Alias humano do domínio (independente do nickname, pode ser código).
    alias: text('alias'),
    // Multi-tenant marker — hoje sempre 'l0i', reservado pra futuro.
    storeId: text('store_id').default('l0i'),
    // Custo pago no registrar (USD). Preenchido pelo fluxo Porkbun.
    costUsd: numeric('cost_usd', { precision: 10, scale: 2 }),
    // Data da compra via Porkbun. NULL em domínios registrados fora.
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Trigger set_updated_at() em prod (migration 0064).
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lpIdx: index('idx_landing_domains_lp').on(t.landingPageId),
    // Resolução hostname crítica: middleware faz esta query em CADA request.
    hostnameActiveIdx: uniqueIndex('idx_landing_domains_hostname_active')
      .on(t.domain)
      .where(sql`role = 'active'`),
    // Regra dura: 1 role=active por LP.
    activeIdx: uniqueIndex('idx_landing_domains_active')
      .on(t.landingPageId)
      .where(sql`role = 'active'`),
    reserveIdx: index('idx_landing_domains_reserve')
      .on(t.landingPageId)
      .where(sql`role = 'reserve'`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 3b. landing_domain_bindings (M:N pivot — Fase 5.D)
// ─────────────────────────────────────────────────────────────────────────
// Pivot entre domain (recurso reusável) e landing_page via slug/path.
// Permite:
//   - Reusar 1 domínio pra várias landings (paths diferentes)
//   - Marcar 1 landing como root (servida em dominio.com/)
//   - Storefront LandingLab faz lookup (domain_id, slug) → landing_page_id
export const landingDomainBindings = pgTable(
  'landing_domain_bindings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => landingDomains.id, { onDelete: 'cascade' }),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // URL path sob o domínio. Vazio = root. Único por (domain_id, slug).
    slug: text('slug').notNull().default(''),
    // Landing marcada como default do domínio (servida no path root).
    isDefaultRoot: boolean('is_default_root').notNull().default(false),
    // Endereço tirado do ar sem despublicar a landing (coluna legada da
    // tabela, garantida pela migration 0064).
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique (domain_id, slug) — não pode ter 2 landings no mesmo path.
    domainSlugIdx: uniqueIndex('idx_landing_domain_bindings_domain_slug').on(
      t.domainId,
      t.slug,
    ),
    // Máximo 1 landing default (is_default_root=true) por domínio.
    defaultRootIdx: uniqueIndex('idx_landing_domain_bindings_default_root')
      .on(t.domainId)
      .where(sql`is_default_root = true`),
    landingIdx: index('idx_landing_domain_bindings_landing').on(t.landingPageId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 4. landing_pixels
// ─────────────────────────────────────────────────────────────────────────

export const landingPixels = pgTable(
  'landing_pixels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    // meta | tiktok | google_ads | pinterest (CHECK no banco). V1 UI só meta.
    provider: text('provider').notNull(),
    pixelId: text('pixel_id').notNull(),
    // Vault key (credentials.key). ON DELETE SET NULL — perder credencial
    // preserva pixel pra auditoria; dono re-configura.
    capiCredentialKey: text('capi_credential_key').references(
      () => credentials.key,
      { onDelete: 'set null' },
    ),
    // Meta Events Manager test code (TEST12345). NULL em produção.
    eventTestCode: text('event_test_code'),
    // Array JSON de eventos: ["Purchase","InitiateCheckout","ViewContent"...].
    eventsEnabled: jsonb('events_enabled')
      .notNull()
      .default(sql`'["Purchase","InitiateCheckout","ViewContent"]'::jsonb`),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lpIdx: index('idx_landing_pixels_lp').on(t.landingPageId, t.isActive),
    lpActiveIdx: index('idx_landing_pixels_lp_active')
      .on(t.landingPageId)
      .where(sql`is_active = true`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────
// 5. landing_orders
// ─────────────────────────────────────────────────────────────────────────

export const landingOrders = pgTable(
  'landing_orders',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    // FK sem CASCADE de propósito: nunca perder rastro financeiro.
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id),
    landingVariantId: uuid('landing_variant_id').references(() => landingVariants.id),
    // Formato "L0I-YYYY-NNNN" (gerado no app). UNIQUE global.
    orderNumber: text('order_number').notNull().unique(),
    // pending | paid | preparing | shipped | delivered | refunded | cancelled | chargeback | failed
    // ('preparing' desde a migration 0082 — Story 15.4)
    status: text('status').notNull().default('pending'),
    // stripe | dlocal | manual (CHECK no banco).
    paymentProvider: text('payment_provider').notNull(),
    // Genérico: PaymentIntent OU dLocal order ID OU manual reference.
    paymentProviderOrderId: text('payment_provider_order_id'),
    // Stripe Checkout Session ID — chave idempotency do webhook session.completed.
    stripeSessionId: text('stripe_session_id'),
    // Stripe PaymentIntent ID — chave idempotency do webhook payment_intent.succeeded.
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    customerEmail: text('customer_email').notNull(),
    customerPhone: text('customer_phone'),
    customerName: text('customer_name'),
    // CPF (BR) / RFC (MX) / DNI (AR/UY) / RUT (CL). LATAM PSPs exigem.
    customerDocument: text('customer_document'),
    // JSON flexível — LATAM tem N formatos de endereço.
    shippingAddress: jsonb('shipping_address'),
    // pending | processing | shipped | delivered | failed | NULL.
    fulfillmentStatus: text('fulfillment_status'),
    fulfillmentTracking: text('fulfillment_tracking'),
    fulfillmentCarrier: text('fulfillment_carrier'),
    // Event ID dedup CAPI Purchase — mesmo valor no fbq + Graph API.
    metaEventId: text('meta_event_id'),
    // UTMs, referrer, IP, session_id de tracking, fbc, fbp.
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    raw: jsonb('raw').notNull().default(sql`'{}'::jsonb`),
    // Soft ref pro refund_tickets (sem FK — evita cascade cross-pipeline).
    refundTicketId: uuid('refund_ticket_id'),
    // Story 15.1 (migration 0079) — conta Stripe que cobrou e valor na moeda
    // de saque dela (balance_transaction). Base do volume diário/rotação.
    stripeAccountId: uuid('stripe_account_id').references(() => stripeAccounts.id, {
      onDelete: 'set null',
    }),
    amountSettlementMinor: bigint('amount_settlement_minor', { mode: 'number' }),
    settlementCurrency: text('settlement_currency'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    // Story 15.3 (migration 0081) — pedido do checkout Stripe.
    checkoutSessionId: uuid('checkout_session_id'),
    marketId: uuid('market_id'),
    locale: text('locale'),
    // free | express
    shippingMethod: text('shipping_method'),
    shippingMinor: bigint('shipping_minor', { mode: 'number' }),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    refundedMinor: bigint('refunded_minor', { mode: 'number' }).notNull().default(0),
    // Story 15.4 (migration 0082) — rastreio REAL colado pelo owner (código e
    // transportadora em fulfillment_tracking/fulfillment_carrier). Nunca gerado.
    trackingUrl: text('tracking_url'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    preparingAt: timestamp('preparing_at', { withTimezone: true }),
    // Story 15.6 (migration 0084) — assinatura. order_kind: one_time |
    // subscription_initial | subscription_renewal. stripe_invoice_id UNIQUE
    // parcial = idempotência do invoice.paid de renovação.
    stripeSubscriptionId: text('stripe_subscription_id'),
    subscriptionId: uuid('subscription_id').references((): AnyPgColumn => landingSubscriptions.id, {
      onDelete: 'set null',
    }),
    stripeInvoiceId: text('stripe_invoice_id'),
    orderKind: text('order_kind').$type<LandingOrderKind>().notNull().default('one_time'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lpIdx: index('idx_landing_orders_lp').on(t.landingPageId),
    statusIdx: index('idx_landing_orders_status').on(t.status),
    emailIdx: index('idx_landing_orders_email').on(t.customerEmail),
    lpCreatedIdx: index('idx_landing_orders_lp_created').on(
      t.landingPageId,
      t.createdAt,
    ),
    createdIdx: index('idx_landing_orders_created').on(t.createdAt),
    stripeSessionIdx: uniqueIndex('idx_landing_orders_stripe_session')
      .on(t.stripeSessionId)
      .where(sql`stripe_session_id IS NOT NULL`),
    stripePiIdx: uniqueIndex('idx_landing_orders_stripe_pi')
      .on(t.stripePaymentIntentId)
      .where(sql`stripe_payment_intent_id IS NOT NULL`),
    stripeAccountPaidIdx: index('idx_landing_orders_stripe_account_paid')
      .on(t.stripeAccountId, t.paidAt)
      .where(sql`stripe_account_id IS NOT NULL`),
    paidWaitingIdx: index('idx_landing_orders_paid_waiting')
      .on(t.paidAt)
      .where(sql`status = 'paid'`),
    stripeInvoiceIdx: uniqueIndex('idx_landing_orders_stripe_invoice')
      .on(t.stripeInvoiceId)
      .where(sql`stripe_invoice_id IS NOT NULL`),
    subscriptionIdx: index('idx_landing_orders_subscription')
      .on(t.subscriptionId, t.createdAt)
      .where(sql`subscription_id IS NOT NULL`),
  }),
);

export const LANDING_ORDER_KINDS = ['one_time', 'subscription_initial', 'subscription_renewal'] as const;
export type LandingOrderKind = (typeof LANDING_ORDER_KINDS)[number];

// ─────────────────────────────────────────────────────────────────────────
// 5b. landing_order_events (Story 15.4, migration 0082)
// ─────────────────────────────────────────────────────────────────────────
// Timeline do pedido. visible_to_customer = aparece em /rastreio.
// dedupe_key + UNIQUE (order_id, dedupe_key) = gravação idempotente.

export const LANDING_ORDER_EVENT_TYPES = [
  'paid',
  'preparing',
  'shipped',
  'refunded',
  'email_sent',
  'email_failed',
  'note',
  // Story 15.6 (migration 0084)
  'subscription_started',
  'subscription_renewed',
  'subscription_payment_failed',
  'subscription_canceled',
] as const;
export type LandingOrderEventType = (typeof LANDING_ORDER_EVENT_TYPES)[number];

export const landingOrderEvents = pgTable(
  'landing_order_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orderId: uuid('order_id')
      .notNull()
      .references(() => landingOrders.id, { onDelete: 'cascade' }),
    storeId: text('store_id').notNull().default('l0i'),
    type: text('type').$type<LandingOrderEventType>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    visibleToCustomer: boolean('visible_to_customer').notNull().default(false),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('idx_landing_order_events_order').on(t.orderId, t.createdAt),
    dedupeIdx: uniqueIndex('idx_landing_order_events_dedupe')
      .on(t.orderId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  }),
);

export type LandingOrderEvent = typeof landingOrderEvents.$inferSelect;
export type NewLandingOrderEvent = typeof landingOrderEvents.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// 6. landing_settings — 1:1 com landing_pages
// ─────────────────────────────────────────────────────────────────────────

export const landingSettings = pgTable('landing_settings', {
  landingPageId: uuid('landing_page_id')
    .primaryKey()
    .references(() => landingPages.id, { onDelete: 'cascade' }),
  // Shape documentado no research §4.6 (não schematizado — flexibilidade).
  // Exemplos: checkout.buttonText, urgency.startFrom, dropship.supplierEmail,
  // infoProduct.deliveryUrl, policies.privacyOverride, email.listId (v2).
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const landingPageVersions = pgTable(
  'landing_page_versions',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    landingPageId: uuid('landing_page_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    sourceVersionId: uuid('source_version_id'),
    sourceStorageKey: text('source_storage_key'),
    releaseStoragePrefix: text('release_storage_prefix'),
    entryPath: text('entry_path').notNull().default('index.html'),
    htmlBody: text('html_body').notNull(),
    assetManifest: jsonb('asset_manifest')
      .notNull()
      .default(sql`'{}'::jsonb`),
    validationReport: jsonb('validation_report')
      .notNull()
      .default(sql`'{}'::jsonb`),
    configSnapshot: jsonb('config_snapshot')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('draft'),
    checksum: text('checksum'),
    runtimeVersion: text('runtime_version').notNull().default('v1'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfig => ({
    landingPageVersionsLandingPageIdVersionNumberKey: unique(
      'landing_page_versions_landing_page_id_version_number_key'
    ).on(t.landingPageId, t.versionNumber),
    landingPageVersionsLandingPageIdFkey: foreignKey({
      name: 'landing_page_versions_landing_page_id_fkey',
      columns: [t.landingPageId],
      foreignColumns: [landingPages.id],
    }).onDelete('cascade'),
    landingPageVersionsSourceVersionFk: foreignKey({
      name: 'landing_page_versions_source_version_fk',
      columns: [t.sourceVersionId],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    landingPageVersionsNumberCheck: check(
      'landing_page_versions_number_check',
      sql`(version_number > 0)`
    ),
    landingPageVersionsStatusCheck: check(
      'landing_page_versions_status_check',
      sql`(status = ANY (ARRAY['draft'::text, 'processing'::text, 'ready'::text, 'published'::text, 'failed'::text, 'archived'::text]))`
    ),
    idxLandingPageVersionsPageStatus: index('idx_landing_page_versions_page_status').on(
      t.landingPageId,
      t.status
    ),
  })
);

export const landingHostingSettings = pgTable(
  'landing_hosting_settings',
  {
    landingPageId: uuid('landing_page_id').notNull().primaryKey(),
    videoAssetId: uuid('video_asset_id'),
    videoSelector: text('video_selector'),
    checkoutUrl: text('checkout_url'),
    ctaSelectors: jsonb('cta_selectors')
      .notNull()
      .default(sql`'[]'::jsonb`),
    offerSelectors: jsonb('offer_selectors')
      .notNull()
      .default(sql`'[]'::jsonb`),
    unlockAfterSeconds: integer('unlock_after_seconds').notNull().default(0),
    trackingParams: jsonb('tracking_params')
      .notNull()
      .default(
        sql`'{"allow": ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "fbclid", "gclid", "ttclid", "src", "sck"]}'::jsonb`
      ),
    progressPolicy: text('progress_policy').notNull().default('effective_playback'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    landingHostingSettingsLandingPageIdFkey: foreignKey({
      name: 'landing_hosting_settings_landing_page_id_fkey',
      columns: [t.landingPageId],
      foreignColumns: [landingPages.id],
    }).onDelete('cascade'),
    landingHostingSettingsVideoAssetFk: foreignKey({
      name: 'landing_hosting_settings_video_asset_fk',
      columns: [t.videoAssetId],
      foreignColumns: [landingVideoAssets.id],
    }).onDelete('set null'),
    landingHostingSettingsUnlockAfterSecondsCheck: check(
      'landing_hosting_settings_unlock_after_seconds_check',
      sql`(unlock_after_seconds >= 0)`
    ),
  })
);

export const landingVideoAssets = pgTable(
  'landing_video_assets',
  {
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    landingPageId: uuid('landing_page_id').notNull(),
    provider: text('provider').notNull().default('cloudflare_stream'),
    providerAssetId: text('provider_asset_id'),
    status: text('status').notNull().default('uploading'),
    durationSeconds: integer('duration_seconds'),
    bytes: integer('bytes'),
    mimeType: text('mime_type'),
    playbackUrl: text('playback_url'),
    posterUrl: text('poster_url'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfig => ({
    landingVideoAssetsLandingPageIdFkey: foreignKey({
      name: 'landing_video_assets_landing_page_id_fkey',
      columns: [t.landingPageId],
      foreignColumns: [landingPages.id],
    }).onDelete('cascade'),
    landingVideoAssetsStatusCheck: check(
      'landing_video_assets_status_check',
      sql`(status = ANY (ARRAY['uploading'::text, 'processing'::text, 'ready'::text, 'failed'::text, 'deleted'::text]))`
    ),
    idxLandingVideoAssetsPageStatus: index('idx_landing_video_assets_page_status').on(
      t.landingPageId,
      t.status
    ),
    idxLandingVideoAssetsProviderAsset: uniqueIndex('idx_landing_video_assets_provider_asset')
      .on(t.provider, t.providerAssetId)
      .where(sql`provider_asset_id IS NOT NULL`),
  })
);

// ─────────────────────────────────────────────────────────────────────────
// Types inferidos
// ─────────────────────────────────────────────────────────────────────────

export type LandingPage = typeof landingPages.$inferSelect;
// ─────────────────────────────────────────────────────────────────────────
// Bundle Engine V2 (migration 0069) — landing_bundle_offers
// ─────────────────────────────────────────────────────────────────────────

export const landingBundleOffers = pgTable(
  'landing_bundle_offers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull().default(''),
    qty: integer('qty').notNull().default(1),
    // Minor units da moeda da landing. JPY: 7980 = ¥7,980. USD: 7980 = $79.80.
    priceCents: integer('price_cents').notNull().default(0),
    compareAtCents: integer('compare_at_cents'),
    saveText: text('save_text'),
    badge: text('badge'),
    // ID da variante do produto NA SUA loja Shopify (não do concorrente).
    // Usado pelo CTA universal: redirect pra /cart/{variantId}:{qty}.
    variantId: text('variant_id'),
    isPreselected: boolean('is_preselected').notNull().default(false),
    // Story 25.1 (migration 0115): bullets editáveis e link do botão da oferta
    // (https; prioridade sobre o provider da seção Checkout).
    bullets: text('bullets').array().notNull().default(sql`'{}'::text[]`),
    checkoutUrl: text('checkout_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    landingIdx: index('idx_landing_bundle_offers_landing').on(t.landingPageId, t.position),
    landingPositionUniq: uniqueIndex('landing_bundle_offers_lp_position_key').on(
      t.landingPageId,
      t.position,
    ),
  }),
);

export type LandingBundleOffer = typeof landingBundleOffers.$inferSelect;
export type NewLandingBundleOffer = typeof landingBundleOffers.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// landing_html_snapshots (Fase 7 do Stabilization Roadmap — 25/09/2026)
// Histórico automático de mutações em landing_pages.html_body pra rollback.
// ─────────────────────────────────────────────────────────────────────────
export const landingHtmlSnapshots = pgTable(
  'landing_html_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // Sem FK CASCADE — snapshot sobrevive a delete de landing (audit)
    landingPageId: uuid('landing_page_id').notNull(),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    htmlBody: text('html_body').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    bytesAfter: integer('bytes_after'),
    sha256After: text('sha256_after'),
    warnings: jsonb('warnings').notNull().default(sql`'[]'::jsonb`),
    // Fase 9A · Landing Lab Stabilization: fingerprint dos dados canônicos
    // usados neste render. Se 2 jobs consecutivos têm mesmo fingerprint mas
    // sha256_after diferente → render não é determinístico (bug a investigar).
    dataFingerprint: text('data_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lpIdx: index('idx_landing_html_snapshots_landing').on(t.landingPageId, t.createdAt),
    shaIdx: index('idx_landing_html_snapshots_sha').on(t.landingPageId, t.sha256),
    // Fase 9A: lookup rápido "último snapshot com este fingerprint"
    fingerprintIdx: index('idx_landing_html_snapshots_landing_fingerprint').on(
      t.landingPageId,
      t.dataFingerprint,
      t.createdAt,
    ),
  }),
);

export type LandingHtmlSnapshot = typeof landingHtmlSnapshots.$inferSelect;
export type NewLandingHtmlSnapshot = typeof landingHtmlSnapshots.$inferInsert;

export type NewLandingPage = typeof landingPages.$inferInsert;

export type LandingVariant = typeof landingVariants.$inferSelect;
export type NewLandingVariant = typeof landingVariants.$inferInsert;

export type LandingDomain = typeof landingDomains.$inferSelect;
export type NewLandingDomain = typeof landingDomains.$inferInsert;

// Fase 5.D — M:N pivot entre domains e landing_pages.
export type LandingDomainBinding = typeof landingDomainBindings.$inferSelect;
export type NewLandingDomainBinding = typeof landingDomainBindings.$inferInsert;

export type LandingPixel = typeof landingPixels.$inferSelect;
export type NewLandingPixel = typeof landingPixels.$inferInsert;

export type LandingOrder = typeof landingOrders.$inferSelect;
export type NewLandingOrder = typeof landingOrders.$inferInsert;

export type LandingSettings = typeof landingSettings.$inferSelect;
export type NewLandingSettings = typeof landingSettings.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────
// landing_checkout_sessions (Story 15.3, migration 0081)
// ─────────────────────────────────────────────────────────────────────────
// Snapshot do carrinho criado no clique do CTA. O checkout recalcula tudo a
// partir daqui (oferta + frete do mercado) — nunca confia em preço do browser.

export interface CheckoutItemSnapshot {
  title: string;
  quantity: number;
  unitLabel: string | null;
  priceMinor: number;
  compareAtMinor: number | null;
  image: string | null;
}

export const SUBSCRIPTION_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

/** Snapshot da assinatura na sessão (Story 15.6) — valores só do servidor. */
export interface CheckoutBillingSnapshot {
  mode: 'subscription';
  interval: SubscriptionInterval;
  intervalCount: number;
  /** Valor recorrente (com desconto) cobrado em todas as faturas. */
  unitAmountMinor: number;
  discountPercent: number;
}

export const landingCheckoutSessions = pgTable(
  'landing_checkout_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    token: text('token').notNull(),
    storeId: text('store_id').notNull().default('l0i'),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id),
    marketId: uuid('market_id')
      .notNull()
      .references(() => landingMarkets.id),
    bundleOfferId: uuid('bundle_offer_id').references(() => landingBundleOffers.id, { onDelete: 'set null' }),
    host: text('host').notNull(),
    locale: text('locale').notNull(),
    currency: text('currency').notNull(),
    itemsSnapshot: jsonb('items_snapshot').$type<CheckoutItemSnapshot[]>().notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    shippingMethod: text('shipping_method'),
    shippingMinor: bigint('shipping_minor', { mode: 'number' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    attribution: jsonb('attribution').notNull().default(sql`'{}'::jsonb`),
    customer: jsonb('customer').notNull().default(sql`'{}'::jsonb`),
    stripeAccountId: uuid('stripe_account_id').references(() => stripeAccounts.id, { onDelete: 'set null' }),
    paymentIntentId: text('payment_intent_id'),
    metaEventId: text('meta_event_id').notNull(),
    // open | paid | expired
    status: text('status').notNull().default('open'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    orderId: uuid('order_id'),
    // Story 15.6 (migration 0084) — snapshot da assinatura (NULL = avulso) e a
    // Subscription criada no submit do checkout.
    billing: jsonb('billing').$type<CheckoutBillingSnapshot>(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('idx_landing_checkout_sessions_token').on(t.token),
    piIdx: uniqueIndex('idx_landing_checkout_sessions_pi')
      .on(t.paymentIntentId)
      .where(sql`payment_intent_id IS NOT NULL`),
    landingIdx: index('idx_landing_checkout_sessions_landing').on(t.landingPageId, t.createdAt),
  }),
);

export type LandingCheckoutSession = typeof landingCheckoutSessions.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────
// landing_subscriptions + stripe_offer_prices (Story 15.6, migration 0084)
// ─────────────────────────────────────────────────────────────────────────
// Assinatura do checkout Stripe, presa à conta onde nasceu (FK RESTRICT).
// O estado da assinatura vive aqui; landing_orders mantém o status da 15.4.

export const LANDING_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete_expired',
] as const;
export type LandingSubscriptionStatus = (typeof LANDING_SUBSCRIPTION_STATUSES)[number];

export const landingSubscriptions = pgTable(
  'landing_subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    landingPageId: uuid('landing_page_id')
      .notNull()
      .references(() => landingPages.id),
    firstOrderId: uuid('first_order_id').references((): AnyPgColumn => landingOrders.id, { onDelete: 'set null' }),
    stripeAccountId: uuid('stripe_account_id')
      .notNull()
      .references(() => stripeAccounts.id, { onDelete: 'restrict' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    bundleOfferId: uuid('bundle_offer_id'),
    status: text('status').$type<LandingSubscriptionStatus>().notNull().default('active'),
    interval: text('interval').$type<SubscriptionInterval>().notNull(),
    intervalCount: integer('interval_count').notNull().default(1),
    unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    customerEmail: text('customer_email').notNull(),
    customerName: text('customer_name'),
    locale: text('locale'),
    marketId: uuid('market_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    renewalsCount: integer('renewals_count').notNull().default(0),
    failedPayments: integer('failed_payments').notNull().default(0),
    cancelReason: text('cancel_reason'),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stripeIdx: uniqueIndex('idx_landing_subscriptions_stripe').on(t.stripeAccountId, t.stripeSubscriptionId),
    statusIdx: index('idx_landing_subscriptions_status').on(t.storeId, t.status),
    emailIdx: index('idx_landing_subscriptions_email').on(t.customerEmail),
    accountIdx: index('idx_landing_subscriptions_account').on(t.stripeAccountId),
  }),
);

export type LandingSubscription = typeof landingSubscriptions.$inferSelect;
export type NewLandingSubscription = typeof landingSubscriptions.$inferInsert;

export const stripeOfferPrices = pgTable(
  'stripe_offer_prices',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    storeId: text('store_id').notNull().default('l0i'),
    stripeAccountId: uuid('stripe_account_id')
      .notNull()
      .references(() => stripeAccounts.id, { onDelete: 'cascade' }),
    bundleOfferId: uuid('bundle_offer_id')
      .notNull()
      .references(() => landingBundleOffers.id, { onDelete: 'cascade' }),
    stripeProductId: text('stripe_product_id').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    interval: text('interval').$type<SubscriptionInterval>().notNull(),
    intervalCount: integer('interval_count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyIdx: uniqueIndex('idx_stripe_offer_prices_key').on(
      t.stripeAccountId,
      t.bundleOfferId,
      t.amountMinor,
      t.currency,
      t.interval,
      t.intervalCount,
    ),
  }),
);

export type StripeOfferPrice = typeof stripeOfferPrices.$inferSelect;

export type LandingPageFamily = typeof landingPageFamilies.$inferSelect;
export type NewLandingPageFamily = typeof landingPageFamilies.$inferInsert;
export type LandingPageVersion = typeof landingPageVersions.$inferSelect;
export type NewLandingPageVersion = typeof landingPageVersions.$inferInsert;
export type LandingHostingSettings = typeof landingHostingSettings.$inferSelect;
export type NewLandingHostingSettings = typeof landingHostingSettings.$inferInsert;
export type LandingVideoAsset = typeof landingVideoAssets.$inferSelect;
export type NewLandingVideoAsset = typeof landingVideoAssets.$inferInsert;
