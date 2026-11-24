// Story 20.2 — registro de itens de navegação do painel (menu Conta × Loja).
//
// ÚNICA fonte do menu lateral: o shell (`components/shell/*`) só renderiza o
// que está aqui. Nada de itens inline no layout.
//
// Formato compatível com o campo `nav` do `modules.ts` da story 19.3a: cada
// item de primeiro nível pode declarar `module` (id do módulo) e, quando o
// registro de módulos existir, cada módulo contribui com os SEUS itens neste
// mesmo formato — este arquivo vira a fonte de fallback. A checagem de módulo
// ligado/desligado passa sempre por `isModuleEnabled` (lib/nav/modules.ts).
//
// Campos (equivalência com a story): `area` = `level` da story
// ('conta' = account, 'loja' = store); o "grupo" de um item é o item pai
// (`children`); `flag` = `featureFlag`.
//
// Regras (testadas em src/__tests__/nav-registry.test.ts):
//  • ids únicos; rótulos em português, sem emojis e sem os termos antigos
//    ("Dashboard", "Jobs", "Tracking", "Landing Pages", "VSL Hosting"...);
//  • nenhum rótulo qualificado ("Grupo › Item") nem destino repetido;
//  • todo `href` aponta para uma rota existente em app/(dashboard) e nunca
//    para uma rota só-redirect (REDIRECT_ONLY_ROUTES).
//
// Rotas NÃO mudam de URL nesta story — só a posição no menu. A decisão de
// levar a loja ativa para a URL (/lojas/[id]/…) é pendência do @architect (O3).

import { isModuleEnabled } from './modules';

import { isSkeletonModeEnabledClient } from '@/lib/feature-flags';


export type NavArea = 'conta' | 'loja';

/** Ícones do Polaris Web Components (`<s-icon type>`). */
export type NavIcon =
  | 'home'
  | 'store'
  | 'magic'
  | 'play-circle'
  | 'target'
  | 'settings'
  | 'product'
  | 'order'
  | 'chart-vertical'
  | 'store-online'
  | 'shield-check-mark'
  | 'megaphone'
  | 'clipboard-checklist';

export type NavBadgeKey = 'supportUnread' | 'landingAlerts' | 'accessRequests';
export type NavFlag = 'skeletonMode';

export interface NavChild {
  id: string;
  label: string;
  href: string;
  /** Prefixos de rota que marcam o item como ativo (o mais longo vence). */
  activePrefixes: readonly string[];
  /** Só ativo na rota exata (ex.: lista × subpáginas com item próprio). */
  exact?: boolean;
  badgeKey?: NavBadgeKey;
  flag?: NavFlag;
  /** Story 22.1c — só para quem tem papel `owner` (escondido para `member` e enquanto o papel carrega). */
  ownerOnly?: boolean;
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: NavIcon;
  area: NavArea;
  /** Id do módulo (19.3a). Sem `module` = sempre visível. */
  module?: string;
  activePrefixes: readonly string[];
  exact?: boolean;
  children?: readonly NavChild[];
  badgeKey?: NavBadgeKey;
  flag?: NavFlag;
  /** Oculto do menu (ex.: aguarda outra story), mas registrado. */
  hidden?: boolean;
  /** Motivo de `hidden` (documentação). */
  hiddenReason?: string;
  /** Item oculto que ainda aparece na busca do topo (Story 21.6). */
  searchable?: boolean;
}

export const NAV_AREAS: ReadonlyArray<{ area: NavArea; title: string }> = [
  { area: 'conta', title: 'Conta' },
  { area: 'loja', title: 'Loja' },
];

export const NAV_ITEMS: readonly NavItem[] = [
  // LandingLab standalone: só landings, gerar/clonar e domínios.
  {
    id: 'landinglab',
    label: 'LandingLab',
    href: '/landing-pages',
    icon: 'magic',
    area: 'conta',
    activePrefixes: ['/landing-pages'],
    children: [
      { id: 'landinglab-landings', label: 'Landings', href: '/landing-pages', activePrefixes: ['/landing-pages'] },
      {
        id: 'landinglab-gerar',
        label: 'Gerar ou clonar',
        href: '/landing-pages/new',
        activePrefixes: ['/landing-pages/new'],
      },
      {
        id: 'landinglab-dominios',
        label: 'Domínios',
        href: '/landing-pages/domains',
        activePrefixes: ['/landing-pages/domains'],
      },
    ],
  },
];

/**
 * Rotas que só redirecionam (mantidas para links salvos). Nenhum item de menu
 * nem link interno deve apontar para elas — sempre para o destino canônico.
 */
