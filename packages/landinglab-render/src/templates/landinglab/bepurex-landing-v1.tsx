// Bepurex Landing v1 — Skeleton React SSR template (SM-1.2, FR-8).
//
// Landing PDP short-form skeleton com 12 slots fixos + `dynamic_extras` (0-3
// BodySections aprovadas pelo dono, FR-7). Design-agnóstico: consome CSS
// variables (`--color-primary`, `--font-headline`, etc) — nunca hardcode
// de cor/fonte. Design tokens fixos (spacing/radius/shadow) definidos uma
// única vez, CON-5.
//
// Ordem visual (§5.4 architecture, 12 slots fixos + dynamic_extras):
//   0. header            (logo + brand)
//   1. hero              (pdp_hero, required)
//   2. benefits          (bullets, required)
//   3. how_it_works      (timeline, required)
//   4. ingredients       (list, optional)
//   5. bundles           (bundle_picker, required)
//   6. reviews           (reviews, required)
//   7. comparison        (comparison_table, optional)
//   —  dynamic_extras    (0-3 BodySection aprovadas; allowed_types:
//                         certifications | press | before_after | risk_reversal)
//   8. guarantee         (copy_badge, required)
//   9. faq               (faq, required)
//  10. cta_footer        (cta, required)
//  11. legal             (legal, required)
//  12. tracking          (script, required)
//
// Ícones: exclusivamente `lucide-react` (FR-9). Reutiliza blocos de shared.tsx
// no formato `*Block` (AC6 fix aprovado pelo @po). Slots ausentes têm fallback
// gracioso (AC7). Semântica landmark (header/main/footer) + aria-hidden em
// todos os SVG decorativos (AC10 WCAG).

import {
  Check as CheckIcon,
  ShieldCheck as GuaranteeIcon,
  Sparkles as HowItWorksIcon,
} from 'lucide-react';
import * as React from 'react';

import {
  BrandStyle,
  BulletsBlock,
  ComparisonBlock,
  CtaButton,
  FaqBlock,
  HeroBlock,
  StickyCtaBar,
  TestimonialsBlock,
  TrustBadges,
  renderBodySection,
} from './shared.js';
import type { BepurexSlots, BodySection, BundleDisplaySlot } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Design tokens fixos (CON-5). Radius, shadow, spacing, font-sizes —
// NÃO são extraídos por brand-extractor. Cores/fontes vêm do `BrandStyle`
// (shared.tsx) que injeta `--color-*`/`--font-*` via CSS vars. Este bloco
// só complementa com tokens de layout/espaçamento fixos.
// ─────────────────────────────────────────────────────────────────────────

