// Bepurex Advertorial v1 — Skeleton React SSR (SM-1.3).
//
// Long-form advertorial template (Halbert/Schwartz "story-driven" school).
// Consome BepurexSlots + 0-3 dynamic_extras (FR-7). Design-agnóstico via CSS
// vars injetadas por BrandStyle (extraídas em SM-2.2 brand-extractor).
//
// Fixed narrative order (AC7):
//   hero → problem_agitation → solution_benefits → bullets →
//   testimonials → doctors_endorsement → bundle_slots → guarantee →
//   faq → urgency → footer (sticky CTA fica overlay).
//
// dynamic_extras (aprovadas pelo dono): renderizadas DEPOIS de solution_benefits
// e ANTES de bullets — posição narrativa entre "por que" e "o que". Cada slot
// dinâmico ganha âncora data-block-* pra regenerate-inline futuro.
//
// Ícones: apenas lucide-react (AC3, FR-9).

import {
  Award,
  BadgeCheck,
  CheckCircle2,
  Clock,
  Package,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import * as React from 'react';

import {
  BrandStyle,
  BulletsBlock,
  CtaButton,
  FaqBlock,
  findSection,
  GuaranteeBlock,
  HeroBlock,
  ProblemAgitationBlock,
  renderBodySection,
  SolutionBenefitsBlock,
  StickyCtaBar,
  TestimonialsBlock,
  TrustBadges,
  UrgencyBlock,
} from './shared.js';
import type { BepurexSlots, BundleDisplaySlot } from './types.js';

// ─── Fixed design tokens (CON-5) — injected once as CSS custom properties ──
// Colors/fonts are dynamic (BrandStyle); tokens abaixo são fixos.
const ADVERTORIAL_TOKENS = `
:root{
  --ll-radius: 12px;
  --ll-radius-lg: 20px;
  --ll-shadow: 0 4px 20px rgba(0,0,0,0.08);
  --ll-shadow-lg: 0 8px 32px rgba(0,0,0,0.12);
  --ll-space-xs: 0.5rem;
  --ll-space-sm: 1rem;
  --ll-space-md: 1.5rem;
  --ll-space-lg: 2rem;
  --ll-space-xl: 3rem;
  --ll-fs-body: 1rem;
  --ll-fs-lead: 1.15rem;
}
.ll-adv-header{padding:1.25rem 0;border-bottom:1px solid rgba(0,0,0,0.06);background:var(--color-bg)}
.ll-adv-header__inner{display:flex;align-items:center;justify-content:space-between;gap:1rem;max-width:960px;margin:0 auto;padding:0 1rem}
.ll-adv-header__brand{display:flex;align-items:center;gap:0.75rem;font-family:var(--font-headline);font-weight:700;color:var(--color-text)}
.ll-adv-header__logo{max-height:36px;width:auto}
.ll-adv-doctors{background:linear-gradient(180deg,rgba(0,0,0,0.03),transparent);border-left:4px solid var(--color-primary);padding:2rem;border-radius:var(--ll-radius);margin:1.5rem 0}
.ll-adv-doctors__author{display:flex;align-items:center;gap:0.75rem;margin-top:1rem;font-weight:700;color:var(--color-text)}
.ll-adv-doctors__creds{display:block;font-weight:400;font-size:0.9rem;color:#666}
.ll-adv-bundles{display:grid;grid-template-columns:1fr;gap:1rem}
@media (min-width:768px){.ll-adv-bundles{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}}
.ll-adv-bundle{position:relative;background:#fff;border:2px solid rgba(0,0,0,0.08);border-radius:var(--ll-radius);padding:1.5rem;box-shadow:var(--ll-shadow);display:flex;flex-direction:column;gap:0.5rem}
.ll-adv-bundle--popular{border-color:var(--color-accent)}
.ll-adv-bundle--best{border-color:var(--color-primary);transform:scale(1.02)}
.ll-adv-bundle__badge{position:absolute;top:-0.75rem;left:50%;transform:translateX(-50%);background:var(--color-primary);color:#fff;padding:0.25rem 0.75rem;border-radius:999px;font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em}
.ll-adv-bundle__name{font-family:var(--font-headline);font-weight:700;font-size:1.15rem;margin:0}
.ll-adv-bundle__desc{color:#555;font-size:0.9rem;margin:0}
.ll-adv-bundle__units{font-size:0.85rem;color:#777;margin:0}
.ll-adv-bundle__price{font-size:1.75rem;font-weight:800;color:var(--color-primary);margin:0.25rem 0 0}
.ll-adv-bundle__compare{text-decoration:line-through;color:#999;font-size:0.9rem}
.ll-adv-footer{background:rgba(0,0,0,0.03);padding:2.5rem 0;margin-top:2rem;text-align:center;color:#555;font-size:0.9rem}
.ll-adv-footer__badges{display:flex;flex-wrap:wrap;gap:1rem;justify-content:center;align-items:center;margin:1rem 0}
.ll-adv-footer__badges img{max-height:56px;width:auto}
.ll-adv-footer__brand{display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-bottom:0.5rem;color:var(--color-text);font-weight:700;font-family:var(--font-headline)}
.ll-adv-footer__logo{max-height:32px;width:auto}
.ll-adv-tagline{color:var(--color-accent);font-family:var(--font-headline);text-transform:uppercase;letter-spacing:0.08em;font-size:0.85rem;font-weight:700}
`;

// ─── Small subcomponents (design-agnóstico via CSS vars) ──────────────────

function AdvertorialHeader({
  brandName,
  logoUrl,
}: {
  brandName: string;
  logoUrl?: string;
}): React.ReactElement {
  return (
    <header className="ll-adv-header" role="banner">
      <div className="ll-adv-header__inner">
        <div className="ll-adv-header__brand">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={`${brandName} logo`}
              className="ll-adv-header__logo"
              loading="eager"
            />
          ) : (
            <Sparkles size={24} aria-hidden="true" />
          )}
          <span>{brandName}</span>
        </div>
        <span className="ll-adv-tagline" aria-label="Editorial">
          <BadgeCheck
            size={14}
            aria-hidden="true"
            style={{ verticalAlign: 'middle', marginRight: 4 }}
          />
          Advertorial
        </span>
      </div>
    </header>
  );
}