export const REDIRECT_ONLY_ROUTES: ReadonlyArray<{ pattern: RegExp; route: string; canonical: string }> = [
  {
    pattern: /^\/landing-pages\/(?!new$|domains$)[^/?#]+\/?$/,
    route: '/landing-pages/[id]',
    canonical: '/landing-pages/[id]/editor',
  },
];

export function isRedirectOnlyRoute(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  return REDIRECT_ONLY_ROUTES.some((r) => r.pattern.test(path));
}

// ─── Visibilidade ──────────────────────────────────────────────────────

export interface NavContext {
  storeId: string;
  /** Sobrescreve a leitura das flags (testes). */
  flags?: Partial<Record<NavFlag, boolean>>;
  /** Sobrescreve o seam de módulos (testes). */
  moduleEnabled?: (moduleId: string, storeId: string) => boolean;
  /** Story 22.1c — papel do usuário da sessão (`current-user`); sem papel = itens `ownerOnly` ocultos. */
  role?: string | null;
}

function flagEnabled(flag: NavFlag, ctx: NavContext): boolean {
  const override = ctx.flags?.[flag];
  if (typeof override === 'boolean') return override;
  if (flag === 'skeletonMode') return isSkeletonModeEnabledClient();
  return false;
}

function moduleOn(item: NavItem, ctx: NavContext): boolean {
  if (!item.module) return true;
  const check = ctx.moduleEnabled ?? isModuleEnabled;
  return check(item.module, ctx.storeId);
}

function childVisible(child: NavChild, ctx: NavContext): boolean {
  if (child.flag && !flagEnabled(child.flag, ctx)) return false;
  if (child.ownerOnly && ctx.role !== 'owner') return false;
  return true;
}

/** Itens visíveis no menu: sem `hidden`, com módulo ligado, flags e papel (`ownerOnly`) respeitados. */
export function visibleNavItems(ctx: NavContext, items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items
    .filter((item) => !item.hidden && moduleOn(item, ctx) && (!item.flag || flagEnabled(item.flag, ctx)))
    .map((item) => (item.children ? { ...item, children: item.children.filter((c) => childVisible(c, ctx)) } : item));
}

/**
 * Story 22.1c (U9) — telas de CONTA que não dependem da loja ativa: trocar de loja não remonta a
 * tela (o shell não usa a versão da loja na `key` do conteúdo).
 */
export const STORE_INDEPENDENT_PREFIXES: readonly string[] = ['/settings/conta/usuarios'];

export function isStoreIndependentPath(pathname: string): boolean {
  return STORE_INDEPENDENT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Itens da busca do topo: os visíveis + os ocultos marcados como `searchable` (Story 21.6). */
export function searchableNavItems(ctx: NavContext, items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  const hiddenSearchable = items.filter((item) => item.hidden && item.searchable && moduleOn(item, ctx));
  return [...visibleNavItems(ctx, items), ...hiddenSearchable];
}

// ─── Item ativo ────────────────────────────────────────────────────────

/** Tamanho do prefixo casado (0 = não casa). Prefixos com `?` exigem a query. */
function matchLength(prefix: string, pathname: string, search: string, exact?: boolean): number {
  const [prefixPath = '', prefixQuery] = prefix.split('?');
  if (prefixQuery) {
    const want = new URLSearchParams(prefixQuery);
    const have = new URLSearchParams(search);
    for (const [k, v] of want) if (have.get(k) !== v) return 0;
  }
  const extra = prefixQuery ? prefixQuery.length + 1 : 0;
  if (pathname === prefixPath) return prefixPath.length + 1 + extra;
  if (exact || prefixPath === '/') return 0;
  return pathname.startsWith(`${prefixPath}/`) ? prefixPath.length + extra : 0;
}

export interface ActiveNav {
  itemId: string | null;
  childId: string | null;
}

/** Item (e filho) ativo para a rota atual: vence o prefixo mais longo. */
export function findActiveNav(items: readonly NavItem[], pathname: string, search = ''): ActiveNav {
  let best: ActiveNav = { itemId: null, childId: null };
  let bestLen = 0;
  for (const item of items) {
    const consider = (prefixes: readonly string[], exact: boolean | undefined, childId: string | null): void => {
      for (const p of prefixes) {
        const len = matchLength(p, pathname, search, exact);
        if (len > bestLen) {
          bestLen = len;
          best = { itemId: item.id, childId };
        }
      }
    };
    // Filhos primeiro: em empate com o pai (mesmo prefixo), o filho fica marcado.
    for (const child of item.children ?? []) consider(child.activePrefixes, child.exact, child.id);
    consider(item.activePrefixes, item.exact, null);
  }
  return best;
}

/** Item de primeiro nível (de TODO o registro) dono da rota — usado para o aviso de módulo desligado. */
export function ownerItemForPath(pathname: string, items: readonly NavItem[] = NAV_ITEMS): NavItem | null {
  const { itemId } = findActiveNav(items.filter((i) => !i.hidden), pathname);
  return items.find((i) => i.id === itemId) ?? null;
}

// ─── Lista plana (busca de páginas do painel, testes) ──────────────────

export interface NavLeaf {
  id: string;
  label: string;
  /** "Grupo › Item" (ou só o rótulo, no primeiro nível). */
  qualifiedLabel: string;
  href: string;
  area: NavArea;
}

export function flattenNav(items: readonly NavItem[]): NavLeaf[] {
  const out: NavLeaf[] = [];
  for (const item of items) {
    if (item.children && item.children.length > 0) {
      for (const child of item.children) {
        out.push({
          id: child.id,
          label: child.label,
          qualifiedLabel: `${item.label} › ${child.label}`,
          href: child.href,
          area: item.area,
        });
      }
    } else {
      out.push({ id: item.id, label: item.label, qualifiedLabel: item.label, href: item.href, area: item.area });
    }
  }
  return out;
}

/** Normaliza para busca sem acentos e sem maiúsculas. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Páginas do painel que casam com o termo (itens visíveis do registro). */
export function searchNavPages(items: readonly NavItem[], query: string, limit = 5): NavLeaf[] {
  const q = normalizeSearchText(query);
  if (q.length === 0) return [];
  return flattenNav(items)
    .filter((leaf) => normalizeSearchText(leaf.qualifiedLabel).includes(q))
    .slice(0, limit);
}
