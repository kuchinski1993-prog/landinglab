'use client';

// @ds-migrated — Story 20.10c (PR B): modal "Comprar domínio via Spaceship" no design system.
//
// Fase 5.D — Task #32.
// Modal pra comprar domínio direto via Spaceship (sem sair do backoffice).
//
// Fluxo:
//   1. Usuário digita nome base (ex: "vigorax")
//   2. Clica "Verificar disponibilidade" → POST /api/domains/suggest
//   3. Grid mostra 7 TLDs (.com, .click, .store, etc) com preço/disponível
//   4. Clica "Comprar $X.XX" numa linha → POST /api/domains/purchase
//   5. Callback onSuccess redireciona pra /landing-pages/domains/[id]
//
// Story 18.10b (AC4/AC5): as respostas passam por `readDomainResponse` (nunca "Unexpected token",
// nunca texto cru do fornecedor). Na compra, só um 4xx explícito da rota é "não comprou"; rede,
// 5xx, corpo que não é JSON ou sucesso sem `domainId` = estado INCERTO: a carteira pode ter sido
// cobrada, então "Comprar" daquele domínio fica travado até a lista de domínios ser recarregada
// ("Ver meus domínios" fecha o modal; a tela de Domínios recarrega a lista ao fechar).
//
// Story 20.10c (Decisão 5): COMPORTAMENTO CONGELADO — validação, chamadas, confirmação, a mensagem de
// compra incerta, o "Comprar" travado e a ordem dos estados são os de antes, linha a linha. Só a
// apresentação mudou (DsModal, campos e botões do DS, aviso de incerteza em `role="status"`, erro em
// `role="alert"` com o foco no aviso).

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { DomainErrorBanner } from './_components/DomainErrorBanner';
import { readDomainResponse } from './_lib/domain-response';

import { DsButton, DsModal, DsTextField, useElementEvent } from '@/components/ds';
import { ApiError } from '@/lib/api-client';

interface Suggestion {
  domain: string;
  available: boolean;
  priceUsd: number | null;
  error?: string;
}

interface Props {
  onClose: () => void;
  onSuccess: (result: { domainId: string; domain: string }) => void;
}