function DoctorsEndorsementBlock({
  heading,
  body,
  author,
  credentials,
}: {
  heading: string;
  body: string;
  author: string;
  credentials: string;
}): React.ReactElement {
  return (
    <section className="ll-section" aria-labelledby="ll-adv-doctors-h">
      <div className="ll-container">
        <div className="ll-adv-doctors">
          <h2 id="ll-adv-doctors-h">
            <Stethoscope
              size={24}
              aria-hidden="true"
              style={{ verticalAlign: 'middle', marginRight: 8 }}
            />
            {heading}
          </h2>
          <p style={{ fontSize: 'var(--ll-fs-lead)', lineHeight: 1.6 }}>{body}</p>
          <div className="ll-adv-doctors__author">
            <Award size={20} aria-hidden="true" />
            <span>
              {author}
              <span className="ll-adv-doctors__creds">{credentials}</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatPriceCents(cents: number, currency = 'EUR'): string {
  const value = (cents / 100).toFixed(2);
  return `${currency} ${value}`;
}

function BundlesBlock({
  heading,
  bundles,
  ctaText,
}: {
  heading: string;
  bundles: BundleDisplaySlot[];
  ctaText: string;
}): React.ReactElement | null {
  if (bundles.length === 0) return null;
  return (
    <section className="ll-section" id="bundles" aria-labelledby="ll-adv-bundles-h">
      <div className="ll-container">
        <h2 id="ll-adv-bundles-h" style={{ textAlign: 'center' }}>
          <Package
            size={24}
            aria-hidden="true"
            style={{ verticalAlign: 'middle', marginRight: 8 }}
          />
          {heading}
        </h2>
        <div className="ll-adv-bundles">
          {bundles.map((b, i) => {
            const cls = `ll-adv-bundle${
              b.highlight === 'popular'
                ? ' ll-adv-bundle--popular'
                : b.highlight === 'best'
                  ? ' ll-adv-bundle--best'
                  : ''
            }`;
            return (
              <article key={i} className={cls} aria-labelledby={`ll-adv-bundle-h-${i}`}>
                {b.highlight ? (
                  <span className="ll-adv-bundle__badge">
                    {b.highlight === 'best' ? 'Best value' : 'Popular'}
                  </span>
                ) : null}
                <h3 id={`ll-adv-bundle-h-${i}`} className="ll-adv-bundle__name">
                  {b.name}
                </h3>
                {b.description ? <p className="ll-adv-bundle__desc">{b.description}</p> : null}
                {b.quantityUnits ? (
                  <p className="ll-adv-bundle__units">{b.quantityUnits} units</p>
                ) : null}
                <p className="ll-adv-bundle__price">{formatPriceCents(b.priceCents)}</p>
                {b.compareAtPriceCents ? (
                  <span className="ll-adv-bundle__compare">
                    {formatPriceCents(b.compareAtPriceCents)}
                  </span>
                ) : null}
                <a
                  href="#offer"
                  className="ll-cta"
                  style={{ marginTop: '0.75rem', textAlign: 'center' }}
                  aria-label={`${ctaText} — ${b.name}`}
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

function AdvertorialFooter({
  brandName,
  tagline,
  logoUrl,
  badges,
  language,
}: {
  brandName: string;
  tagline: string;
  logoUrl?: string;
  badges: Array<{ url: string; alt: string }>;
  language: string;
}): React.ReactElement {
  const year = new Date().getFullYear();
  return (
    <footer className="ll-adv-footer" role="contentinfo">
      <div className="ll-container">
        {badges.length > 0 ? (
          <div className="ll-adv-footer__badges" aria-label="Trust badges">
            {badges.map((b, i) => (
              <img key={i} src={b.url} alt={b.alt} loading="lazy" />
            ))}
          </div>
        ) : null}
        <div className="ll-adv-footer__brand">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={`${brandName} logo`}
              className="ll-adv-footer__logo"
              loading="lazy"
            />
          ) : (
            <ShieldCheck size={18} aria-hidden="true" />
          )}
          <span>{brandName}</span>
        </div>
        <p style={{ margin: '0.25rem 0' }}>{tagline}</p>
        <p style={{ margin: 0, fontSize: '0.8rem', color: '#888' }} lang={language}>
          <Clock
            size={12}
            aria-hidden="true"
            style={{ verticalAlign: 'middle', marginRight: 4 }}
          />
          &copy; {year} {brandName}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}

// ─── Main template ────────────────────────────────────────────────────────

export const BepurexAdvertorialV1: React.FC<BepurexSlots> = (slots) => {
  const {
    language,
    brand,
    hero,
    body_sections,
    dynamic_extras,
    offer_stack,
    ctas,
    trust_badges,
    social_proof,
    sticky_cta,
    doctors_endorsement,
    bundle_slots,
  } = slots;

  // Slots ausentes → fallback gracioso (AC8).
  const problemAgitation = findSection(body_sections, 'problem_agitation');
  const solutionBenefits = findSection(body_sections, 'solution_benefits');
  const bullets = findSection(body_sections, 'bullets');
  const guarantee = findSection(body_sections, 'guarantee');
  const faq = findSection(body_sections, 'faq');
  const urgency = findSection(body_sections, 'urgency');

  const testimonialSlot = findSection(body_sections, 'testimonials');
  const testimonials =
    testimonialSlot ??
    (social_proof.testimonials_content.length > 0
      ? ({
          kind: 'testimonials' as const,
          heading: 'What our customers say',
          items: social_proof.testimonials_content,
        } as const)
      : undefined);

  const defaultGuarantee = {
    heading: 'Risk-free promise',
    body:
      offer_stack.guarantee ||
      '30-day money-back guarantee. If you are not fully satisfied, we refund every cent.',
  };

  return (
    <div lang={language} data-skeleton-id="bepurex-advertorial-v1">
      <BrandStyle brand={brand} />
      <style dangerouslySetInnerHTML={{ __html: ADVERTORIAL_TOKENS }} />

      <AdvertorialHeader brandName={brand.name} logoUrl={brand.logo_url} />

      <main>
        {/* 1. Hero */}
        <HeroBlock brand={brand} hero={hero} />

        {/* Trust badges logo abaixo do hero — social proof imediato */}
        {trust_badges.length > 0 ? <TrustBadges items={trust_badges} /> : null}

        {/* 2. Problem agitation — cria tensão narrativa */}
        {problemAgitation ? (
          <ProblemAgitationBlock
            heading={problemAgitation.heading}
            paragraphs={problemAgitation.paragraphs}
          />
        ) : null}

        {/* 3. Solution benefits — 3-5 razões */}
        {solutionBenefits ? (
          <SolutionBenefitsBlock
            heading={solutionBenefits.heading}
            benefits={solutionBenefits.benefits}
          />
        ) : null}

        {/* dynamic_extras — 0-3 blocos aprovados pelo dono (FR-7).
            Posicionados entre "por que" (solution) e "o que" (bullets). */}
        {dynamic_extras.map((section, i) => (
          <div
            key={`extra-${i}`}
            data-block-id={`dynamic-${section.kind}-${i}`}
            data-block-kind={section.kind}
          >
            {renderBodySection(section, i)}
          </div>
        ))}

        {/* 4. Bullets — bullets compact */}
        {bullets ? <BulletsBlock heading={bullets.heading} items={bullets.items} /> : null}

        {/* 5. Testimonials */}
        {testimonials ? (
          <TestimonialsBlock heading={testimonials.heading} items={testimonials.items} />
        ) : null}

        {/* 6. Doctors endorsement — slot específico do advertorial */}
        {doctors_endorsement ? (
          <DoctorsEndorsementBlock
            heading={doctors_endorsement.heading}
            body={doctors_endorsement.body}
            author={doctors_endorsement.author}
            credentials={doctors_endorsement.credentials}
          />
        ) : null}

        {/* 7. Bundle slots (0-3) — pricing tiers */}
        {bundle_slots && bundle_slots.length > 0 ? (
          <BundlesBlock
            heading="Choose your pack"
            bundles={bundle_slots}
            ctaText={ctas.primary.text}
          />
        ) : null}

        {/* 8. Guarantee — fallback gracioso se ausente (AC8) */}
        <GuaranteeBlock
          heading={guarantee?.heading ?? defaultGuarantee.heading}
          body={guarantee?.body ?? defaultGuarantee.body}
        />

        {/* 9. FAQ */}
        {faq ? <FaqBlock heading={faq.heading} items={faq.items} /> : null}

        {/* 10. Urgency + final CTA */}
        {urgency ? <UrgencyBlock heading={urgency.heading} body={urgency.body} /> : null}

        <section id="offer" className="ll-section">
          <div className="ll-container ll-cta-block">
            <h2>
              <CheckCircle2
                size={24}
                aria-hidden="true"
                style={{ verticalAlign: 'middle', marginRight: 8 }}
              />
              {ctas.primary.text}
            </h2>
            <p style={{ color: '#555' }}>{offer_stack.actual_price}</p>
            <div
              style={{
                display: 'flex',
                gap: '1rem',
                justifyContent: 'center',
                flexWrap: 'wrap',
                marginTop: '1rem',
              }}
            >
              <CtaButton cta={ctas.primary} />
              {ctas.secondary ? <CtaButton cta={ctas.secondary} variant="secondary" /> : null}
            </div>
          </div>
        </section>
      </main>

      {/* Footer com badges + logo + tagline */}
      <AdvertorialFooter
        brandName={brand.name}
        tagline={brand.tagline}
        logoUrl={brand.logo_url}
        badges={trust_badges}
        language={language}
      />

      {/* Sticky CTA (mobile-first) */}
      {sticky_cta ? (
        <StickyCtaBar text={sticky_cta.text} price_hint={sticky_cta.price_hint} />
      ) : null}
    </div>
  );
};
