// Layout Planner — Fase 3 do redesign LandingLab.
//
// Substitui o `template-selector` fixo (3 templates hardcoded) por um planner
// determinístico que MONTA a sequência de blocos baseada em heurísticas de
// alta conversão (Hormozi Value Equation + Schwartz Awareness).
//
// Entrada: PIR + CopyDeck + VisualAssets + mediaUrls do produto (Firecrawl).
// Saída: BodySection[] ordenado + sticky_cta opcional.
//
// Âncoras fixas (não configuráveis):
//   - Hero e Offer vivem FORA de body_sections (renderizados no template).
//   - Body_sections são todo o miolo entre hero e offer + entre offer e cta-final.
//
// Regras (determinísticas, first-match-wins):
//
//   R1 [Awareness UNAWARE ou PROBLEM-AWARE] → começar com problem_agitation
//      (Schwartz: pra público que não conhece a solução, criar tensão primeiro)
//   R2 [Awareness SOLUTION-AWARE ou PRODUCT-AWARE] → começar com solution_benefits
//      (público já sente a dor, pular pra "aqui está a solução")
//   R3 [Sempre] → testimonials logo antes do offer (social proof pre-decision)
//   R4 [top_pain.intensity >= 7] → adicionar before_after entre solution e testimonials
//   R5 [media_urls.length >= 3] → adicionar gallery após offer (produto visual)
//   R6 [Sempre] → faq após CTA-final (objections handling)
//   R7 [Sempre] → guarantee logo antes do CTA-final
//   R8 [urgency_copy presente] → urgency entre offer e guarantee
//   R9 [comparison_rows disponíveis (raro)] → comparison antes de offer
//   R10 [Sempre] → sticky_cta é gerado com CTA primário + preço

import type { Pir } from '@blackshop/landinglab-research';

// Types dos slots vivem no template — importamos direto do subpath do render.
import type {
  BodySection,
  BulletSlot,
  FaqSlot,
  TestimonialSlot,
} from '@blackshop/landinglab-render/templates/landinglab';

// Chaves de awareness (Schwartz) — usadas pra decidir R1 vs R2.
type Awareness = 'unaware' | 'problem_aware' | 'solution_aware' | 'product_aware' | 'most_aware';

export interface PlannerBlockInput {
  /** Bullets já formatados pelo composer (do CopyDeck) */
  benefit_bullets: BulletSlot[];
  /** FAQ do CopyDeck */
  faq: FaqSlot[];
  /** Verbatim VOC do top_pain (usado em problem_agitation e story) */
  top_pain_verbatim: string | null;
  /** Subheadlines do CopyDeck (usadas em problem_agitation/story) */
  subheadlines: string[];
  /** Testimonials extraídos de social_proof_blocks */
  testimonials: TestimonialSlot[];
  /** Guarantee text do CopyDeck */
  guarantee: string | null;
  /** Urgency copy do CopyDeck */
  urgency: string | null;
  /** URLs de before/after do visual assets */
  before_after_urls: string[];
  /** URLs de mídia do produto (Firecrawl scrape do AliExpress) */
  media_urls: string[];
  /** Awareness stage vindo do PIR */
  pir: Pir;
  /** CTA primário do CopyDeck — texto */
  cta_primary_text: string;
  /** Preço formatado pra sticky CTA (ex: "EUR 69,95") */
  price_display: string | null;
}

export interface LayoutPlan {
  body_sections: BodySection[];
  sticky_cta?: { text: string; price_hint?: string };
  reasoning: string;
}

function readAwareness(pir: Pir): Awareness {
  // pir.market.awareness_stage_priority (array) — pega o primeiro válido.
  const priority = (pir.market as { awareness_stage_priority?: string[] } | undefined)
    ?.awareness_stage_priority;
  const first = Array.isArray(priority) ? priority[0] : undefined;
  if (
    first === 'unaware' ||
    first === 'problem_aware' ||
    first === 'solution_aware' ||
    first === 'product_aware' ||
    first === 'most_aware'
  ) {
    return first;
  }
  return 'solution_aware'; // default seguro pra dropship
}

function readTopPainIntensity(pir: Pir): number {
  return pir.voc?.top_pains?.[0]?.intensity ?? 0;
}