const DESIGN_TOKENS_CSS = `
:root{
  --ll-radius: 12px;
  --ll-radius-sm: 8px;
  --ll-shadow: 0 4px 20px rgba(0,0,0,0.08);
  --ll-shadow-sm: 0 2px 8px rgba(0,0,0,0.05);
  --ll-space-xs: 0.5rem;
  --ll-space-sm: 1rem;
  --ll-space-md: 1.5rem;
  --ll-space-lg: 2rem;
  --ll-space-xl: 3rem;
  --ll-fs-sm: 0.875rem;
  --ll-fs-body: 1rem;
  --ll-fs-lg: 1.25rem;
  --ll-fs-xl: 1.5rem;
}
.ll-lpv1-header{padding:1.25rem 0;border-bottom:1px solid rgba(0,0,0,0.06);background:var(--color-bg)}
.ll-lpv1-header__inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;max-width:960px;margin:0 auto;padding:0 var(--ll-space-sm)}
.ll-lpv1-header__brand{display:flex;align-items:center;gap:0.75rem;font-family:var(--font-headline);font-weight:700;color:var(--color-text)}
.ll-lpv1-header__logo{max-height:36px;width:auto}
.ll-lpv1-header__tagline{font-size:var(--ll-fs-sm);color:#666;font-weight:400;font-family:var(--font-body)}
.ll-lpv1-timeline{padding:var(--ll-space-xl) 0}
.ll-lpv1-timeline__grid{display:grid;grid-template-columns:1fr;gap:var(--ll-space-md);margin-top:var(--ll-space-md)}
@media (min-width:768px){.ll-lpv1-timeline__grid{grid-template-columns:repeat(4,1fr)}}
.ll-lpv1-timeline__step{padding:var(--ll-space-md);background:#fff;border-radius:var(--ll-radius);box-shadow:var(--ll-shadow-sm);border-top:4px solid var(--color-primary)}
.ll-lpv1-timeline__label{font-weight:800;color:var(--color-primary);font-family:var(--font-headline);font-size:var(--ll-fs-lg);margin-bottom:var(--ll-space-xs)}
.ll-lpv1-timeline__desc{font-size:var(--ll-fs-body);color:var(--color-text);margin:0}
.ll-lpv1-doctors{background:linear-gradient(180deg,rgba(0,0,0,0.03),transparent);border-left:4px solid var(--color-accent);padding:var(--ll-space-lg);border-radius:var(--ll-radius);margin:1.5rem 0}
.ll-lpv1-doctors__author{display:flex;align-items:center;gap:0.75rem;margin-top:var(--ll-space-sm);font-weight:700;color:var(--color-text)}
.ll-lpv1-doctors__creds{display:block;font-weight:400;font-size:var(--ll-fs-sm);color:#666}
.ll-lpv1-bundles{display:grid;grid-template-columns:1fr;gap:var(--ll-space-md);margin-top:var(--ll-space-md)}
@media (min-width:768px){.ll-lpv1-bundles{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}}
.ll-lpv1-bundle{position:relative;background:#fff;border:2px solid rgba(0,0,0,0.08);border-radius:var(--ll-radius);padding:var(--ll-space-lg);box-shadow:var(--ll-shadow-sm);display:flex;flex-direction:column;gap:var(--ll-space-xs);text-align:center}
.ll-lpv1-bundle--popular{border-color:var(--color-accent)}
.ll-lpv1-bundle--best{border-color:var(--color-primary);box-shadow:var(--ll-shadow)}
.ll-lpv1-bundle__badge{position:absolute;top:-0.75rem;left:50%;transform:translateX(-50%);background:var(--color-primary);color:#fff;padding:0.25rem 0.75rem;border-radius:999px;font-size:var(--ll-fs-sm);font-weight:700;text-transform:uppercase;letter-spacing:0.05em}
.ll-lpv1-bundle__name{font-family:var(--font-headline);font-weight:700;font-size:var(--ll-fs-lg);margin:0}
.ll-lpv1-bundle__desc{color:#555;font-size:var(--ll-fs-sm);margin:0}
.ll-lpv1-bundle__price{font-size:var(--ll-fs-xl);font-weight:800;color:var(--color-primary);margin-top:var(--ll-space-xs)}
.ll-lpv1-bundle__compare{text-decoration:line-through;color:#888;font-size:var(--ll-fs-sm);margin-left:0.5rem}
.ll-lpv1-bundle__unit{font-size:var(--ll-fs-sm);color:#777;margin:0}
.ll-lpv1-placeholder{background:linear-gradient(135deg,#e5e5e5 0%,#d0d0d0 100%);border-radius:var(--ll-radius);aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;color:#888;font-size:var(--ll-fs-sm)}
.ll-lpv1-legal{padding:var(--ll-space-lg) 0;font-size:var(--ll-fs-sm);color:#666;text-align:center;border-top:1px solid rgba(0,0,0,0.05)}
.ll-lpv1-legal__inner{max-width:960px;margin:0 auto;padding:0 var(--ll-space-sm)}
.ll-lpv1-icon{display:inline-block;vertical-align:middle;color:var(--color-primary)}
`;

// ─── Header (slot 0: logo + brand) ─────────────────────────────────────────

function Header({ brand }: { brand: BepurexSlots['brand'] }): React.ReactElement {
  return (
    <header className="ll-lpv1-header" data-slot="header" role="banner">
      <div className="ll-lpv1-header__inner">
        <div className="ll-lpv1-header__brand">
          {brand.logo_url ? (
            <img
              src={brand.logo_url}
              alt={brand.name}
              className="ll-lpv1-header__logo"
              loading="eager"
            />
          ) : (
            <span>{brand.name}</span>
          )}
        </div>
        {brand.tagline ? (
          <span className="ll-lpv1-header__tagline">{brand.tagline}</span>
        ) : null}
      </div>
    </header>
  );
}

// ─── Hero (slot 1: pdp_hero, required) ────────────────────────────────────
// Reusa HeroBlock; fallback pra placeholder cinza se hero.image_url ausente.

function HeroWithFallback({
  brand,
  hero,
}: {
  brand: BepurexSlots['brand'];
  hero: BepurexSlots['hero'];
}): React.ReactElement {
  if (!hero.image_url || hero.image_url.trim() === '') {
    return (
      <section className="ll-hero" data-slot="hero">
        <div className="ll-container">
          <div className="ll-hero__grid">
            <div>
              <p style={{ margin: 0, color: 'var(--color-accent)', fontWeight: 700 }}>
                {brand.name}
              </p>
              <h1>{hero.headline}</h1>
              <p style={{ fontSize: 'var(--ll-fs-lg)', color: '#555' }}>{hero.subhead}</p>
              <div style={{ marginTop: 'var(--ll-space-md)' }}>
                <CtaButton cta={hero.cta_primary} />
              </div>
            </div>
            <div className="ll-lpv1-placeholder" aria-label="Product image placeholder">
              {brand.name}
            </div>
          </div>
        </div>
      </section>
    );
  }
  return (
    <div data-slot="hero">
      <HeroBlock brand={brand} hero={hero} />
    </div>
  );
}

