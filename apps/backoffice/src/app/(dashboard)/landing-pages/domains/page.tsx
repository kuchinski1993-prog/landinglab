'use client';

// @ds-migrated — Story 20.10c (PR B): Domínios (`/landing-pages/domains`) no design system.
//
// /landing-pages/domains — gerenciador de domínios (Fase 5.D).
// Lista domínios cadastrados + status DNS/SSL + count de landings + tags.
// Filtros por função, tag, busca.
//
// Só visual: `listDomains`/`listUsedTags`, as rotas `/api/domains/**` (remover, status, SSL, renovar),
// a leitura das respostas (`readDomainResponse`/`describeDomainError`), a pilha de erros persistentes
// (18.10a) e a compra (`PurchaseDomainModal`, 18.10b/d/e) são as de antes. Mudou: título e as duas ações
// na mesma linha (`DsPageHeader`), lista em `s-table` com a linha clicável (`useRowLink`: clique simples
// pelo router, Ctrl/Cmd/Shift/botão do meio em nova aba), filtro por função como grupo de botões
// (mesmos rótulos das abas; sem contador: a contagem por função pediria chamadas novas), tag em
// `DsSelect`, busca em `DsSearchField`, avisos de sucesso `polite` no lugar do Toast, modais `DsModal`.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import PurchaseDomainModal from './PurchaseDomainModal';
import { DomainErrorBanner } from './_components/DomainErrorBanner';
import { readDomainResponse } from './_lib/domain-response';

import {
  ActionFeedback,
  ConfirmModal,
  DsButton,
  DsModal,
  DsNumberField,
  DsPageHeader,
  DsSearchField,
  DsSelect,
  DsTextArea,
  DsTextField,
  DsWidePage,
  EmptyBlock,
  ErrorBanner,
  PolarisGate,
  StateBoundary,
  isModifiedClick,
  useActionFeedback,
  useRowLink,
} from '@/components/ds';
import { ApiError } from '@/lib/api-client';
import {
  addDomain,
  listDomains,
  listUsedTags,
  type DomainRole,
  type DomainSummary,
} from '@/lib/domain-actions';

type RoleFilter = DomainRole | 'all';

const ROLE_TABS: Array<{ id: RoleFilter; content: string }> = [
  { id: 'all', content: 'Todos' },
  { id: 'active', content: 'Ativos' },
  { id: 'reserve', content: 'Reserva' },
  { id: 'blocked', content: 'Bloqueados' },
  { id: 'pending_dns', content: 'Pendente DNS' },
];

type BadgeTone = 'success' | 'info' | 'critical' | 'warning' | 'caution' | 'neutral';

// Mesmos tons de antes (o "attention" do Polaris React é o "caution" do DS).
const ROLE_TONE: Record<DomainRole, BadgeTone> = {
  active: 'success',
  reserve: 'info',
  blocked: 'critical',
  pending_dns: 'warning',
  disabled: 'caution',
};

// Story 18.10a (AC10): erros de ação ficam no topo até serem dispensados (no máximo 3, o mais novo
// em cima), com "Tentar de novo" da MESMA ação sobre o MESMO domínio. Sucesso/progresso: aviso polite.
const MAX_ACTION_ERRORS = 3;
const LOAD_FALLBACK = 'Não foi possível carregar os domínios. Tente de novo em instantes.';
const LIST_HREF = '/landing-pages';

