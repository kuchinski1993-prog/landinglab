'use client';

// @ds-migrated — Story 20.2 (AC9/AC10): busca do topo do shell.
//
// Resultados reais de produtos, pedidos e landings (GET /search, escopado pela
// loja ativa via X-Store-Id) + páginas do painel (itens visíveis do registro,
// filtrados por módulo). Grupos, clique navega, Enter abre o primeiro (ou o
// destacado), Esc limpa, Ctrl+K/Cmd+K foca. Erro/timeout aparece no próprio
// campo com "Tentar de novo" e não bloqueia o resto do painel.

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { SEARCH_MIN_CHARS, useGlobalSearch, type SearchFetcher } from './use-global-search';

import { searchNavPages, type NavItem } from '@/lib/nav/registry';


export const SEARCH_UNAVAILABLE_MESSAGE = 'Busca indisponível, tente de novo';

const SOURCE_LABELS: Record<string, string> = { products: 'Produtos', orders: 'Pedidos', landings: 'Landings' };

/** Aviso de resultado parcial (fontes que falharam/estouraram o tempo no servidor). */
export function partialSearchMessage(unavailable: readonly string[]): string {
  const names = unavailable.map((u) => SOURCE_LABELS[u] ?? u).join(', ');
  return `Parte da busca não respondeu (${names}) — tente de novo`;
}

interface Option {
  key: string;
  label: string;
  detail?: string | null;
  href: string;
}

interface Group {
  id: string;
  title: string;
  options: Option[];
}

export interface ShellSearchProps {
  navItems: readonly NavItem[];
  fetcher?: SearchFetcher;
  debounceMs?: number;
  timeoutMs?: number;
  /** Loja ativa (+ versão): trocar de loja descarta os resultados anteriores. */
  scopeKey?: string;
}

export function ShellSearch({ navItems, fetcher, debounceMs, timeoutMs, scopeKey }: ShellSearchProps): JSX.Element {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const term = value.trim();
  const { status, data, dataQuery, retry } = useGlobalSearch(value, { fetcher, debounceMs, timeoutMs, scopeKey });

  // Ctrl+K / Cmd+K foca a busca de qualquer lugar.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    if (term.length < SEARCH_MIN_CHARS) return [];
    const out: Group[] = [];
    const pages = searchNavPages(navItems, term);
    if (pages.length > 0) {
      out.push({
        id: 'paginas',
        title: 'Páginas do painel',
        options: pages.map((p) => ({ key: `pagina-${p.id}`, label: p.qualifiedLabel, href: p.href })),
      });
    }
    // Só mostra resultados da API que correspondem ao termo atual.
    if (data && dataQuery === term) {
      if (data.products.length > 0) {
        out.push({
          id: 'produtos',
          title: 'Produtos',
          options: data.products.map((p) => ({ key: `produto-${p.id}`, label: p.title, href: `/products/${p.id}` })),
        });
      }
      if (data.orders.length > 0) {
        out.push({
          id: 'pedidos',
          title: 'Pedidos',
          options: data.orders.map((o) => ({
            key: `pedido-${o.id}`,
            label: o.orderNumber ? `Pedido ${o.orderNumber}` : 'Pedido sem número',
            detail: o.customerEmail,
            href: `/orders/${o.id}`,
          })),
        });
      }
      if (data.landings.length > 0) {
        out.push({
          id: 'landings',
          title: 'Landings',
          options: data.landings.map((l) => ({
            key: `landing-${l.id}`,
            label: l.title,
            detail: l.slug,
            // Destino canônico (/landing-pages/[id] só redireciona para o editor).
            href: `/landing-pages/${l.id}/editor`,
          })),
        });
      }
    }
    return out;
  }, [data, dataQuery, navItems, term]);

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [term, flat.length]);

  function go(option: Option | undefined): void {
    if (!option) return;
    setOpen(false);
    setValue('');
    inputRef.current?.blur();
    router.push(option.href);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (value) {
        setValue('');
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[activeIndex >= 0 ? activeIndex : 0]);
      return;
    }
    if (e.key === 'ArrowDown' && flat.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % flat.length);
      return;
    }
    if (e.key === 'ArrowUp' && flat.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? flat.length - 1 : i - 1));
    }
  }

  const showPanel = open && term.length >= SEARCH_MIN_CHARS;
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  const unavailable =
    status === 'success' && data && dataQuery === term && Array.isArray(data.unavailable) ? data.unavailable : [];
  const partial = unavailable.length > 0;
  const noResults = status === 'success' && flat.length === 0 && !partial;
  let index = -1;

  return (
    <div className="ds-shell-search" ref={rootRef}>
      <span className="ds-shell-search__icon" aria-hidden="true">
        <s-icon type="search" />
      </span>
      <input
        ref={inputRef}
        type="search"
        className="ds-shell-search__input"
        placeholder="Pesquisar"
        aria-label="Pesquisar no painel (Ctrl+K)"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        data-testid="shell-search-input"
      />
      <kbd className="ds-shell-search__kbd" aria-hidden="true">
        Ctrl K
      </kbd>
      <div
        id={listId}
        role="listbox"
        aria-label="Resultados da busca"
        className="ds-shell-popover ds-shell-search__panel"
        hidden={!showPanel}
        data-testid="shell-search-panel"
      >
        {showPanel ? (
          <>
            {groups.map((group) => (
              <div key={group.id} role="group" aria-label={group.title} className="ds-shell-search__group">
                <p className="ds-shell-popover__title" aria-hidden="true">
                  {group.title}
                </p>
                {group.options.map((option) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={option.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === activeIndex}
                      className={i === activeIndex ? 'ds-shell-search__option ds-shell-search__option--active' : 'ds-shell-search__option'}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        go(option);
                      }}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <span className="ds-shell-search__label">{option.label}</span>
                      {option.detail ? <span className="ds-shell-search__detail">{option.detail}</span> : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {status === 'loading' ? (
              <p className="ds-shell-popover__hint" aria-live="polite">
                Buscando…
              </p>
            ) : null}
            {status === 'error' ? (
              <div className="ds-shell-search__error" role="alert">
                <span>{SEARCH_UNAVAILABLE_MESSAGE}</span>
                <button
                  type="button"
                  className="ds-shell-button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    retry();
                    inputRef.current?.focus();
                  }}
                >
                  Tentar de novo
                </button>
              </div>
            ) : null}
            {partial ? (
              <div className="ds-shell-search__error" role="alert" data-testid="shell-search-partial">
                <span>{partialSearchMessage(unavailable)}</span>
                <button
                  type="button"
                  className="ds-shell-button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    retry();
                    inputRef.current?.focus();
                  }}
                >
                  Tentar de novo
                </button>
              </div>
            ) : null}
            {noResults ? (
              <p className="ds-shell-popover__hint" role="status">
                Nada encontrado para “{term}”
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