export default function PurchaseDomainModal({ onClose, onSuccess }: Props): JSX.Element {
  const [base, setBase] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [checkingBase, setCheckingBase] = useState(false);
  const [buyingDomain, setBuyingDomain] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [banner, setBanner] = useState<{ tone: 'critical' | 'success' | 'info'; text: string } | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<{ error: unknown; retry?: () => void; retryLabel?: string } | null>(null);
  // Compra com resultado desconhecido: o domínio fica travado enquanto o modal estiver aberto.
  const [uncertainDomain, setUncertainDomain] = useState<string | null>(null);
  const lockedRef = useRef<Set<string>>(new Set());
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (actionError || uncertainDomain) alertRef.current?.focus();
  }, [actionError, uncertainDomain]);

  const lock = useCallback((domain: string) => {
    lockedRef.current.add(domain);
    setLocked(new Set(lockedRef.current));
    setUncertainDomain(domain);
  }, []);

  const runSearch = useCallback((cleaned: string) => {
    setBanner(null);
    setActionError(null);
    setSuggestions(null);
    setCheckingBase(true);
    startTransition(async () => {
      try {
        const res = await fetch('/api/domains/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ base: cleaned }),
        });
        const { data } = await readDomainResponse<{ ok: boolean; suggestions?: Suggestion[] }>(res);
        if (!data.suggestions) throw new Error('suggest_without_results');
        setSuggestions(data.suggestions);
      } catch (err) {
        console.warn('[domains] sugestões falharam:', String(err));
        setActionError({
          error: err,
          retry: () => runSearch(cleaned),
          retryLabel: 'Tentar de novo: verificar disponibilidade',
        });
      } finally {
        setCheckingBase(false);
      }
    });
  }, []);

  const search = useCallback(() => {
    const cleaned = base.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (cleaned.length < 3) {
      setActionError(null);
      setBanner({ tone: 'critical', text: 'Nome base precisa ter no mínimo 3 caracteres alfanuméricos.' });
      return;
    }
    runSearch(cleaned);
  }, [base, runSearch]);

  const buy = useCallback(
    (domain: string, priceUsd: number | null) => {
      // Resposta perdida antes: nenhum segundo POST sem a lista de domínios ter sido recarregada.
      if (lockedRef.current.has(domain)) return;
      const confirmed = window.confirm(
        `Confirmar compra de ${domain}${priceUsd !== null ? ` por $${priceUsd.toFixed(2)} USD` : ''}? A carteira Spaceship será cobrada.`,
      );
      if (!confirmed) return;
      setBuyingDomain(domain);
      setActionError(null);
      setBanner({ tone: 'info', text: `Comprando ${domain}…` });
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      startTransition(async () => {
        try {
          const res = await fetch('/api/domains/purchase', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              domain,
              years: 1,
              nickname: nickname.trim() || undefined,
              tags,
            }),
          });
          const { data } = await readDomainResponse<{ ok: boolean; domainId?: string }>(res);
          const domainId = data.domainId;
          if (!domainId) throw new Error('purchase_without_domain_id');
          setBanner({ tone: 'success', text: `${domain} comprado! Redirecionando…` });
          setTimeout(() => onSuccess({ domainId, domain }), 800);
        } catch (err) {
          console.warn('[domains] compra sem confirmação:', String(err));
          setBanner(null);
          // Só um 4xx explícito da rota garante que nada foi cobrado.
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            setActionError({ error: err });
          } else {
            lock(domain);
          }
        } finally {
          setBuyingDomain(null);
        }
      });
    },
    [nickname, tagsInput, onSuccess, lock],
  );


  return (
    <DsModal
      open
      onClose={onClose}
      heading="Comprar domínio via Spaceship"
      secondaryActions={[{ content: 'Fechar', onAction: onClose, disabled: isPending }]}
    >
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Digite um nome (sem TLD) e o sistema verifica disponibilidade em
          vários TLDs — clique em qualquer resultado disponível pra comprar.
          A carteira Spaceship é cobrada ao confirmar.
        </s-paragraph>

        {banner && <InfoBanner tone={banner.tone} text={banner.text} onDismiss={() => setBanner(null)} />}

        {(actionError || uncertainDomain) && (
          <div ref={alertRef} tabIndex={-1} className="ds-focus-container">
            <s-stack gap="small-200">
              {uncertainDomain && (
                <div role="status">
                  <s-banner tone="info">
                    {`Não sabemos se a compra de ${uncertainDomain} foi concluída. Confira a lista de domínios antes de tentar de novo.`}
                    <DsButton slot="secondary-actions" variant="secondary" onClick={onClose}>
                      Ver meus domínios
                    </DsButton>
                  </s-banner>
                </div>
              )}
              {actionError && (
                <DomainErrorBanner
                  error={actionError.error}
                  onRetry={actionError.retry}
                  retryLabel={actionError.retryLabel}
                  onDismiss={() => setActionError(null)}
                />
              )}
            </s-stack>
          </div>
        )}

        <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="end">
          <DsTextField
            label="Nome base do domínio"
            value={base}
            onChange={setBase}
            placeholder="Ex: vigorax, oferta-black, produto-x"
            details="Só letras minúsculas, números e hífens."
            disabled={isPending}
          />
          {/* O texto de ajuda fica abaixo do campo: o botão alinha com a caixa de texto, não com a ajuda. */}
          <s-box paddingBlockEnd="large-100">
            <DsButton variant="primary" onClick={search} loading={checkingBase} disabled={isPending || !base.trim()}>
              Verificar
            </DsButton>
          </s-box>
        </s-grid>

        <DsTextField
          label="Apelido opcional (aplica ao comprado)"
          value={nickname}
          onChange={setNickname}
          placeholder="Ex: vigorax-fresh-2026"
          disabled={isPending}
        />
        <DsTextField
          label="Tags opcionais (separadas por vírgula)"
          value={tagsInput}
          onChange={setTagsInput}
          placeholder="beleza, fresh, meta-safe"
          disabled={isPending}
        />

        {suggestions && suggestions.length > 0 && (
          <s-stack gap="small-200">
            <s-heading>Resultados</s-heading>
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.domain}
                suggestion={s}
                isBuying={buyingDomain === s.domain}
                onBuy={() => buy(s.domain, s.priceUsd)}
                disabled={isPending || locked.has(s.domain)}
              />
            ))}
          </s-stack>
        )}
      </s-stack>
    </DsModal>
  );
}

function InfoBanner({
  tone,
  text,
  onDismiss,
}: {
  tone: 'critical' | 'success' | 'info';
  text: string;
  onDismiss: () => void;
}): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-banner']>(null);
  useElementEvent(ref, 'dismiss', onDismiss);
  return (
    <s-banner ref={ref} tone={tone} dismissible>
      {text}
    </s-banner>
  );
}

function SuggestionRow({
  suggestion,
  isBuying,
  onBuy,
  disabled,
}: {
  suggestion: Suggestion;
  isBuying: boolean;
  onBuy: () => void;
  disabled: boolean;
}): JSX.Element {
  const { domain, available, priceUsd, error } = suggestion;

  return (
    <s-box background="subdued" padding="small-200" borderRadius="base">
      <s-grid gridTemplateColumns="1fr auto 6rem" gap="base" alignItems="center">
        <s-text>{domain}</s-text>
        {error ? (
          <s-badge tone="critical">Erro</s-badge>
        ) : available ? (
          <s-text type="strong" fontWeight="bold">
            {priceUsd !== null ? `$${priceUsd.toFixed(2)}` : '—'}
          </s-text>
        ) : (
          <s-badge tone="caution">Indisponível</s-badge>
        )}
        <s-stack direction="inline" justifyContent="end">
          {available && (
            <DsButton variant="secondary" onClick={onBuy} loading={isBuying} disabled={disabled} accessibilityLabel={`Comprar ${domain}`}>
              Comprar
            </DsButton>
          )}
        </s-stack>
      </s-grid>
    </s-box>
  );
}
