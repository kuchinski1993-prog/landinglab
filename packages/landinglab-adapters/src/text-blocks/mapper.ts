// Fase 11.6 — Text block mapper.
//
// PRECISION > COVERAGE. Blocks só nascem quando origem semântica for
// forte (region confirmada OU EditableField explícito).
//
// NÃO faz text walker global (isso seria como translate-text — cego).

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { buildDomScope } from '../shared-detectors/dom-scope.js';
import type { EditableField } from '../types/editable-field.js';
import type { RegionEntry } from '../semantic-mapper/types.js';
import type {
  SemanticTextBlock,
  TextBlockKind,
} from './types.js';

export interface TextBlockMapperInput {
  html: string;
  regions?: readonly RegionEntry[];
  editableFields?: readonly EditableField[];
}

export interface TextBlockMapperResult {
  blocks: SemanticTextBlock[];
  blockCountByKind: Record<TextBlockKind, number>;
  unknownCount: number;
}

export function computeTextBlocks(input: TextBlockMapperInput): TextBlockMapperResult {
  const blockCountByKind: Record<TextBlockKind, number> = {
    headline: 0,
    subheadline: 0,
    product_title: 0,
    cta_label: 0,
    benefit_item: 0,
    faq_question: 0,
    faq_answer: 0,
    article_paragraph: 0,
    testimonial: 0,
    guarantee_text: 0,
    footer_text: 0,
    unknown: 0,
  };

  let $: CheerioAPI;
  try {
    $ = cheerio.load(input.html);
  } catch {
    return { blocks: [], blockCountByKind, unknownCount: 0 };
  }

  const blocks: SemanticTextBlock[] = [];
  const seenPaths = new Set<string>(); // Evita duplicados por scope

  // Source 1: EditableFields do tipo 'text' (11.3 detectors emitiram)
  for (const field of input.editableFields ?? []) {
    if (field.type !== 'text' || field.source !== 'html') continue;
    if (typeof field.value !== 'string' || field.value.length === 0) continue;

    const blockKind = editableFieldToBlockKind(field);
    if (!blockKind) continue;

    const el = field.selector ? $(field.selector).get(0) : null;
    const scope = el
      ? buildDomScope($, el)
      : { structuralPath: `virtual:${field.id}`, instanceId: 'virtual', selector: field.selector ?? '', tagName: 'text' };

    if (seenPaths.has(scope.structuralPath)) continue;
    seenPaths.add(scope.structuralPath);

    blocks.push({
      id: field.id,
      blockKind,
      content: field.value,
      regionKind: field.region,
      confidence: field.confidence,
      evidence: [`from_editable_field:${field.id}`],
      structuralPath: scope.structuralPath,
      instanceId: scope.instanceId,
      selector: scope.selector,
      capabilities: ['edit', 'translate'],
    });
    blockCountByKind[blockKind]++;
  }

  // Source 2: Regions confirmadas — extrai texto de children conhecidos
  for (const region of input.regions ?? []) {
    if (region.kind === 'article_body') {
      extractArticleParagraphs($, region, blocks, blockCountByKind, seenPaths);
    } else if (region.kind === 'faq') {
      extractFaqPairs($, region, blocks, blockCountByKind, seenPaths);
    } else if (region.kind === 'footer') {
      extractFooterText($, region, blocks, blockCountByKind, seenPaths);
    }
  }

  return {
    blocks,
    blockCountByKind,
    unknownCount: blockCountByKind.unknown,
  };
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function editableFieldToBlockKind(field: EditableField): TextBlockKind | null {
  // IDs conhecidos → mapping
  if (field.id === 'article.headline.text') return 'headline';
  if (field.id === 'article.subheadline.text') return 'subheadline';
  if (field.id.startsWith('cta_primary.') && field.id.endsWith('.label')) return 'cta_label';

  // Fallback por region
  if (field.region === 'headline') return 'headline';
  if (field.region === 'subheadline') return 'subheadline';
  if (field.region === 'cta_primary') return 'cta_label';
  if (field.region === 'product_title') return 'product_title';

  return null;
}

function extractArticleParagraphs(
  $: CheerioAPI,
  region: RegionEntry,
  blocks: SemanticTextBlock[],
  counters: Record<TextBlockKind, number>,
  seenPaths: Set<string>,
): void {
  const article = $(region.region.selector).get(0);
  if (!article) return;

  const paragraphs = $(article as never).children('p').toArray();
  let idx = 0;
  for (const p of paragraphs) {
    const scope = buildDomScope($, p);
    if (seenPaths.has(scope.structuralPath)) continue;
    seenPaths.add(scope.structuralPath);

    const text = $(p as never).text().trim();
    if (text.length < 20) continue; // Skip fragmentos pequenos

    blocks.push({
      id: `article.paragraph.${idx}`,
      blockKind: 'article_paragraph',
      content: text,
      regionKind: 'article_body',
      index: idx,
      confidence: region.confidence,
      evidence: [`from_region:${region.kind}`, `parent_owner:${region.ownerId}`],
      structuralPath: scope.structuralPath,
      instanceId: scope.instanceId,
      selector: scope.selector,
      capabilities: ['edit', 'translate'],
    });
    counters.article_paragraph++;
    idx++;
  }
}

function extractFaqPairs(
  $: CheerioAPI,
  region: RegionEntry,
  blocks: SemanticTextBlock[],
  counters: Record<TextBlockKind, number>,
  seenPaths: Set<string>,
): void {
  const container = $(region.region.selector).get(0);
  if (!container) return;

  // Triggers: buttons ou summaries dentro do container
  const triggers = $(container as never)
    .find(
      '.cc-faq__question, .faq-img-question, .pss-accordion-trigger, summary, [aria-expanded]',
    )
    .toArray();

  let qIdx = 0;
  for (const trigger of triggers) {
    const $t = $(trigger as never);
    const text = $t.text().trim();
    if (text.length === 0) continue;

    const scope = buildDomScope($, trigger);
    if (seenPaths.has(scope.structuralPath)) continue;
    seenPaths.add(scope.structuralPath);

    blocks.push({
      id: `faq.section.${region.instanceId}.q.${qIdx}`,
      blockKind: 'faq_question',
      content: text,
      regionKind: 'faq',
      index: qIdx,
      confidence: region.confidence,
      evidence: [`from_region:faq`, `parent_owner:${region.ownerId}`],
      structuralPath: scope.structuralPath,
      instanceId: scope.instanceId,
      selector: scope.selector,
      capabilities: ['edit', 'translate'],
    });
    counters.faq_question++;

    // Tenta encontrar answer: sibling .cc-faq__answer / .faq-img-answer /
    // .pss-accordion-panel OR details > *:not(summary)
    const answer = $t.next('.cc-faq__answer, .faq-img-answer, .pss-accordion-panel');
    let answerEl = answer.get(0);
    if (!answerEl && scope.tagName === 'summary') {
      // details > summary + siblings
      const parent = $t.parent();
      const detailsChildren = parent.children().toArray();
      const summaryIdx = detailsChildren.findIndex((c) => c === trigger);
      if (summaryIdx >= 0 && detailsChildren.length > summaryIdx + 1) {
        answerEl = detailsChildren[summaryIdx + 1]!;
      }
    }

    if (answerEl) {
      const aScope = buildDomScope($, answerEl);
      const aText = $(answerEl as never).text().trim();
      if (aText.length > 0 && !seenPaths.has(aScope.structuralPath)) {
        seenPaths.add(aScope.structuralPath);
        blocks.push({
          id: `faq.section.${region.instanceId}.a.${qIdx}`,
          blockKind: 'faq_answer',
          content: aText,
          regionKind: 'faq',
          index: qIdx,
          confidence: region.confidence,
          evidence: [`from_region:faq`, `parent_owner:${region.ownerId}`],
          structuralPath: aScope.structuralPath,
          instanceId: aScope.instanceId,
          selector: aScope.selector,
          capabilities: ['edit', 'translate'],
        });
        counters.faq_answer++;
      }
    }

    qIdx++;
  }
}

function extractFooterText(
  $: CheerioAPI,
  region: RegionEntry,
  blocks: SemanticTextBlock[],
  counters: Record<TextBlockKind, number>,
  seenPaths: Set<string>,
): void {
  const footerEl = $(region.region.selector).get(0);
  if (!footerEl) return;
  const scope = buildDomScope($, footerEl);
  if (seenPaths.has(scope.structuralPath)) return;
  seenPaths.add(scope.structuralPath);

  const text = $(footerEl as never).text().trim().replace(/\s+/g, ' ');
  if (text.length === 0) return;
  // Só um bloco footer_text agregado — não decompomos.
  blocks.push({
    id: `footer.${region.instanceId}.text`,
    blockKind: 'footer_text',
    content: text.length > 500 ? text.slice(0, 500) + '…' : text,
    regionKind: 'footer',
    confidence: region.confidence,
    evidence: [`from_region:footer`, `parent_owner:${region.ownerId}`],
    structuralPath: scope.structuralPath,
    instanceId: scope.instanceId,
    selector: scope.selector,
    capabilities: ['edit', 'translate'],
  });
  counters.footer_text++;
}