// ─── Timeline / How-It-Works (slot 3: steps, required) ────────────────────

function TimelineBlock({
  timeline,
}: {
  timeline: NonNullable<BepurexSlots['timeline']>;
}): React.ReactElement {
  return (
    <section className="ll-lpv1-timeline" data-slot="how_it_works">
      <div className="ll-container">
        <h2 style={{ textAlign: 'center' }}>
          <HowItWorksIcon
            className="ll-lpv1-icon"
            size={28}
            aria-hidden="true"
          />{' '}
          {timeline.heading}
        </h2>
        <div className="ll-lpv1-timeline__grid">
          {timeline.steps.map((step, i) => (
            <div key={i} className="ll-lpv1-timeline__step">
              <div className="ll-lpv1-timeline__label">{step.label}</div>
              <p className="ll-lpv1-timeline__desc">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const DEFAULT_TIMELINE: NonNullable<BepurexSlots['timeline']> = {
  heading: 'How it works',
  steps: [
    { label: 'Week 1', description: 'Take daily. First energy shift.' },
    { label: 'Week 2', description: 'Consistency = compounding results.' },
    { label: 'Week 6', description: 'Visible, lasting change.' },
    { label: 'Week 10+', description: 'Your new baseline.' },
  ],
};

// ─── Doctors endorsement (optional bepurex-specific) ──────────────────────

function DoctorsBlock({
  endorsement,
}: {
  endorsement: NonNullable<BepurexSlots['doctors_endorsement']>;
}): React.ReactElement {
  return (
    <section className="ll-section" data-slot="doctors_endorsement">
      <div className="ll-container">
        <div className="ll-lpv1-doctors">
          <h2>{endorsement.heading}</h2>
          <p>{endorsement.body}</p>
          <div className="ll-lpv1-doctors__author">
            <span>
              {endorsement.author}
              <span className="ll-lpv1-doctors__creds">{endorsement.credentials}</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Bundles (slot 5: bundle_picker, required) ────────────────────────────

function BundlesBlock({
  bundles,
  ctaText,
}: {
  bundles: BundleDisplaySlot[];
  ctaText: string;
}): React.ReactElement | null {
  if (bundles.length === 0) return null;
  return (
    <section className="ll-section" data-slot="bundles" id="bundles">
      <div className="ll-container">
        <h2 style={{ textAlign: 'center' }}>Choose your bundle</h2>
        <div className="ll-lpv1-bundles">
          {bundles.map((bundle, i) => {
            const highlight = bundle.highlight ?? null;
            const cls =
              highlight === 'best'
                ? 'll-lpv1-bundle ll-lpv1-bundle--best'
                : highlight === 'popular'
                  ? 'll-lpv1-bundle ll-lpv1-bundle--popular'
                  : 'll-lpv1-bundle';
            const priceEuros = (bundle.priceCents / 100).toFixed(2);
            const compareEuros =
              bundle.compareAtPriceCents !== null
                ? (bundle.compareAtPriceCents / 100).toFixed(2)
                : null;
            const nameId = `ll-lpv1-bundle-h-${i}`;
            return (
              <article
                key={i}
                className={cls}
                data-bundle-index={i}
                data-bundle-highlight={highlight ?? undefined}
                aria-labelledby={nameId}
              >
                {highlight === 'best' ? (
                  <div className="ll-lpv1-bundle__badge">Best value</div>
                ) : highlight === 'popular' ? (
                  <div className="ll-lpv1-bundle__badge">Most popular</div>
                ) : null}
                <h3 id={nameId} className="ll-lpv1-bundle__name">
                  {bundle.name}
                </h3>
                {bundle.description ? (
                  <p className="ll-lpv1-bundle__desc">{bundle.description}</p>
                ) : null}
                <p className="ll-lpv1-bundle__price">
                  {`EUR ${priceEuros}`}
                  {compareEuros ? (
                    <span className="ll-lpv1-bundle__compare">{`EUR ${compareEuros}`}</span>
                  ) : null}
                </p>
                {bundle.quantityUnits ? (
                  <p className="ll-lpv1-bundle__unit">{bundle.quantityUnits} units</p>
                ) : null}
                <a
                  href="#offer"
                  className="ll-cta"
                  aria-label={`${ctaText} — ${bundle.name}`}
                >
                  {ctaText}
                </a>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ─── Ingredients (optional, from body_sections kind='bullets') ────────────

function IngredientsBlock({
  section,
}: {
  section: Extract<BodySection, { kind: 'bullets' }>;
}): React.ReactElement {
  return (
    <section data-slot="ingredients">
      <BulletsBlock heading={section.heading} items={section.items} />
    </section>
  );
}

// ─── Legal (slot 11: required) ────────────────────────────────────────────

function LegalBlock({ brand }: { brand: BepurexSlots['brand'] }): React.ReactElement {
  const year = new Date().getFullYear();
  return (
    <footer className="ll-lpv1-legal" data-slot="legal" role="contentinfo">
      <div className="ll-lpv1-legal__inner">
        <p>
          © {year} {brand.name}. All rights reserved.
        </p>
        <p>
          Statements have not been evaluated by any medical authority. Not intended
          to diagnose, treat, cure, or prevent any disease.
        </p>
      </div>
    </footer>
  );
}

// ─── Tracking (slot 12: script, required) ─────────────────────────────────
// Placeholder — o script real (GTM, Meta Pixel, TikTok Pixel) é injetado pelo
// html-builder após render. Marcamos com data-slot pra auditoria.

function TrackingSlot(): React.ReactElement {
  return (
    <div
      data-slot="tracking"
      data-tracking-placeholder="true"
      style={{ display: 'none' }}
      aria-hidden="true"
    />
  );
}

// ─── Main template ────────────────────────────────────────────────────────

export const BepurexLandingV1: React.FC<BepurexSlots> = (slots) => {
  const allBullets = slots.body_sections.filter(
    (s): s is Extract<BodySection, { kind: 'bullets' }> => s.kind === 'bullets',
  );
  // Primeiro bullets = benefits fixos. Segundo bullets com heading contendo
  // "ingredient" (case-insensitive) = ingredients slot opcional.
  const benefitsSection = allBullets[0];
  const ingredientsSection = allBullets
    .slice(1)
    .find((s) => /ingredient/i.test(s.heading));

  const comparison = slots.body_sections.find(
    (s): s is Extract<BodySection, { kind: 'comparison' }> => s.kind === 'comparison',
  );
  const faqSection = slots.body_sections.find(
    (s): s is Extract<BodySection, { kind: 'faq' }> => s.kind === 'faq',
  );
  const guaranteeSection = slots.body_sections.find(
    (s): s is Extract<BodySection, { kind: 'guarantee' }> => s.kind === 'guarantee',
  );

  const testimonialsSection = slots.body_sections.find(
    (s): s is Extract<BodySection, { kind: 'testimonials' }> => s.kind === 'testimonials',
  );
  const testimonials =
    testimonialsSection?.items ?? slots.social_proof.testimonials_content;
  const testimonialsHeading = testimonialsSection?.heading ?? 'What customers say';

  // dynamic_extras: só renderiza kinds allowed (certifications/press/
  // before_after/risk_reversal). Mapping semântico → BodySection kind:
  //   certifications → 'stats' (label + value)
  //   press          → 'gallery' (logos)
  //   before_after   → 'before_after' (nativo)
  //   risk_reversal  → 'guarantee' (extra, distinto do guarantee fixo)
  const ALLOWED_EXTRA_KINDS: BodySection['kind'][] = [
    'stats',
    'gallery',
    'before_after',
    'guarantee',
  ];
  const dynamicExtras = slots.dynamic_extras
    .filter((s) => ALLOWED_EXTRA_KINDS.includes(s.kind))
    .slice(0, 3);

  // Fallbacks graciosos (AC7). Precedência: body_sections.guarantee →
  // offer_stack.guarantee → texto default.
  const guaranteeHeading = guaranteeSection?.heading ?? '30-day money-back guarantee';
  const guaranteeBody =
    guaranteeSection?.body ??
    (slots.offer_stack.guarantee && slots.offer_stack.guarantee.length > 0
      ? slots.offer_stack.guarantee
      : "If you're not satisfied within 30 days, we refund every cent. No questions asked.");

  const timeline = slots.timeline ?? DEFAULT_TIMELINE;
  const bundles = slots.bundle_slots ?? [];

  return (
    <div lang={slots.language} data-skeleton-id="bepurex-landing-v1">
      <BrandStyle brand={slots.brand} />
      <style dangerouslySetInnerHTML={{ __html: DESIGN_TOKENS_CSS }} />

      {/* 0. Header */}
      <Header brand={slots.brand} />

      <main>
        {/* 1. Hero (pdp_hero, required) */}
        <HeroWithFallback brand={slots.brand} hero={slots.hero} />

        {/* 2. Benefits (bullets, required) */}
        <div data-slot="benefits">
          {benefitsSection ? (
            <BulletsBlock heading={benefitsSection.heading} items={benefitsSection.items} />
          ) : (
            <BulletsBlock
              heading="Key benefits"
              items={[
                { text: 'Clinically studied ingredients' },
                { text: 'Fast, visible results' },
                { text: 'Made in EU, third-party tested' },
              ]}
            />
          )}
        </div>

        {/* 3. How-it-works (steps/timeline, required) */}
        <TimelineBlock timeline={timeline} />

        {/* Optional: doctors_endorsement (bepurex-specific) */}
        {slots.doctors_endorsement ? (
          <DoctorsBlock endorsement={slots.doctors_endorsement} />
        ) : null}

        {/* 4. Ingredients (list, optional) */}
        {ingredientsSection ? <IngredientsBlock section={ingredientsSection} /> : null}

        {/* 5. Bundles (bundle_picker, required) */}
        <BundlesBlock bundles={bundles} ctaText={slots.ctas.primary.text} />

        {/* 6. Reviews (required) */}
        {testimonials.length > 0 ? (
          <div data-slot="reviews">
            <TestimonialsBlock heading={testimonialsHeading} items={testimonials} />
          </div>
        ) : null}

        {/* 7. Comparison (comparison_table, optional) */}
        {comparison ? (
          <div data-slot="comparison">
            <ComparisonBlock heading={comparison.heading} rows={comparison.rows} />
          </div>
        ) : null}

        {/* Trust badges */}
        <div data-slot="trust_badges">
          <TrustBadges items={slots.trust_badges} />
        </div>

        {/* dynamic_extras (0-3 allowed BodySections, FR-7) */}
        {dynamicExtras.length > 0 ? (
          <div data-slot="dynamic_extras">
            {dynamicExtras.map((section, i) => (
              <div
                key={i}
                data-block-id={`dynamic-${section.kind}-${i}`}
                data-block-kind={section.kind}
              >
                {renderBodySection(section, i)}
              </div>
            ))}
          </div>
        ) : null}

        {/* 8. Guarantee (copy_badge, required, com fallback default) */}
        <div data-slot="guarantee">
          <section className="ll-section">
            <div className="ll-container">
              <div className="ll-guarantee">
                <h2>
                  <GuaranteeIcon
                    className="ll-lpv1-icon"
                    size={32}
                    aria-hidden="true"
                  />{' '}
                  {guaranteeHeading}
                </h2>
                <p>{guaranteeBody}</p>
              </div>
            </div>
          </section>
        </div>

        {/* 9. FAQ (required) */}
        <div data-slot="faq">
          {faqSection ? (
            <FaqBlock heading={faqSection.heading} items={faqSection.items} />
          ) : (
            <FaqBlock
              heading="Frequently asked questions"
              items={[
                {
                  question: 'When will I see results?',
                  answer:
                    'Most customers report visible changes within 2–6 weeks of consistent use.',
                },
                {
                  question: 'Is it safe?',
                  answer: 'Yes — third-party tested, made in EU-certified facilities.',
                },
              ]}
            />
          )}
        </div>

        {/* 10. Final CTA footer (required) */}
        <section className="ll-section" data-slot="cta_footer">
          <div className="ll-container ll-cta-block">
            <h2>
              <CheckIcon className="ll-lpv1-icon" size={28} aria-hidden="true" /> Ready to
              start?
            </h2>
            <div
              style={{
                display: 'flex',
                gap: 'var(--ll-space-sm)',
                justifyContent: 'center',
                flexWrap: 'wrap',
                marginTop: 'var(--ll-space-md)',
              }}
            >
              <CtaButton cta={slots.ctas.primary} />
              {slots.ctas.secondary ? (
                <CtaButton cta={slots.ctas.secondary} variant="secondary" />
              ) : null}
            </div>
          </div>
        </section>
      </main>

      {/* 11. Legal (required) */}
      <LegalBlock brand={slots.brand} />

      {/* 12. Tracking (required, placeholder) */}
      <TrackingSlot />

      {/* Sticky CTA opcional — sempre fixed bottom em mobile. */}
      {slots.sticky_cta ? (
        <StickyCtaBar
          text={slots.sticky_cta.text}
          price_hint={slots.sticky_cta.price_hint}
        />
      ) : null}
    </div>
  );
};

export default BepurexLandingV1;
