// render-currency-config — Fase 9D do Landing Lab Stabilization Roadmap.
//
// Extração cirúrgica da §7.99 do apply-bundle.processor.ts. REFACTOR, não redesign.
// Lógica interna é IDÊNTICA à versão pré-9D — mesmas regexes, mesma ordem
// de substituição, mesmo condicional pra fallback #5.
//
// SE PRECISAR MUDAR LÓGICA aqui, PARE e reporte antes.
//
// CONTEXTO PRESERVADO da §7.99 original:
//
// Tema clonado (Shopify) vem com marketCurrencyCode='USD' e moneyFormat
// '${{amount}}'. Se deixarmos assim, o próprio JS do tema reescreve
// nossos €19.99 pra $29.99 quando o usuário troca de card. Aqui trocamos
// o config na STRING HTML (cobrindo tanto attrs escaped &quot; quanto
// JSON literal com aspas normais).
//
// LIMITAÇÃO CONHECIDA (registrada como TD-8.5 no roadmap):
// A regex fallback #5 substitui QUALQUER $NN.NN por ${symbol}NN.NN
// (currency != '$'). Não distingue "preço legítimo" de "texto estático
// como 'Save $30 discount'". Preservar comportamento — corrigir isso
// é redesign (proibido na Fase 9). Fase futura deverá abordar.
//
// OPERA SOBRE STRING (não cheerio): preserva shape original pra evitar
// diferenças sutis de serialização em regiões não-tocadas. Extração não
// migra pra cheerio.

export interface RenderCurrencyConfigContext {
  /** Currency da landing (UPPERCASE, default 'EUR' aplicado no caller) */
  targetCurrency: string;
  /** Símbolo da moeda (ex: '€', '$') — do @blackshop/pricing */
  currencySymbol: string;
}

export interface RenderCurrencyConfigResult {
  /** HTML resultante (string). Caller deve substituir htmlOut original. */
  html: string;
  /** Contagem de substituições realizadas (5 regex distintas) */
  configRewrites: number;
  /** Delta bytes vs input — usado pra log */
  deltaBytes: number;
}

/**
 * Extração cirúrgica da §7.99 do apply-bundle.processor.ts.
 *
 * COMPORTAMENTO IDÊNTICO ao inline pré-9D:
 * - 5 substituições regex na string HTML, na ordem original:
 *   1. escaped attr &quot;marketCurrencyCode&quot; → targetCurrency
 *   2. escaped attr &quot;moneyFormat&quot; → moneyFormatEscaped
 *   3. JS inline `active: 'XXX'` → targetCurrency
 *   4. JS inline `moneyFormat: '...'` → symbol{{amount}}
 *   5. FALLBACK: `\$NN.NN` → `${sym}NN.NN` (só se currencySymbol !== '$')
 *      NOTA: substitui QUALQUER $NN.NN no HTML (TD-8.5). Comportamento
 *      preservado por regra da Fase 9 — não corrigir aqui.
 *
 * OPERA SOBRE STRING (não cheerio). Não muta objeto externo.
 * Retorna novo html + count.
 *
 * @param html String HTML de entrada (output de $.html() no processor).
 * @param ctx  Contexto com currency + symbol.
 * @returns    Novo HTML + count de substituições + delta bytes.
 */
export function renderCurrencyConfig(
  html: string,
  ctx: RenderCurrencyConfigContext,
): RenderCurrencyConfigResult {
  const { targetCurrency, currencySymbol } = ctx;
  const before = html.length;
  let configRewrites = 0;
  let out = html;

  // 1) config="{&quot;marketCurrencyCode&quot;:&quot;USD&quot;,…}"
  out = out.replace(
    /(&quot;marketCurrencyCode&quot;:&quot;)[^&]+(&quot;)/g,
    (_m, a, b) => {
      configRewrites++;
      return `${a}${targetCurrency}${b}`;
    },
  );

  // 2) config="{&quot;moneyFormat&quot;:&quot;${{amount}}&quot;,…}" (escaped)
  const moneyFormatEscaped = `${currencySymbol}{{amount}}`
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  out = out.replace(
    /(&quot;moneyFormat&quot;:&quot;)[^&]+(&quot;)/g,
    (_m, a, b) => {
      configRewrites++;
      return `${a}${moneyFormatEscaped}${b}`;
    },
  );

  // 3) Bloco inline: window.Shopify.currency = { active: 'USD', rate: '1.0' }
  out = out.replace(
    /(active:\s*['"])[A-Z]{3}(['"])/g,
    (_m, a, b) => {
      configRewrites++;
      return `${a}${targetCurrency}${b}`;
    },
  );

  // 4) Bloco inline: moneyFormat: '${{amount}}'   (aspas simples/duplas)
  out = out.replace(
    /(moneyFormat:\s*['"])[^'"]+(['"])/g,
    (_m, a, b) => {
      configRewrites++;
      return `${a}${currencySymbol}{{amount}}${b}`;
    },
  );

  // 5) Fallback: nos price/full-price ainda não tocados, converte $NN.NN → €NN.NN
  //    (só o símbolo; valor numérico preservado — os cards principais já
  //    foram reescritos com valor do painel). Isso pega cart-item preview,
  //    subtotais residuais e labels tipo "Risparmia $30" que sobraram.
  //    ⚠️ TD-8.5: regex GLOBAL sem contexto — não distingue preço legítimo
  //    de texto estático. Comportamento preservado por regra da Fase 9D.
  if (currencySymbol !== '$') {
    const symEscaped = currencySymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(/\$(\d{1,4}(?:[.,]\d{2})?)/g, (_m, num) => {
      configRewrites++;
      return `${symEscaped}${num}`;
    });
  }

  return {
    html: out,
    configRewrites,
    deltaBytes: out.length - before,
  };
}