interface ActionError {
  id: number;
  error: unknown;
  title: string;
  retryLabel: string;
  retry: () => void;
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

const ROLE_LABEL: Record<DomainRole, string> = {
  active: 'Ativo',
  reserve: 'Reserva',
  blocked: 'Bloqueado',
  pending_dns: 'DNS pendente',
  disabled: 'Desativado',
};

const detailHref = (id: string): string => `/landing-pages/domains/${id}`;

function BackLink(): JSX.Element {
  const router = useRouter();
  return (
    <s-link
      href={LIST_HREF}
      onClick={(event) => {
        if (isModifiedClick(event as unknown as MouseEvent)) return;
        event.preventDefault();
        router.push(LIST_HREF);
      }}
    >
      Landing Pages
    </s-link>
  );
}

export default function DomainsPage(): JSX.Element {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<RoleFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  // Story 20.10c (Decisão 6): o que era Toast (sucesso/progresso) vira aviso `polite` do DS — mesmos
  // textos; '' fecha. Os erros continuam na pilha persistente (`actionErrors`).
  const feedback = useActionFeedback();
  const { success: showSuccess, dismiss: hideSuccess } = feedback;
  const setToast = useCallback((message: string) => (message ? showSuccess(message) : hideSuccess()), [showSuccess, hideSuccess]);
  const [deleteTarget, setDeleteTarget] = useState<DomainSummary | null>(null);
  const [renewTarget, setRenewTarget] = useState<DomainSummary | null>(null);
  const [isMutating, startTransition] = useTransition();
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [actionErrors, setActionErrors] = useState<ActionError[]>([]);
  const [sslVerifying, setSslVerifying] = useState<ReadonlySet<string>>(() => new Set());
  const sslInFlightRef = useRef(new Set<string>());
  const controllersRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const actionErrorSeqRef = useRef(0);
  const actionErrorsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    return () => {
      // Sair da tela aborta as esperas (re-verificar SSL pode levar minutos) e nada mais atualiza estado.
      mountedRef.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const [ds, ts] = await Promise.all([
        listDomains({
          role,
          q: query || undefined,
          tag: selectedTag ?? undefined,
        }),
        listUsedTags(),
      ]);
      if (seq !== loadSeqRef.current || !mountedRef.current) return;
      setDomains(ds);
      setTags(ts);
      setLoadError(null);
      setLoadedOnce(true);
    } catch (err) {
      if (seq !== loadSeqRef.current || !mountedRef.current) return;
      // A lista anterior fica; na primeira carga, o aviso ocupa o lugar da lista (nunca o vazio).
      setLoadError(err ?? new Error('load_failed'));
    } finally {
      if (seq === loadSeqRef.current && mountedRef.current) setLoading(false);
    }
  }, [role, query, selectedTag]);

  const pushActionError = useCallback((entry: Omit<ActionError, 'id'>) => {
    if (!mountedRef.current) return;
    const id = ++actionErrorSeqRef.current;
    setActionErrors((prev) => [{ ...entry, id }, ...prev].slice(0, MAX_ACTION_ERRORS));
  }, []);

  const dismissActionError = useCallback((id: number) => {
    setActionErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const newestErrorId = actionErrors[0]?.id;
  useEffect(() => {
    // Foco no aviso quando uma ação do usuário falha (leitor de tela e teclado).
    if (newestErrorId !== undefined) actionErrorsRef.current?.focus();
  }, [newestErrorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteDomain = useCallback((target: DomainSummary) => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/domains/${target.id}`, {
          method: 'DELETE',
        });
        await readDomainResponse<{ ok: boolean }>(res);
        if (!mountedRef.current) return;
        setToast(`Domínio "${target.domain}" removido.`);
        setDeleteTarget(null);
        void load();
      } catch (err) {
        if (!mountedRef.current) return;
        // O modal fecha para o aviso (no topo) ficar visível; o retry refaz a remoção já confirmada.
        // 409 = domínio em uso → o aviso mantém "Abra Gerenciar pra desvincular".
        setDeleteTarget(null);
        pushActionError({
          error: err,
          title: `Não foi possível remover ${target.domain}`,
          retryLabel: `Tentar de novo: remover domínio ${target.domain}`,
          retry: () => deleteDomain(target),
        });
      }
    });
  }, [load, pushActionError, setToast]);

  const confirmDelete = useCallback(() => {
    if (deleteTarget) deleteDomain(deleteTarget);
  }, [deleteTarget, deleteDomain]);

  const checkStatus = useCallback(async (d: DomainSummary): Promise<void> => {
    setToast(`Verificando ${d.domain}…`);
    try {
      const res = await fetch(`/api/domains/${d.id}/status`);
      const { data } = await readDomainResponse<{
        ok: boolean;
        message?: string;
        dnsVerified?: boolean;
        sslProvisioned?: boolean;
        reason?: string | null;
      }>(res);
      if (!mountedRef.current) return;
      if (data.dnsVerified) {
        setToast(`${d.domain}: DNS + SSL OK.`);
      } else {
        const reason = data.reason === 'dns_misconfigured'
          ? 'DNS mal configurado'
          : data.reason === 'awaiting_ssl_challenge'
            ? 'aguardando SSL'
            : 'não verificado';
        setToast(`${d.domain}: ${reason}.`);
      }
      void load();
    } catch (err) {
      if (!mountedRef.current) return;
      setToast('');
      pushActionError({
        error: err,
        title: `Não foi possível verificar ${d.domain}`,
        retryLabel: `Tentar de novo: verificar domínio ${d.domain}`,
        retry: () => void checkStatus(d),
      });
    }
  }, [load, pushActionError, setToast]);

  // Task #37 — re-trigger SSL poll manual pra domínios pending.
  // Endpoint faz 10×30s de polling, então UI mostra "processando" durante.
  // Story 18.10a (AC11): um POST por domínio por vez; sair da tela aborta a espera.
  const reVerifySsl = useCallback(async (d: DomainSummary): Promise<void> => {
    if (sslInFlightRef.current.has(d.id)) return;
    sslInFlightRef.current.add(d.id);
    setSslVerifying(new Set(sslInFlightRef.current));
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setToast(`Re-verificando SSL de ${d.domain}… (pode levar até 5min)`);
    try {
      const res = await fetch(`/api/domains/${d.id}/ssl/re-verify`, {
        method: 'POST',
        signal: controller.signal,
      });
      const { data } = await readDomainResponse<{
        ok: boolean;
        message?: string;
        sslStatus?: 'provisioned' | 'pending';
        pollAttempts?: number | null;
        hint?: string;
      }>(res);
      if (!mountedRef.current) return;
      if (data.sslStatus === 'provisioned') {
        setToast(`SSL ativo em ${d.domain}.`);
      } else {
        // 202 → pending: mostra hint do endpoint.
        setToast(`${d.domain}: ${data.message ?? 'SSL ainda pendente.'}`);
      }
      void load();
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err) || !mountedRef.current) return;
      setToast('');
      pushActionError({
        error: err,
        title: `Não foi possível re-verificar o SSL de ${d.domain}`,
        retryLabel: `Tentar de novo: re-verificar SSL de ${d.domain}`,
        retry: () => void reVerifySsl(d),
      });
    } finally {
      controllersRef.current.delete(controller);
      sslInFlightRef.current.delete(d.id);
      if (mountedRef.current) setSslVerifying(new Set(sslInFlightRef.current));
    }
  }, [load, pushActionError, setToast]);


  const tagOptions = [{ value: '', label: 'Todas as tags' }, ...tags.map((t) => ({ value: t, label: t }))];

  let content: JSX.Element;
  if (loading && !loadedOnce) {
    content = <StateBoundary status="loading" loadingLabel="Carregando domínios" loadingLines={5} />;
  } else if (loadError && !loadedOnce) {
    content = (
      <DomainLoadError title="Não foi possível carregar os domínios" error={loadError} onRetry={() => void load()} />
    );
  } else if (domains.length === 0) {
    content = (
      <EmptyBlock
        heading="Nenhum domínio cadastrado"
        action={
          <DsButton variant="secondary" onClick={() => setAddOpen(true)}>
            Adicionar primeiro domínio
          </DsButton>
        }
      >
        Adicione domínios próprios pra publicar suas landings em URLs personalizadas.
      </EmptyBlock>
    );
  } else {
    content = (
      <s-section padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Domínio</s-table-header>
            <s-table-header>Função</s-table-header>
            <s-table-header>Registro</s-table-header>
            <s-table-header>Tags</s-table-header>
            <s-table-header>Ações</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {domains.map((d) => (
              <DomainRow
                key={d.id}
                domain={d}
                onDelete={setDeleteTarget}
                onRenew={setRenewTarget}
                onCheckStatus={checkStatus}
                onReVerifySsl={reVerifySsl}
                sslVerifying={sslVerifying.has(d.id)}
              />
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    );
  }

  return (
    <PolarisGate>
      <DsWidePage>
        <DsPageHeader
          title="Domínios"
          breadcrumb={<BackLink />}
          primaryAction={
            <DsButton variant="primary" onClick={() => setPurchaseOpen(true)}>
              Comprar via Spaceship
            </DsButton>
          }
          secondaryActions={
            <DsButton variant="secondary" onClick={() => setAddOpen(true)}>
              Adicionar já comprado
            </DsButton>
          }
        />
        <s-stack gap="base">
          <s-paragraph color="subdued">Gerencie domínios próprios usados nas landings publicadas</s-paragraph>

          {actionErrors.length > 0 ? (
            // Foco no aviso quando uma ação falha (leitor de tela e teclado); contorno de foco do contêiner desligado como antes.
            <div ref={actionErrorsRef} tabIndex={-1} className="ds-focus-container">
              <s-stack gap="small-200">
                {actionErrors.map((entry) => (
                  <DomainErrorBanner
                    key={entry.id}
                    title={entry.title}
                    error={entry.error}
                    retryLabel={entry.retryLabel}
                    onRetry={() => {
                      dismissActionError(entry.id);
                      entry.retry();
                    }}
                    onDismiss={() => dismissActionError(entry.id)}
                  />
                ))}
              </s-stack>
            </div>
          ) : null}

          {/* Montado só com mensagem: sem região de alerta vazia na tela (a pilha de erros acima tem a dela). */}
          {feedback.feedback ? <ActionFeedback feedback={feedback.feedback} onDismiss={feedback.dismiss} /> : null}

          {loadError && loadedOnce ? (
            <DomainLoadError title="Não foi possível atualizar a lista de domínios" error={loadError} onRetry={() => void load()} />
          ) : null}

          <s-section>
            <s-stack gap="base">
              <s-query-container>
                <s-grid gridTemplateColumns={tags.length > 0 ? '@container (inline-size > 640px) 2fr 1fr, 1fr' : '1fr'} gap="base" alignItems="end">
                  <DsSearchField
                    id="domains-search"
                    label="Buscar domínios"
                    labelHidden
                    placeholder="Buscar por domínio ou apelido..."
                    value={query}
                    onChange={setQuery}
                  />
                  {tags.length > 0 && (
                    <DsSelect
                      id="domains-tag"
                      label="Tag"
                      value={selectedTag ?? ''}
                      options={tagOptions}
                      onChange={(v) => setSelectedTag(v || null)}
                    />
                  )}
                </s-grid>
              </s-query-container>
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <div role="group" aria-label="Filtrar por função">
                  <s-stack direction="inline" gap="small-200">
                    {ROLE_TABS.map((t) => (
                      <s-clickable-chip
                        key={t.id}
                        color={role === t.id ? 'strong' : 'base'}
                        aria-pressed={role === t.id}
                        data-role={t.id}
                        onClick={() => setRole(t.id)}
                      >
                        {t.content}
                      </s-clickable-chip>
                    ))}
                  </s-stack>
                </div>
                <div className="ds-live-region" role="status" aria-live="polite" data-testid="domains-count">
                  {loadedOnce && !loading && domains.length > 0 ? (
                    <s-text color="subdued">{domains.length === 1 ? '1 domínio' : `${domains.length} domínios`}</s-text>
                  ) : null}
                </div>
              </s-stack>
            </s-stack>
          </s-section>

          {content}
        </s-stack>
      </DsWidePage>

      {addOpen && (
        <AddDomainModal
          onClose={() => setAddOpen(false)}
          onSuccess={() => {
            setAddOpen(false);
            setToast('Domínio adicionado.');
            void load();
          }}
        />
      )}

      {purchaseOpen && (
        <PurchaseDomainModal
          onClose={() => {
            // Story 18.10b (AC5): fechar o modal recarrega a lista (compra com resposta perdida).
            setPurchaseOpen(false);
            void load();
          }}
          onSuccess={(result) => {
            setPurchaseOpen(false);
            setToast(`${result.domain} comprado com sucesso!`);
            void load();
          }}
        />
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title={`Remover ${deleteTarget?.domain ?? ''}?`}
        confirmLabel="Remover"
        destructive
        loading={isMutating}
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      >
        <s-paragraph>
          Remove o domínio{' '}
          <s-text type="strong" fontWeight="bold">
            {deleteTarget?.domain ?? ''}
          </s-text>{' '}
          do cadastro e desanexa do projeto Vercel. Não cancela a compra no Spaceship — o domínio permanece na sua
          conta até expirar. Se houver landings usando este domínio, remova os vínculos primeiro.
        </s-paragraph>
      </ConfirmModal>

      {renewTarget && (
        <RenewDomainModal
          domain={renewTarget}
          onClose={() => setRenewTarget(null)}
          onSuccess={(newExpiresAt) => {
            setToast(`${renewTarget.domain} renovado até ${new Date(newExpiresAt).toLocaleDateString('pt-BR')}.`);
            setRenewTarget(null);
            void load();
          }}
        />
      )}
    </PolarisGate>
  );
}

function DomainLoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }): JSX.Element {
  // Falha de carga: mensagem pelo erro (nunca o texto cru); sem status/código, o texto padrão da carga.
  return <ErrorBanner title={title} error={error} fallbackMessage={LOAD_FALLBACK} onRetry={onRetry} />;
}

// ─── DomainRow ─────────────────────────────────────────────────────────

function DomainRow({
  domain,
  onDelete,
  onRenew,
  onCheckStatus,
  onReVerifySsl,
  sslVerifying,
}: {
  domain: DomainSummary;
  onDelete: (d: DomainSummary) => void;
  onRenew: (d: DomainSummary) => void;
  onCheckStatus: (d: DomainSummary) => void | Promise<void>;
  onReVerifySsl: (d: DomainSummary) => void | Promise<void>;
  sslVerifying: boolean;
}): JSX.Element {
  const router = useRouter();
  const linkRef = useRef<HTMLElementTagNameMap['s-link']>(null);
  const href = detailHref(domain.id);
  useRowLink(linkRef, () => router.push(href));

  // Task #37 — botão só aparece pra Spaceship pending (role=pending_dns
  // OU dnsVerifiedAt=null). Manual/porkbun não usa nosso pipeline SSL.
  const canReVerifySsl =
    domain.registrar === 'spaceship' &&
    (domain.role === 'pending_dns' || domain.dnsVerifiedAt === null);
  const expiringDays = domain.expiresAt
    ? Math.floor(
        (new Date(domain.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      )
    : null;
  const isExpiring = expiringDays !== null && expiringDays <= 30 && expiringDays >= 0;
  const isExpired = expiringDays !== null && expiringDays < 0;

  return (
    <s-table-row clickDelegate={`domain-link-${domain.id}`}>
      <s-table-cell>
        <div className="ds-domain-cell">
          {domain.nickname && <s-text color="subdued">{domain.nickname}</s-text>}
          <s-link id={`domain-link-${domain.id}`} ref={linkRef} href={href} tone="neutral" accessibilityLabel={`Gerenciar ${domain.domain}`}>
            <s-text type="strong" fontWeight="bold">
              {domain.domain}
            </s-text>
          </s-link>
          {domain.notes && (
            <span className="ds-clamp-2">
              <s-text color="subdued">{domain.notes.length > 80 ? `${domain.notes.slice(0, 77)}...` : domain.notes}</s-text>
            </span>
          )}
        </div>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={ROLE_TONE[domain.role]}>{ROLE_LABEL[domain.role]}</s-badge>
      </s-table-cell>
      <s-table-cell>
        {/* Como no cartão de antes: nº de landings junto do registrar, SSL e expiração. */}
        <s-stack direction="inline" gap="small-200">
          <s-badge tone="info">{`${domain.landingsCount} landing${domain.landingsCount !== 1 ? 's' : ''}`}</s-badge>
          {domain.registrar && <s-badge tone={domain.registrar === 'spaceship' ? 'success' : 'caution'}>{domain.registrar}</s-badge>}
          {domain.vercelDomainStatus === 'valid' && <s-badge tone="success">SSL</s-badge>}
          {isExpired && <s-badge tone="critical">Expirado</s-badge>}
          {isExpiring && !isExpired && <s-badge tone="warning">{`Expira em ${expiringDays}d`}</s-badge>}
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <span className="ds-cell-wrap ds-domain-tags">
          {domain.tags.length > 0 ? (
            <s-stack direction="inline" gap="small-200">
              {domain.tags.map((tag) => (
                <s-badge key={tag} tone="neutral">{`#${tag}`}</s-badge>
              ))}
            </s-stack>
          ) : (
            <s-text color="subdued">—</s-text>
          )}
        </span>
      </s-table-cell>
      <s-table-cell>
        {/* Ações em grade de 2 colunas: cabem na coluna sem empurrar a tabela para fora (medido em 1280). */}
        <s-grid gridTemplateColumns="auto auto" gap="small-300" justifyContent="end">
          <DsButton variant="tertiary" href={href} accessibilityLabel={`Gerenciar ${domain.domain}`}>
            Gerenciar
          </DsButton>
          <DsButton variant="tertiary" onClick={() => void onCheckStatus(domain)} accessibilityLabel={`Verificar status de ${domain.domain}`}>
            Verificar status
          </DsButton>
          {canReVerifySsl && (
            <DsButton
              variant="tertiary"
              disabled={sslVerifying}
              onClick={() => void onReVerifySsl(domain)}
              accessibilityLabel={`${sslVerifying ? 'Verificando' : 'Re-verificar SSL de'} ${domain.domain}`}
            >
              {sslVerifying ? 'Verificando…' : 'Re-verificar SSL'}
            </DsButton>
          )}
          {domain.registrar === 'spaceship' && (
            <DsButton variant="tertiary" onClick={() => onRenew(domain)} accessibilityLabel={`Renovar ${domain.domain}`}>
              Renovar
            </DsButton>
          )}
          <DsButton variant="tertiary" tone="critical" onClick={() => onDelete(domain)} accessibilityLabel={`Deletar ${domain.domain}`}>
            Deletar
          </DsButton>
        </s-grid>
      </s-table-cell>
    </s-table-row>
  );
}

