'use client';

// @ds-migrated — Story 20.2: moldura nova do painel (topo + menu Conta × Loja).
//
// • Menu: só o registro (lib/nav/registry.ts), filtrado por módulo/flag.
// • Topo: logo, seletor de loja, busca e menu do usuário.
// • Celular (≤ 768 px): botão abre/fecha o menu; fecha por Esc, clique fora,
//   botão ou ao escolher um item; o foco volta para o botão.
// • Troca de loja: a tela é remontada (`key`) e busca os dados de novo.
// • Rota de módulo desligado: "Módulo não habilitado para esta loja".
// • Módulos da loja (19.3a): carrega GET /stores/:id/modules ao trocar de loja;
//   enquanto carrega ou se falhar vale "tudo ligado" e, na falha, aparece um
//   aviso discreto com "Tentar de novo".
// • Usuário (22.1b): 1 GET /auth/me (current-user.tsx) → nome real no menu e faixa de emergência.
// • Papel (22.1c): itens `ownerOnly` (Usuários), contador e faixa de pedidos de acesso só para owner;
//   telas de conta independentes da loja (isStoreIndependentPath) não remontam ao trocar de loja.
// • Script do Polaris 2 falhou: aviso com "Tentar de novo" (o menu e as telas
//   em Polaris React continuam funcionando — a moldura é HTML próprio).
//
// O conteúdo (telas ainda em Polaris React) chega em `children` e não é
// alterado aqui.

import '@/styles/shell.css';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { AccessRequestsBanner } from './AccessRequestsBanner';
import { ACTIVE_STORE_UNAVAILABLE_MESSAGE, ActiveStoreProvider, useActiveStore } from './active-store';
import { CurrentUserProvider, useCurrentUser } from './current-user';
import { LegacyBanner } from './LegacyBanner';
import { ShellNav } from './ShellNav';
import type { SearchFetcher } from './use-global-search';
import { useNavBadges } from './use-nav-badges';
import { UserMenu } from './UserMenu';

import { Logo } from '@/components/Logo';
import { StoreSwitcher } from '@/components/StoreSwitcher';
import { POLARIS_WC_TIMEOUT_MS, reloadPolarisScript, waitForPolaris } from '@/components/ds/polaris-loader';
import { apiClient } from '@/lib/api-client';
import { MODULE_DISABLED_MESSAGE, isModuleEnabled } from '@/lib/nav/modules';
import {
  MODULES_LOAD_FAILED_MESSAGE,
  loadStoreModules,
  useStoreModulesSnapshot,
  type StoreModulesFetcher,
} from '@/lib/nav/modules-store';
import {
  isStoreIndependentPath,
  ownerItemForPath,
  visibleNavItems,
  type NavContext,
} from '@/lib/nav/registry';

export const MOBILE_QUERY = '(max-width: 768px)';
/**
 * Story 20.14a — tema escuro parcial do Polaris 2 (Web Components, o DS das telas migradas; não é
 * Tailwind nem Polaris React). Aplicado só na moldura preta (cabeçalho e menu): os `s-icon` (Shadow
 * DOM, cor por token próprio com sufixo de versão — não herdam `color`) passam a usar o ícone claro
 * do tema. Popovers/diálogo do cabeçalho não têm `s-*` e usam só tokens `--ds-shell-*`.
 */
export const POLARIS_WC_DARK_THEME = 'p-partial-theme-admin-next-dark';
export const WC_FAILED_MESSAGE = 'O visual novo do painel não carregou. O menu e as telas continuam funcionando.';

export interface AppShellProps {
  children: ReactNode;
  /** Testes: troca o seam de módulos / flags e a busca. */
  navContext?: Omit<NavContext, 'storeId'>;
  searchFetcher?: SearchFetcher;
  /** Testes: troca a leitura de GET /stores/:id/modules. */
  modulesFetcher?: StoreModulesFetcher;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = (): void => setMobile(Boolean(mql.matches));
    update();
    mql.addEventListener?.('change', update);
    return () => mql.removeEventListener?.('change', update);
  }, []);
  return mobile;
}

/** Lê a query string (precisa de Suspense no App Router) e repassa ao shell. */
function SearchParamsBridge({ onChange }: { onChange: (search: string) => void }): null {
  const params = useSearchParams();
  const search = params?.toString() ?? '';
  useEffect(() => {
    onChange(search);
  }, [onChange, search]);
  return null;
}

