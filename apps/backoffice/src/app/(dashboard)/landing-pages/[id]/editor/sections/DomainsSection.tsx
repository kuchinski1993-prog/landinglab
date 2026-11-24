'use client';

// @ds-migrated — Story 20.10b (PR2): seção "Domínios" no design system.
//
// DomainsSection — vitrine + status dos domínios raiz disponíveis pro editor V2.
// Complementa o PublishSection (que já tem o Select de domínio + slug). Aqui é
// discovery: usuário vê quais domínios existem, quais estão vinculados a esta
// landing e para onde ir configurar novos.
//
// Não implementa purchase/compra inline — esse fluxo ainda vive no wizard V1
// e depende de Spaceship API + DomainPurchaseModal. Aqui só descoberta + link.
//
// Fetch: /api/landing-domains/list (só roles active / pending_dns / reserve).
// Só visual: busca, estados e avisos iguais a antes.

import { useCallback, useEffect, useState } from 'react';

import { EditorCardHeader, badgeTone } from '../_components/EditorCard';

import { DsButton } from '@/components/ds';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
  onBanner: (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ) => void;
}

interface Domain {
  id: string;
  domain: string;
  role: string;
  registrar?: string | null;
  vercelDomainStatus?: string | null;
  dnsVerifiedAt?: string | null;
  createdAt?: string;
}

function roleBadge(role: string): { tone: 'success' | 'warning' | 'info' | undefined; label: string } {
  switch (role) {
    case 'active':
      return { tone: 'success', label: 'Ativo' };
    case 'pending_dns':
      return { tone: 'warning', label: 'DNS pendente' };
    case 'reserve':
      return { tone: 'info', label: 'Reserva' };
    default:
      return { tone: undefined, label: role };
  }
}

export default function DomainsSection({ landing, onBanner }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDomains = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('/api/landing-domains/list', {
        signal: controller.signal,
        cache: 'no-store',
      });
      const data = (await res.json()) as {
        ok: boolean;
        domains?: Domain[];
        message?: string;
      };
      if (!res.ok || !data.ok) {
        const msg = data.message ?? 'Falha ao carregar domínios.';
        setError(msg);
        onBanner('critical', msg);
        return;
      }
      setDomains(data.domains ?? []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        const msg = 'Timeout ao carregar domínios.';
        setError(msg);
        onBanner('critical', msg);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onBanner('critical', msg);
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, [onBanner]);

  // Story 20.10e — com erro não busca de novo sozinho (antes: laço enquanto a rota
  // falhasse, porque a lista seguia null); só pelo "Tentar novamente".
  useEffect(() => {
    if (expanded && domains === null && !loading && !error) {
      void fetchDomains();
    }
  }, [expanded, domains, loading, error, fetchDomains]);

  const scrollToPublish = useCallback(() => {
    document.getElementById('publish-section')?.scrollIntoView({ behavior: 'smooth' });
  }, []);


  return (
    <s-section>
      <s-stack gap="base">
        <EditorCardHeader
          title="Domínios"
          action={
            <DsButton variant="secondary" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Ocultar' : 'Ver domínios disponíveis'}
            </DsButton>
          }
        />

        {expanded && (
          <s-stack gap="base">
            {loading && (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-spinner size="base" accessibilityLabel="Carregando domínios" />
                <s-text color="subdued">Carregando domínios…</s-text>
              </s-stack>
            )}

            {!loading && error && (
              <s-stack gap="small-200">
                <div role="alert">
                  <s-text tone="critical">{error}</s-text>
                </div>
                <s-stack direction="inline">
                  <DsButton variant="secondary" onClick={() => void fetchDomains()}>
                    Tentar novamente
                  </DsButton>
                </s-stack>
              </s-stack>
            )}

            {!loading && !error && domains !== null && domains.length === 0 && (
              <s-stack gap="small-200">
                <s-paragraph color="subdued">Nenhum domínio cadastrado.</s-paragraph>
                <s-stack direction="inline">
                  <DsButton variant="secondary" href="/landing-pages/domains">
                    Gerenciar domínios
                  </DsButton>
                </s-stack>
              </s-stack>
            )}

            {!loading && !error && domains !== null && domains.length > 0 && (
              <s-stack gap="small-200">
                {domains.map((d) => {
                  const badge = roleBadge(d.role);
                  return (
                    <s-box key={d.id} border="base" borderRadius="base" padding="small-200">
                      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
                        <s-stack gap="small-100">
                          <s-stack direction="inline" gap="small-200" alignItems="center">
                            <s-text type="strong" fontWeight="bold">
                              {d.domain}
                            </s-text>
                            <s-badge tone={badgeTone(badge.tone)}>{badge.label}</s-badge>
                          </s-stack>
                          {d.vercelDomainStatus && <s-text color="subdued">Vercel: {d.vercelDomainStatus}</s-text>}
                        </s-stack>
                        <DsButton variant="secondary" onClick={scrollToPublish} accessibilityLabel={`Usar este domínio: ${d.domain}`}>
                          Usar este domínio
                        </DsButton>
                      </s-stack>
                    </s-box>
                  );
                })}
                <s-paragraph color="subdued">
                  Para conectar um novo domínio ou comprar um, acesse{' '}
                  <s-link href="/landing-pages/domains">Configurações → Domínios</s-link>.
                </s-paragraph>
              </s-stack>
            )}
          </s-stack>
        )}

        {!expanded && (
          <s-paragraph color="subdued">
            Landing atual:{' '}
            <s-text type="strong" fontWeight="bold">
              {landing.slug}
            </s-text>
            {landing.status === 'published' ? ' (publicada)' : ' (rascunho)'}
          </s-paragraph>
        )}
      </s-stack>
    </s-section>
  );
}
