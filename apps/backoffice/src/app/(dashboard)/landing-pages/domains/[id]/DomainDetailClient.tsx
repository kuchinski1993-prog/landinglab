'use client';

// @ds-migrated — Story 20.10c (PR B): detalhe/gestão de um domínio no design system.
// Layout: cabeçalho (domínio, selo da função, "Ver ao vivo") + vínculos à esquerda e
// configurações/sistema à direita, como antes.
//
// Só visual: `updateDomain`, `deleteBinding`, `listBindableLandings`, `createBinding` e o
// `router.refresh()` são os de antes. As confirmações viram aviso polite e as falhas, aviso persistente
// (antes ambos num Toast que sumia sozinho), com os mesmos textos.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

import {
  ActionFeedback,
  DsButton,
  DsCheckbox,
  DsModal,
  DsPageHeader,
  DsSelect,
  DsTextArea,
  DsTextField,
  PolarisGate,
  isModifiedClick,
  useActionFeedback,
} from '@/components/ds';
import {
  createBinding,
  deleteBinding,
  listBindableLandings,
  updateDomain,
  type DomainBindingRow,
  type DomainRole,
  type DomainSummary,
} from '@/lib/domain-actions';

type BadgeTone = 'success' | 'info' | 'critical' | 'warning' | 'caution';

// Mesmos tons de antes (o "attention" do Polaris React é o "caution" do DS).
const ROLE_TONE: Record<DomainRole, BadgeTone> = {
  active: 'success',
  reserve: 'info',
  blocked: 'critical',
  pending_dns: 'warning',
  disabled: 'caution',
};

const ROLE_LABEL: Record<DomainRole, string> = {
  active: 'Ativo',
  reserve: 'Reserva',
  blocked: 'Bloqueado',
  pending_dns: 'DNS pendente',
  disabled: 'Desativado',
};

const DOMAINS_HREF = '/landing-pages/domains';

interface Props {
  domain: DomainSummary;
  bindings: DomainBindingRow[];
}

function BackLink(): JSX.Element {
  const router = useRouter();
  return (
    <s-link
      href={DOMAINS_HREF}
      onClick={(event) => {
        if (isModifiedClick(event as unknown as MouseEvent)) return;
        event.preventDefault();
        router.push(DOMAINS_HREF);
      }}
    >
      Domínios
    </s-link>
  );
}

