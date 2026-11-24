// Store policy settings — shape dos dados de negócio que alimentam os
// placeholders dos templates de políticas, + lógica pura de substituição.
//
// A substituição é feita AQUI (share entre back-end para o endpoint GET
// já devolver o HTML preenchido, e front-end poderia também aplicar).
// Deixamos os placeholders que NÃO fazem parte deste formulário intactos
// (ex.: escolha de marketing tool, notas editoriais internas em comentário
// HTML) — o dono os lê e ajusta manualmente se precisar.

export interface StorePolicySettings {
  /** Nome completo do responsável (pessoa física / sole trader). */
  responsibleName: string;
  /** Endereço de contato (service address / virtual mailbox recomendado). */
  contactAddress: string;
  /** ICO registration number (ex.: "ZA123456"). Opcional. */
  icoRegistration: string;
  /** Companies House number. Opcional — vazio enquanto sole trader. */
  companyNumber: string;
  /** VAT registration number (ex.: "GB123456789"). Opcional. */
  vatNumber: string;
  /**
   * Data "Last updated" no topo das políticas (formato YYYY-MM-DD).
   * Se vazio, a substituição usa a data corrente formatada em en-GB.
   */
  lastUpdated: string;
}

export const EMPTY_SETTINGS: StorePolicySettings = {
  responsibleName: '',
  contactAddress: '',
  icoRegistration: '',
  companyNumber: '',
  vatNumber: '',
  lastUpdated: '',
};

/**
 * Merge parcial defensivo — só aceita chaves conhecidas e coage cada
 * valor a string. Usado ao ler `stores.settings` do banco (que é jsonb
 * opaco) e ao consumir o body do PUT.
 */
export function normaliseSettings(raw: unknown): StorePolicySettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const pick = (key: keyof StorePolicySettings): string => {
    const v = src[key];
    return typeof v === 'string' ? v.trim() : '';
  };
  return {
    responsibleName: pick('responsibleName'),
    contactAddress: pick('contactAddress'),
    icoRegistration: pick('icoRegistration'),
    companyNumber: pick('companyNumber'),
    vatNumber: pick('vatNumber'),
    lastUpdated: pick('lastUpdated'),
  };
}

// ─── Substituição de placeholders ────────────────────────────────────────
//
// Cada regra abaixo mapeia UM padrão de placeholder no HTML para um
// campo do settings. Só substituímos quando o campo tem valor; se estiver
// vazio, o placeholder original permanece — a UI destaca o card como
// "incomplete" para o dono não colar em branco sem querer.
//
// As frases são copiadas exatamente dos comentários dos 6 arquivos HTML
// (docs/policies/). Ao alterar o texto lá, atualizar aqui.

interface PlaceholderRule {
  /** Regex que casa com uma variação do placeholder. */
  pattern: RegExp;
  /** Retorna o valor a substituir OU null (mantém o placeholder). */
  replacement: (settings: StorePolicySettings) => string | null;
}

const NAME_RULE: PlaceholderRule = {
  pattern: /\[PLACEHOLDER: full name of the individual responsible\]/g,
  replacement: (s) => (s.responsibleName ? s.responsibleName : null),
};

const ADDRESS_RULE: PlaceholderRule = {
  // Cobre "contact / service address" e a variante com nota "— recommended: ...".
  pattern:
    /\[PLACEHOLDER: contact \/ service address(?: — [^\]]+)?\]/g,
  replacement: (s) => (s.contactAddress ? s.contactAddress : null),
};

const ICO_RULE: PlaceholderRule = {
  pattern:
    /\[PLACEHOLDER: ZAxxxxxxx(?: —[^\]]+)?\]/g,
  replacement: (s) => (s.icoRegistration ? s.icoRegistration : null),
};

const DATE_RULE: PlaceholderRule = {
  // "date on publish" e variantes com exemplo.
  pattern: /\[PLACEHOLDER: date on publish(?:, e\.g\. [^\]]+)?\]/g,
  replacement: (s) => (s.lastUpdated ? formatLastUpdated(s.lastUpdated) : null),
};

const RULES: ReadonlyArray<PlaceholderRule> = [
  NAME_RULE,
  ADDRESS_RULE,
  ICO_RULE,
  DATE_RULE,
];

function formatLastUpdated(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  // timeZone: 'UTC' evita que "2026-07-08" (meia-noite UTC) apareça como
  // "7 July 2026" quando o runtime está atrás de UTC (ex.: BRT / test env).
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Aplica os valores do formulário no HTML, preservando os placeholders
 * cujos campos estão vazios (isso é intencional — o card fica com o
 * badge "incomplete").
 */
export function applySettings(html: string, settings: StorePolicySettings): string {
  let out = html;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => rule.replacement(settings) ?? match);
  }
  return out;
}

/**
 * Verifica quais placeholders substituíveis ainda estão no HTML após
 * a aplicação. Útil para o backoffice avisar "policy X ainda tem
 * campos pendentes".
 */
export function pendingPlaceholders(html: string, settings: StorePolicySettings): string[] {
  const applied = applySettings(html, settings);
  const found: string[] = [];
  for (const rule of RULES) {
    const matches = applied.match(rule.pattern);
    if (matches) found.push(...matches);
  }
  return [...new Set(found)];
}
