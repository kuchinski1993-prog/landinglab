// ADR-001 §6 + Fase 10.3 — Kaching detection rules.
//
// Múltiplas evidências combináveis (não usar seletor único como oráculo).
// Cada regra retorna evidence explicável + score parcial. Detector agrega
// os scores parciais.
//
// Nunca usar URL/domínio como evidência de theme (10.3 §1).

import type { CheerioAPI } from 'cheerio';

// Regra: recebe $ e retorna evidence + delta de score.
// hits=0 → regra não disparou; regras adicionam evidência quando hits > 0.
export interface RuleOutcome {
  ruleId: string;
  hits: number;
  scoreDelta: number; // Contribuição pro score final. Pode ser 0 mesmo com hits.
  reason: string; // Explicação human-readable
}

export type Rule = (input: { $: CheerioAPI }) => RuleOutcome;

// Regras (pesos escolhidos empiricamente pra minimizar false positive):
//
//   R1 primary marker  → 0.40  (existe .kaching-bundles__bar?)
//   R2 data-attribute  → 0.15  (data-deal-bar-id nos bars?)
//   R3 multi-bar       → 0.15  (>= 2 bars → real bundle, não widget solto)
//   R4 price span      → 0.15  (.kaching-bundles__bar-price presente?)
//   R5 compare span    → 0.10  (.kaching-bundles__bar-full-price presente?)
//   R6 nested price    → 0.05  (preço está DENTRO de um bar? evita false positive)
//
// Soma máxima teórica = 1.00.
// CONFIDENCE_THRESHOLD = 0.70 → precisa de R1 + pelo menos R3/R4 pra passar.
// R1 sozinho (0.40) NÃO é suficiente → protege contra classe coincidente.

const R1_PRIMARY_MARKER = 0.4;
const R2_DATA_ATTRIBUTE = 0.15;
const R3_MULTI_BAR = 0.15;
const R4_PRICE_SPAN = 0.15;
const R5_COMPARE_SPAN = 0.1;
const R6_NESTED_PRICE = 0.05;

export const RULES: readonly Rule[] = [
  function primaryMarker({ $ }): RuleOutcome {
    const hits = $('.kaching-bundles__bar').length;
    return {
      ruleId: 'kaching.R1.primary_marker',
      hits,
      scoreDelta: hits > 0 ? R1_PRIMARY_MARKER : 0,
      reason:
        hits > 0
          ? `match:.kaching-bundles__bar count=${hits}`
          : 'no:.kaching-bundles__bar',
    };
  },

  function dataAttribute({ $ }): RuleOutcome {
    const hits = $('.kaching-bundles__bar[data-deal-bar-id]').length;
    return {
      ruleId: 'kaching.R2.data_deal_bar_id',
      hits,
      scoreDelta: hits > 0 ? R2_DATA_ATTRIBUTE : 0,
      reason:
        hits > 0
          ? `match:.kaching-bundles__bar[data-deal-bar-id] count=${hits}`
          : 'no:data-deal-bar-id',
    };
  },

  function multiBar({ $ }): RuleOutcome {
    const hits = $('.kaching-bundles__bar').length;
    // >= 2 bars: real bundle. 1 bar sozinho pode ser widget/skeleton/fragment.
    const disparou = hits >= 2;
    return {
      ruleId: 'kaching.R3.multi_bar',
      hits: disparou ? hits : 0,
      scoreDelta: disparou ? R3_MULTI_BAR : 0,
      reason: disparou
        ? `structural:multi_bar count=${hits}`
        : `structural:insufficient_bars count=${hits}`,
    };
  },

  function priceSpan({ $ }): RuleOutcome {
    const hits = $('.kaching-bundles__bar-price').length;
    return {
      ruleId: 'kaching.R4.price_span',
      hits,
      scoreDelta: hits > 0 ? R4_PRICE_SPAN : 0,
      reason:
        hits > 0
          ? `match:.kaching-bundles__bar-price count=${hits}`
          : 'no:.kaching-bundles__bar-price',
    };
  },

  function compareSpan({ $ }): RuleOutcome {
    const hits = $('.kaching-bundles__bar-full-price').length;
    return {
      ruleId: 'kaching.R5.compare_span',
      hits,
      scoreDelta: hits > 0 ? R5_COMPARE_SPAN : 0,
      reason:
        hits > 0
          ? `match:.kaching-bundles__bar-full-price count=${hits}`
          : 'no:.kaching-bundles__bar-full-price',
    };
  },

  function nestedPrice({ $ }): RuleOutcome {
    // Preços DEVEM estar dentro dos bars. Confirma relação estrutural
    // (evita false positive de spans órfãos com o mesmo nome).
    const priceInsideBar = $(
      '.kaching-bundles__bar .kaching-bundles__bar-price',
    ).length;
    return {
      ruleId: 'kaching.R6.nested_price',
      hits: priceInsideBar,
      scoreDelta: priceInsideBar > 0 ? R6_NESTED_PRICE : 0,
      reason:
        priceInsideBar > 0
          ? `structural:price_nested_in_bar count=${priceInsideBar}`
          : 'structural:no_nested_price',
    };
  },
];

export function runAllRules($: CheerioAPI): RuleOutcome[] {
  return RULES.map((rule) => rule({ $ }));
}