export function AppShell(props: AppShellProps): JSX.Element {
  return (
    <ActiveStoreProvider>
      {/* Story 22.1b — usuário real da sessão (1 GET /auth/me) para o menu e a faixa de emergência. */}
      <CurrentUserProvider>
        <ShellFrame {...props} />
      </CurrentUserProvider>
    </ActiveStoreProvider>
  );
}

function ShellFrame({ children, navContext, modulesFetcher }: AppShellProps): JSX.Element {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const store = useActiveStore();
  const { activeId, activeName, storeVersion, notice, dismissNotice, applyDeepLink, activeUnavailable, selectDefaultStore } = store;
  const [search, setSearch] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [wcStatus, setWcStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [wcAttempt, setWcAttempt] = useState(0);
  const isMobile = useIsMobile();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const currentUser = useCurrentUser();
  const role = currentUser.status === 'ready' ? (currentUser.user?.role ?? null) : null;
  const badges = useNavBadges(pathname, { owner: role === 'owner' });

  // Módulos da loja ativa (19.3a): recarrega a cada troca de loja; a resposta de
  // uma loja anterior ainda em voo é descartada pelo modules-store.
  const modules = useStoreModulesSnapshot();
  const modulesFetcherRef = useRef(modulesFetcher);
  modulesFetcherRef.current = modulesFetcher;
  const reloadModules = useCallback(() => {
    void loadStoreModules(activeId, modulesFetcherRef.current);
  }, [activeId]);
  useEffect(() => {
    reloadModules();
  }, [reloadModules]);
  const modulesOfActive = modules.storeId === activeId;
  // Muda só quando o conjunto de desligados da loja ativa muda ('' = nenhum).
  const modulesKey = modulesOfActive ? modules.signature : '';

  const ctx: NavContext = useMemo(() => ({ storeId: activeId, role, ...navContext }), [activeId, role, navContext]);
  // modulesKey entra nas dependências: invalida o resultado quando o cache lido por isModuleEnabled muda.
  const items = useMemo(() => visibleNavItems(ctx), [ctx, modulesKey]);

  // Rota direta de módulo desligado → aviso em vez de erro/tela vazia.
  const owner = ownerItemForPath(pathname);
  const moduleCheck = navContext?.moduleEnabled ?? isModuleEnabled;
  const moduleDisabled = Boolean(owner?.module && !moduleCheck(owner.module, activeId));

  // Deep link ?loja=<id>: valida, grava o cookie (se válido) e limpa a URL.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const loja = params.get('loja');
    if (!loja) return;
    const result = applyDeepLink(loja);
    if (result === 'pending') return;
    params.delete('loja');
    const rest = params.toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [applyDeepLink, pathname, router, search]);

  // Script do Polaris 2 (ícones e telas migradas): falha vira aviso, nunca tela branca.
  useEffect(() => {
    const { promise, cancel } = waitForPolaris(POLARIS_WC_TIMEOUT_MS);
    let alive = true;
    void promise.then((ok) => {
      if (alive) setWcStatus(ok ? 'ready' : 'failed');
    });
    return () => {
      alive = false;
      cancel();
    };
  }, [wcAttempt]);

  const closeNav = useCallback((returnFocus = true) => {
    setNavOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }, []);

  // Fecha o menu do celular ao mudar de rota (ex.: navegação pela busca).
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Esc fecha o menu do celular.
  useEffect(() => {
    if (!navOpen) return undefined;
    function onKeyDown(e: KeyboardEvent): void {
      // Esc já tratado por outro controle (busca, seletor, diálogo) não fecha o menu.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (target?.closest?.('.ds-shell-search, .ds-shell-store, .ds-shell-user, .ds-shell-dialog__backdrop')) return;
      closeNav();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navOpen, closeNav]);

  // Ao abrir no celular, foco no primeiro item do menu.
  useEffect(() => {
    if (navOpen && isMobile) navRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
  }, [navOpen, isMobile]);

  // Menu fechado no celular sai da ordem de tabulação.
  const navHidden = isMobile && !navOpen;
  useEffect(() => {
    const el = navRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (el) el.inert = navHidden;
  }, [navHidden]);

  async function handleLogout(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } catch {
      // redireciona mesmo assim se o cookie já sumiu
    }
    router.push('/login');
    router.refresh();
  }

  const shellClass = navOpen ? 'ds-shell ds-shell--nav-open' : 'ds-shell';

  return (
    <div className={shellClass} data-wc-status={wcStatus}>
      {/* Story 20.14a — moldura decorativa (cantos arredondados do painel); sem clique nem foco. */}
      <div className="ds-shell-frame" aria-hidden="true" data-testid="shell-frame" />
      <Suspense fallback={null}>
        <SearchParamsBridge onChange={setSearch} />
      </Suspense>
      <a className="ds-shell-skip" href="#ds-shell-content">
        Pular para o conteúdo
      </a>

      <header className={`ds-shell-topbar ${POLARIS_WC_DARK_THEME}`} data-testid="shell-topbar">
        <button
          ref={toggleRef}
          type="button"
          className="ds-shell-topbar__toggle"
          aria-label={navOpen ? 'Fechar menu' : 'Abrir menu'}
          aria-expanded={navOpen}
          aria-controls="ds-shell-nav"
          onClick={() => (navOpen ? closeNav() : setNavOpen(true))}
          data-testid="shell-nav-toggle"
        >
          {/* SVG inline (não depende do CDN do Polaris 2). */}
          <svg className="ds-shell-topbar__toggle-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
            {navOpen ? (
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <Link href="/" className="ds-shell-topbar__logo" aria-label="LandingLab — Início">
          <span className="ds-shell-topbar__logo-full">
            <Logo variant="full" tone="light" height={22} />
          </span>
          <span className="ds-shell-topbar__logo-mark">
            <Logo variant="mark" tone="light" height={24} />
          </span>
        </Link>
        <StoreSwitcher />
        <UserMenu onLogout={() => void handleLogout()} />
      </header>

      {navOpen ? (
        <div
          className="ds-shell-backdrop"
          data-testid="shell-nav-backdrop"
          aria-hidden="true"
          onClick={() => closeNav()}
        />
      ) : null}

      <div
        id="ds-shell-nav"
        ref={navRef}
        className={`ds-shell-sidebar ${POLARIS_WC_DARK_THEME}`}
        aria-hidden={navHidden ? true : undefined}
        data-open={navOpen ? 'true' : 'false'}
      >
        <ShellNav
          items={items}
          pathname={pathname}
          search={search}
          badges={badges}
          storeName={activeName}
          onNavigate={() => {
            if (navOpen) closeNav();
          }}
        />
      </div>

      <main id="ds-shell-content" className="ds-shell-main" tabIndex={-1}>
        <LegacyBanner />
        <AccessRequestsBanner count={badges.accessRequests} pathname={pathname} />
        {wcStatus === 'failed' ? (
          <div className="ds-shell-notice ds-shell-notice--warning" role="alert" data-testid="shell-wc-error">
            <span>{WC_FAILED_MESSAGE}</span>
            <button
              type="button"
              className="ds-shell-button"
              onClick={() => {
                reloadPolarisScript();
                setWcStatus('loading');
                setWcAttempt((n) => n + 1);
              }}
            >
              Tentar de novo
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="ds-shell-notice ds-shell-notice--critical" role="alert" data-testid="shell-store-notice">
            <span>{notice}</span>
            {activeUnavailable && notice === ACTIVE_STORE_UNAVAILABLE_MESSAGE ? (
              // Story 17.2a · loja ativa indisponível: troca só com este clique.
              <button type="button" className="ds-shell-button" onClick={selectDefaultStore} data-testid="shell-use-default-store">
                Usar a loja padrão
              </button>
            ) : (
              <button type="button" className="ds-shell-button" onClick={dismissNotice}>
                Fechar aviso
              </button>
            )}
          </div>
        ) : null}
        {modulesOfActive && modules.status === 'error' ? (
          <div className="ds-shell-notice ds-shell-notice--warning" role="status" data-testid="shell-modules-error">
            <span>{MODULES_LOAD_FAILED_MESSAGE}</span>
            <button type="button" className="ds-shell-button" onClick={reloadModules}>
              Tentar de novo
            </button>
          </div>
        ) : null}
        {/* Remonta a tela quando os módulos desligados da loja mudam (a home lê isModuleEnabled no render). */}
        {/* Story 22.1c (U9) — tela de conta independente da loja: trocar de loja não remonta. */}
        <div
          key={isStoreIndependentPath(pathname) ? 'store-independent' : `${storeVersion}:${modulesKey}`}
          className="ds-shell-main__content"
        >
          {moduleDisabled ? (
            <div className="ds-shell-module-off" role="status" data-testid="shell-module-disabled">
              <h1 className="ds-shell-module-off__title">{MODULE_DISABLED_MESSAGE}</h1>
              <p className="ds-shell-module-off__text">
                {`${owner?.label ?? 'Este módulo'} está desligado para a loja ${activeName}. Escolha outra loja no topo ou volte para o Início.`}
              </p>
              <Link href="/" className="ds-shell-button">
                Ir para o Início
              </Link>
            </div>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}