export function planLayout(input: PlannerBlockInput): LayoutPlan {
  const {
    benefit_bullets,
    faq,
    top_pain_verbatim,
    subheadlines,
    testimonials,
    guarantee,
    urgency,
    before_after_urls,
    media_urls,
    pir,
    cta_primary_text,
    price_display,
  } = input;

  const awareness = readAwareness(pir);
  const painIntensity = readTopPainIntensity(pir);
  const reasoning: string[] = [`awareness=${awareness}`, `pain_intensity=${painIntensity}`];

  const sections: BodySection[] = [];

  // R1 vs R2 — abertura do miolo depende de awareness.
  const startsWithProblem = awareness === 'unaware' || awareness === 'problem_aware';
  if (startsWithProblem && (top_pain_verbatim || subheadlines[0])) {
    const paragraphs = [top_pain_verbatim, subheadlines[0], subheadlines[1]]
      .filter((p): p is string => !!p)
      .slice(0, 3);
    if (paragraphs.length > 0) {
      sections.push({
        kind: 'problem_agitation',
        heading: 'Sound familiar?',
        paragraphs,
      });
      reasoning.push('R1: problem_agitation (low awareness)');
    }
  }

  // Solution benefits — usa bullets do CopyDeck (garantia mínima: 3 bullets).
  if (benefit_bullets.length >= 3) {
    sections.push({
      kind: 'solution_benefits',
      heading: startsWithProblem ? 'Here’s the fix' : 'Why it works',
      benefits: benefit_bullets.slice(0, 5),
    });
    reasoning.push('R2: solution_benefits (bullets>=3)');
  } else if (benefit_bullets.length > 0) {
    // Fallback: bullets simples quando não temos volume pra solution_benefits.
    sections.push({
      kind: 'bullets',
      heading: 'What you get',
      items: benefit_bullets,
    });
    reasoning.push('R2b: bullets fallback (bullets<3)');
  }

  // R4 — before/after se dor forte + imagens disponíveis.
  if (painIntensity >= 7 && before_after_urls.length >= 2) {
    sections.push({
      kind: 'before_after',
      heading: 'The transformation',
      before: { image_url: before_after_urls[0]!, label: 'Before' },
      after: { image_url: before_after_urls[1]!, label: 'After' },
    });
    reasoning.push('R4: before_after (pain>=7 + 2+ imgs)');
  }

  // R3 — testimonials sempre antes do offer, se temos.
  if (testimonials.length > 0) {
    sections.push({
      kind: 'testimonials',
      heading: 'Real customer wins',
      items: testimonials.slice(0, 3),
    });
    reasoning.push('R3: testimonials');
  }

  // R8 — urgency entre offer e guarantee (marcamos aqui pro planner injetar
  // após o OfferBlock via body_section; a âncora #offer é do OfferBlock que
  // vive no template, não em body_sections).
  // NOTA: no template DynamicBlocks, body_sections é tudo antes do OfferBlock.
  // Guarantee/urgency vão logo antes do CTA-final. Ordem: body → offer → urgency → guarantee → gallery → faq → CTA.
  //
  // Como body_sections é linear (pré-offer), colocamos urgency + guarantee +
  // gallery + faq como POST-offer via marker. Solução: template renderiza
  // body_sections antes do offer, e o composer/planner emite mais uma lista
  // separada (post_offer_sections). Pra manter simples nesta fase, vamos
  // empilhar tudo em body_sections e o template renderiza:
  //   body_sections (miolo) → OfferBlock → CTA final.
  // Ou seja, guarantee/urgency/gallery/faq VAO ANTES do offer.
  // Isso não é ideal mas mantém contrato. Fase 4 pode separar pre/post.

  if (urgency) {
    sections.push({
      kind: 'urgency',
      heading: 'Limited window',
      body: urgency,
    });
    reasoning.push('R8: urgency');
  }

  // R9 — comparison table. Se PIR tem competidores identificados, podemos
  // gerar linhas. Por ora, skip se sem dados sintéticos (evita invenção).
  // TODO: extrair de pir.market.competitors quando composer suportar.

  // R5 — gallery de produto (mediaUrls do Firecrawl).
  if (media_urls.length >= 3) {
    sections.push({
      kind: 'gallery',
      heading: 'See it up close',
      image_urls: media_urls.slice(0, 8),
    });
    reasoning.push('R5: gallery (media_urls>=3)');
  }

  // R7 — guarantee sempre antes do CTA-final (última seção pre-offer).
  if (guarantee) {
    sections.push({
      kind: 'guarantee',
      heading: 'Our promise',
      body: guarantee,
    });
    reasoning.push('R7: guarantee');
  }

  // R6 — FAQ pós-offer via body_sections também (limita a 5 pra não sobrecarregar).
  if (faq.length > 0) {
    sections.push({
      kind: 'faq',
      heading: 'Common questions',
      items: faq.slice(0, 6),
    });
    reasoning.push('R6: faq');
  }

  // R10 — sticky_cta sempre.
  const stickyCta = {
    text: cta_primary_text,
    ...(price_display ? { price_hint: price_display } : {}),
  };
  reasoning.push('R10: sticky_cta');

  return {
    body_sections: sections,
    sticky_cta: stickyCta,
    reasoning: reasoning.join(' | '),
  };
}