export default function DomainDetailClient({
  domain,
  bindings: initialBindings,
}: Props): JSX.Element {
  const router = useRouter();
  const [bindings, setBindings] = useState(initialBindings);
  const [nickname, setNickname] = useState(domain.nickname ?? '');
  const [tagsInput, setTagsInput] = useState((domain.tags ?? []).join(', '));
  const [notes, setNotes] = useState(domain.notes ?? '');
  const [role, setRole] = useState<DomainRole>(domain.role);
  // Story 20.10c (Decisão 6): confirmação → aviso polite; falha → aviso persistente (role="alert").
  const feedback = useActionFeedback();
  const { success: setToast, failure: showError } = feedback;
  const [bindingOpen, setBindingOpen] = useState(false);
  const [isSaving, startSaveTransition] = useTransition();
  const [isBindingMutating, startBindingMutation] = useTransition();

  const hasChanges = useMemo(
    () =>
      nickname.trim() !== (domain.nickname ?? '') ||
      tagsInput !== (domain.tags ?? []).join(', ') ||
      notes.trim() !== (domain.notes ?? '') ||
      role !== domain.role,
    [nickname, tagsInput, notes, role, domain],
  );

  const saveSettings = useCallback(() => {
    startSaveTransition(async () => {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const res = await updateDomain(domain.id, {
        nickname: nickname.trim() || null,
        tags,
        notes: notes.trim() || null,
        role,
      });
      if (!res.ok) {
        showError(res.message);
        return;
      }
      setToast('Domínio atualizado.');
      router.refresh();
    });
  }, [domain.id, nickname, tagsInput, notes, role, router, setToast, showError]);

  const removeBinding = useCallback(
    (id: string) => {
      startBindingMutation(async () => {
        const res = await deleteBinding(id);
        if (!res.ok) {
          showError(res.message);
          return;
        }
        setBindings((prev) => prev.filter((b) => b.id !== id));
        setToast('Vínculo removido.');
      });
    },
    [setToast, showError],
  );

  const activeBindings = bindings.filter((b) => b.landingStatus === 'published');
  const draftBindings = bindings.filter((b) => b.landingStatus !== 'published');

  return (
    <PolarisGate>
      <s-page>
        <DsPageHeader
          title={domain.domain}
          breadcrumb={<BackLink />}
          accessory={<s-badge tone={ROLE_TONE[domain.role]}>{ROLE_LABEL[domain.role]}</s-badge>}
          secondaryActions={
            <DsButton variant="secondary" href={`https://${domain.domain}`} target="_blank" accessibilityLabel={`Ver ${domain.domain} ao vivo (abre em nova aba)`}>
              Ver ao vivo
            </DsButton>
          }
        />
        <s-stack gap="base">
          {domain.nickname ? <s-paragraph color="subdued">{domain.nickname}</s-paragraph> : null}

          <ActionFeedback feedback={feedback.feedback} onDismiss={feedback.dismiss} />

          {domain.role === 'pending_dns' && (
            <s-banner tone="warning">
              DNS ainda não verificado. Verifique se os registros DNS estão apontando
              corretamente pro Vercel (A record: 76.76.21.21, CNAME: cname.vercel-dns.com).
            </s-banner>
          )}
          {domain.role === 'blocked' && (
            <s-banner tone="critical">
              Domínio bloqueado. Landings publicadas nele não estão acessíveis.
            </s-banner>
          )}

          <s-query-container>
            <s-grid gridTemplateColumns="minmax(0, 2fr) minmax(0, 1fr)" gap="base" alignItems="start">
              {/* Coluna esquerda — Vínculos */}
              <s-section>
                <s-stack gap="base">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                    <s-heading>{`Landings neste domínio (${bindings.length})`}</s-heading>
                    <DsButton variant="primary" onClick={() => setBindingOpen(true)}>
                      + Vincular landing
                    </DsButton>
                  </s-stack>

                  {bindings.length === 0 ? (
                    <s-box padding="large-200">
                      <s-paragraph color="subdued">
                        {`Nenhuma landing vinculada. Adicione a primeira pra publicar em ${domain.domain}.`}
                      </s-paragraph>
                    </s-box>
                  ) : (
                    <s-stack gap="base">
                      {activeBindings.length > 0 && (
                        <s-stack gap="small-200">
                          <s-heading>Publicadas</s-heading>
                          {activeBindings.map((b) => (
                            <BindingRow key={b.id} binding={b} domain={domain.domain} onRemove={removeBinding} disabled={isBindingMutating} />
                          ))}
                        </s-stack>
                      )}
                      {draftBindings.length > 0 && (
                        <s-stack gap="small-200">
                          <s-heading>Rascunhos vinculados</s-heading>
                          {draftBindings.map((b) => (
                            <BindingRow key={b.id} binding={b} domain={domain.domain} onRemove={removeBinding} disabled={isBindingMutating} />
                          ))}
                        </s-stack>
                      )}
                    </s-stack>
                  )}
                </s-stack>
              </s-section>

              {/* Coluna direita — Configurações */}
              <s-stack gap="base">
                <s-section>
                  <s-stack gap="base">
                    <s-heading>Configurações</s-heading>
                    <DsTextField label="Apelido" value={nickname} onChange={setNickname} details="Nome amigável pra identificar." disabled={isSaving} />
                    <DsTextField label="Tags" value={tagsInput} onChange={setTagsInput} details="Separadas por vírgula." disabled={isSaving} />
                    <DsSelect
                      label="Status"
                      options={[
                        { label: 'Ativo', value: 'active' },
                        { label: 'Reserva', value: 'reserve' },
                        { label: 'Bloqueado', value: 'blocked' },
                        { label: 'DNS pendente', value: 'pending_dns' },
                        { label: 'Desativado', value: 'disabled' },
                      ]}
                      value={role}
                      onChange={(v) => setRole(v as DomainRole)}
                      disabled={isSaving}
                    />
                    <DsTextArea label="Notas" value={notes} onChange={setNotes} rows={4} disabled={isSaving} />
                    {/* Um primário por tela (guia §2): "Vincular landing" é o primário; salvar vira secundário (como os rodapés da 20.5f). */}
                    <s-stack direction="inline" justifyContent="end">
                      <DsButton variant="secondary" onClick={saveSettings} loading={isSaving} disabled={isSaving || !hasChanges}>
                        Salvar configurações
                      </DsButton>
                    </s-stack>
                  </s-stack>
                </s-section>

                <s-section>
                  <s-stack gap="small-200">
                    <s-heading>Sistema</s-heading>
                    <MetaRow label="Registrar" value={domain.registrar ?? '—'} />
                    {domain.registrarDomainId && <MetaRow label="ID no registrar" value={domain.registrarDomainId} />}
                    <MetaRow label="SSL Vercel" value={domain.vercelDomainStatus ?? '—'} />
                    <MetaRow
                      label="DNS verificado"
                      value={domain.dnsVerifiedAt ? new Date(domain.dnsVerifiedAt).toLocaleString('pt-BR') : '—'}
                    />
                    {domain.expiresAt && <MetaRow label="Expira em" value={new Date(domain.expiresAt).toLocaleDateString('pt-BR')} />}
                    <MetaRow label="Cadastrado" value={new Date(domain.createdAt).toLocaleDateString('pt-BR')} />
                  </s-stack>
                </s-section>
              </s-stack>
            </s-grid>
          </s-query-container>
        </s-stack>
      </s-page>

      {bindingOpen && (
        <BindingModal
          domainId={domain.id}
          existingBindings={bindings}
          onClose={() => setBindingOpen(false)}
          onSuccess={(newBinding) => {
            setBindings((prev) => [...prev, newBinding]);
            setBindingOpen(false);
            setToast('Landing vinculada com sucesso.');
            router.refresh();
          }}
        />
      )}
    </PolarisGate>
  );
}