// ─── AddDomainModal ────────────────────────────────────────────────────

function AddDomainModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const [domain, setDomain] = useState('');
  const [nickname, setNickname] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [notes, setNotes] = useState('');
  const [banner, setBanner] = useState<{ tone: 'critical' | 'success'; text: string } | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  const submit = useCallback(() => {
    setBanner(null);
    startTransition(async () => {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const res = await addDomain({
        domain,
        nickname: nickname.trim() || undefined,
        tags,
        notes: notes.trim() || undefined,
        registrar: 'manual',
      });
      if (!res.ok) {
        setBanner({ tone: 'critical', text: res.message });
        return;
      }
      onSuccess();
    });
  }, [domain, nickname, tagsInput, notes, onSuccess]);

  return (
    <DsModal
      open
      onClose={onClose}
      heading="Adicionar domínio"
      primaryAction={{ content: 'Adicionar', onAction: submit, loading: isPending, disabled: isPending || !domain.trim() }}
      secondaryActions={[{ content: 'Cancelar', onAction: onClose, disabled: isPending }]}
    >
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Cole o domínio que você já comprou (Spaceship, Porkbun, GoDaddy,
          etc). A integração com Spaceship API pra comprar direto daqui vem na
          próxima fase.
        </s-paragraph>
        <ActionFeedback
          feedback={banner ? (banner.tone === 'success' ? { tone: 'success', message: banner.text } : { tone: 'critical', error: banner.text }) : null}
          onDismiss={() => setBanner(null)}
        />
        <DsTextField label="Domínio" value={domain} onChange={setDomain} placeholder="exemplo.com" disabled={isPending} required />
        <DsTextField
          label="Apelido (opcional)"
          value={nickname}
          onChange={setNickname}
          placeholder="Ex: dominio-beleza-#1"
          details="Facilita identificar entre vários domínios."
          disabled={isPending}
        />
        <DsTextField
          label="Tags (opcional)"
          value={tagsInput}
          onChange={setTagsInput}
          placeholder="beleza, fresh, meta-safe"
          details="Separadas por vírgula. Use pra filtrar depois."
          disabled={isPending}
        />
        <DsTextArea
          label="Notas (opcional)"
          value={notes}
          onChange={setNotes}
          rows={3}
          placeholder="Ex: comprado 2026-01, expira 2027-01, foco produto X"
          disabled={isPending}
        />
      </s-stack>
    </DsModal>
  );
}

