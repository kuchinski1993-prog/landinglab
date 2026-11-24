'use client';

// @ds-migrated — Story 20.2 (AC2/AC3/AC15): menu lateral em dois níveis (Conta × Loja).
//
// Só renderiza o registro (lib/nav/registry.ts). O grupo do item ativo fica
// aberto; nos fechados, a soma dos contadores dos filhos aparece no pai.
// `aria-current="page"` no item ativo; contadores com texto anunciável.

import Link from 'next/link';

import { formatBadge, type NavBadges } from './use-nav-badges';

import { NAV_AREAS, findActiveNav, type NavBadgeKey, type NavItem } from '@/lib/nav/registry';


export interface ShellNavProps {
  items: readonly NavItem[];
  pathname: string;
  search: string;
  badges: NavBadges;
  storeName: string;
  /** Chamado ao escolher um item (o shell fecha o menu no celular). */
  onNavigate?: () => void;
}

/** Texto anunciável do contador (leitor de tela). Story 22.1c: pedidos de acesso têm frase própria. */
export function badgeSpeech(text: string, count: number, key?: NavBadgeKey): string {
  if (key === 'accessRequests') return `, ${text} ${count === 1 ? 'pedido de acesso pendente' : 'pedidos de acesso pendentes'}`;
  return `, ${text} ${count === 1 ? 'novo' : 'novos'}`;
}

function Badge({ count, badgeKey }: { count: number; badgeKey?: NavBadgeKey }): JSX.Element | null {
  const text = formatBadge(count);
  if (!text) return null;
  return (
    <span className="ds-shell-nav__badge">
      <span aria-hidden="true">{text}</span>
      <span className="ds-shell-visually-hidden">{badgeSpeech(text, count, badgeKey)}</span>
    </span>
  );
}

function badgeFor(key: NavBadgeKey | undefined, badges: NavBadges): number {
  return key ? badges[key] ?? 0 : 0;
}

/** Chave única que compõe o contador do pai fechado (para a frase certa); várias = frase genérica. */
function soleBadgeKey(item: NavItem, badges: NavBadges, includeChildren: boolean): NavBadgeKey | undefined {
  const keys = new Set<NavBadgeKey>();
  if (item.badgeKey && badgeFor(item.badgeKey, badges) > 0) keys.add(item.badgeKey);
  if (includeChildren) for (const c of item.children ?? []) if (c.badgeKey && badgeFor(c.badgeKey, badges) > 0) keys.add(c.badgeKey);
  return keys.size === 1 ? [...keys][0] : undefined;
}

export function ShellNav({ items, pathname, search, badges, storeName, onNavigate }: ShellNavProps): JSX.Element {
  const active = findActiveNav(items, pathname, search);

  return (
    <nav className="ds-shell-nav" aria-label="Menu principal" data-testid="shell-nav">
      {NAV_AREAS.map(({ area, title }) => {
        const areaItems = items.filter((i) => i.area === area);
        if (areaItems.length === 0) return null;
        const heading = area === 'loja' ? `${title} · ${storeName}` : title;
        const headingId = `ds-shell-nav-${area}`;
        return (
          <section key={area} className="ds-shell-nav__section" aria-labelledby={headingId}>
            <h2 id={headingId} className="ds-shell-nav__heading" data-testid={`shell-nav-heading-${area}`}>
              {heading}
            </h2>
            <ul className="ds-shell-nav__list">
              {areaItems.map((item) => {
                const isActive = active.itemId === item.id;
                const children = item.children ?? [];
                const expanded = isActive && children.length > 0;
                const parentCurrent = isActive && (children.length === 0 || active.childId === null);
                const collapsedBadge = expanded
                  ? badgeFor(item.badgeKey, badges)
                  : badgeFor(item.badgeKey, badges) + children.reduce((sum, c) => sum + badgeFor(c.badgeKey, badges), 0);
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      className={isActive ? 'ds-shell-nav__link ds-shell-nav__link--active' : 'ds-shell-nav__link'}
                      aria-current={parentCurrent ? 'page' : undefined}
                      onClick={onNavigate}
                      data-nav-id={item.id}
                    >
                      <span className="ds-shell-nav__icon" aria-hidden="true">
                        <s-icon type={item.icon} />
                      </span>
                      <span className="ds-shell-nav__label">{item.label}</span>
                      <Badge count={collapsedBadge} badgeKey={soleBadgeKey(item, badges, !expanded)} />
                    </Link>
                    {expanded ? (
                      <ul className="ds-shell-nav__sublist">
                        {children.map((child) => {
                          const childActive = active.childId === child.id;
                          return (
                            <li key={child.id}>
                              <Link
                                href={child.href}
                                className={
                                  childActive ? 'ds-shell-nav__sublink ds-shell-nav__sublink--active' : 'ds-shell-nav__sublink'
                                }
                                aria-current={childActive ? 'page' : undefined}
                                onClick={onNavigate}
                                data-nav-id={child.id}
                              >
                                <span className="ds-shell-nav__label">{child.label}</span>
                                <Badge count={badgeFor(child.badgeKey, badges)} badgeKey={child.badgeKey} />
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