// ─── BindingRow ─────────────────────────────────────────────────────────

function BindingRow({
  binding,
  domain,
  onRemove,
  disabled,
}: {
  binding: DomainBindingRow;
  domain: string;
  onRemove: (id: string) => void;
  disabled: boolean;
}): JSX.Element {
  const url = binding.isDefaultRoot
    ? `https://${domain}/`
    : `https://${domain}/${binding.slug}`;

  return (
    <s-box background="subdued" padding="small-200" borderRadius="base">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small-200">
        <s-stack gap="small-100">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong" fontWeight="bold">
              {binding.landingTitle}
            </s-text>
            {binding.isDefaultRoot && <s-badge tone="caution">Página inicial</s-badge>}
          </s-stack>
          <s-text color="subdued">{url}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200">
          <DsButton variant="secondary" href={`/landing-pages/${binding.landingPageId}/editor`} accessibilityLabel={`Abrir landing ${binding.landingTitle}`}>
            Abrir landing
          </DsButton>
          <DsButton
            variant="tertiary"
            tone="critical"
            onClick={() => onRemove(binding.id)}
            disabled={disabled}
            accessibilityLabel={`Desvincular ${binding.landingTitle}`}
          >
            Desvincular
          </DsButton>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

// ─── BindingModal ──────────────────────────────────────────────────────

function BindingModal({
  domainId,
  existingBindings,
  onClose,
  onSuccess,
}: {
  domainId: string;
  existingBindings: DomainBindingRow[];
  onClose: () => void;
  onSuccess: (b: DomainBindingRow) => void;
}): JSX.Element {
  const [landings, setLandings] = useState<
    Array<{ id: string; title: string; slug: string; status: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [slug, setSlug] = useState('');
  const [isDefaultRoot, setIsDefaultRoot] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'critical' | 'success'; text: string } | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void listBindableLandings(domainId).then((ls) => {
      setLandings(ls);
      setLoading(false);
    });
  }, [domainId]);

  const alreadyHasRoot = existingBindings.some((b) => b.isDefaultRoot);
  const selectedLanding = landings.find((l) => l.id === selectedId);

  const submit = useCallback(() => {
    setBanner(null);
    if (!selectedId) {
      setBanner({ tone: 'critical', text: 'Selecione uma landing.' });
      return;
    }
    startTransition(async () => {
      const res = await createBinding({
        domainId,
        landingPageId: selectedId,
        slug: isDefaultRoot ? '' : slug.trim() || undefined,
        isDefaultRoot,
      });
      if (!res.ok) {
        setBanner({ tone: 'critical', text: res.message });
        return;
      }
      // Reconstroi a binding pra callback (sem re-fetch pesado).
      onSuccess({
        id: res.data.id,
        domainId,
        landingPageId: selectedId,
        slug: res.data.slug,
        isDefaultRoot,
        landingTitle: selectedLanding?.title ?? 'Landing',
        landingStatus: selectedLanding?.status ?? 'draft',
        createdAt: new Date().toISOString(),
      });
    });
  }, [
    domainId,
    selectedId,
    slug,
    isDefaultRoot,
    selectedLanding,
    onSuccess,
  ]);

  return (
    <DsModal
      open
      onClose={onClose}
      heading="Vincular landing ao domínio"
      primaryAction={{ content: 'Vincular', onAction: submit, loading: isPending, disabled: isPending || !selectedId }}
      secondaryActions={[{ content: 'Cancelar', onAction: onClose, disabled: isPending }]}
    >
      <s-stack gap="base">
        <ActionFeedback
          feedback={banner ? (banner.tone === 'success' ? { tone: 'success', message: banner.text } : { tone: 'critical', error: banner.text }) : null}
          onDismiss={() => setBanner(null)}
        />

        {loading ? (
          <s-paragraph color="subdued">Carregando landings…</s-paragraph>
        ) : landings.length === 0 ? (
          <s-paragraph color="subdued">Todas as landings já estão vinculadas a este domínio.</s-paragraph>
        ) : (
          <>
            <DsSelect
              label="Landing"
              placeholder="Selecione uma landing"
              options={landings.map((l) => ({ label: `${l.title} (${l.status})`, value: l.id }))}
              value={selectedId}
              onChange={setSelectedId}
            />

            <DsCheckbox
              label={
                alreadyHasRoot
                  ? 'Página inicial (já existe uma neste domínio)'
                  : 'Definir como página inicial (raiz do domínio)'
              }
              checked={isDefaultRoot}
              onChange={setIsDefaultRoot}
              disabled={alreadyHasRoot || isPending}
              details={isDefaultRoot ? 'A landing será servida em https://dominio.com/ (sem slug).' : undefined}
            />

            {!isDefaultRoot && (
              <DsTextField
                label="Slug (opcional)"
                value={slug}
                onChange={setSlug}
                placeholder="Deixe vazio pra auto-gerar do título"
                details="A URL final será https://dominio.com/<slug>"
                disabled={isPending}
              />
            )}
          </>
        )}
      </s-stack>
    </DsModal>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}