// ─── RenewDomainModal ──────────────────────────────────────────────────
// Fase Task #40 — renova domínio Spaceship por N anos (1-10).
// Se API retornar 501, mostra fallback pra dashboard manual.

function RenewDomainModal({
  domain,
  onClose,
  onSuccess,
}: {
  domain: DomainSummary;
  onClose: () => void;
  onSuccess: (newExpiresAt: string) => void;
}): JSX.Element {
  const [years, setYears] = useState('1');
  // Story 18.10a: 501 = aviso de renovar no dashboard (texto curado da rota); outros erros pelo
  // `describeDomainError` (nunca o texto cru do fornecedor nem "Unexpected token"), com retry.
  const [manualFallback, setManualFallback] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isPending, startTransition] = useTransition();

  const submit = useCallback(() => {
    const yrs = Math.max(1, Math.min(10, Number.parseInt(years, 10) || 1));
    setManualFallback(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/domains/${domain.id}/renew`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ years: yrs }),
        });
        const { data } = await readDomainResponse<{
          ok: boolean;
          message?: string;
          newExpiresAt?: string;
          cost?: number | null;
          fallback?: string;
        }>(res);
        if (!data.newExpiresAt) {
          setError(new Error('renew_without_expiry'));
          return;
        }
        onSuccess(data.newExpiresAt);
      } catch (err) {
        // 501 → fallback manual (Spaceship API sem endpoint).
        if (err instanceof ApiError && err.status === 501) {
          const body = err.body as { message?: unknown } | null;
          setManualFallback(
            typeof body?.message === 'string' && body.message
              ? body.message
              : 'Renovação via API indisponível. Renove no dashboard Spaceship.',
          );
          return;
        }
        setError(err ?? new Error('renew_failed'));
      }
    });
  }, [domain.id, years, onSuccess]);

  return (
    <DsModal
      open
      onClose={onClose}
      heading={`Renovar ${domain.domain}`}
      primaryAction={{ content: 'Renovar', onAction: submit, loading: isPending, disabled: isPending }}
      secondaryActions={[{ content: 'Cancelar', onAction: onClose, disabled: isPending }]}
    >
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Estende o registro no Spaceship por N anos (1-10). A carteira
          Spaceship será cobrada. Expiração atual:{' '}
          <s-text type="strong" fontWeight="bold">
            {domain.expiresAt
              ? new Date(domain.expiresAt).toLocaleDateString('pt-BR')
              : '—'}
          </s-text>
          .
        </s-paragraph>
        {manualFallback && (
          <s-banner tone="warning">{manualFallback}</s-banner>
        )}
        {error ? (
          <DomainErrorBanner
            title={`Não foi possível renovar ${domain.domain}`}
            error={error}
            retryLabel={`Tentar de novo: renovar domínio ${domain.domain}`}
            onRetry={submit}
            onDismiss={() => setError(null)}
          />
        ) : null}
        <DsNumberField label="Anos" value={years} onChange={setYears} min={1} max={10} step={1} inputMode="numeric" disabled={isPending} />
      </s-stack>
    </DsModal>
  );
}
