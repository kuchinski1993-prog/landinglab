'use client';

// @ds-migrated — Story 20.10b (PR3): assinatura (Subscribe & Save) da landing no design system.
// Só visual: carga/gravação de `subs-config` e dos selling plans iguais a antes.

import type { CheckoutProvider } from '@blackshop/shared/external-checkout';
import { useCallback, useEffect, useState } from 'react';

import { EditorBanner } from './editor/_components/EditorCard';
import StripeSubsConfig from './StripeSubsConfig';

import { DsButton, DsCheckbox, DsNumberField, DsSelect, DsTextField } from '@/components/ds';

interface Props {
  landingPageId: string;
  shopifyProductGid: string | null;
  /**
   * Story 15.6 (AC2): em landing Stripe a assinatura não usa selling plan —
   * renderiza StripeSubsConfig. Ausente/'shopify' = comportamento original.
   * Story 16.3: 'external' (checkout do produtor) não tem assinatura — seção desabilitada.
   */
  checkoutProvider?: CheckoutProvider | null;
}

interface Plan {
  sellingPlanId: string;
  name: string;
  groupName: string;
  discountPercent: number | null;
}

interface State {
  enabled: boolean;
  preselected: boolean;
  discountPercent: string;
  discountLabel: string;
  sellingPlanId: string;
}

export default function SubsConfig({ landingPageId, shopifyProductGid, checkoutProvider }: Props): JSX.Element {
  if (checkoutProvider === 'external') return <ExternalSubsDisabled />;
  if (checkoutProvider === 'stripe') return <StripeSubsConfig landingPageId={landingPageId} />;
  return <ShopifySubsConfig landingPageId={landingPageId} shopifyProductGid={shopifyProductGid} />;
}

/** Story 16.3 (AC 8): assinatura indisponível com checkout externo. */
function ExternalSubsDisabled(): JSX.Element {
  return (
    <div data-testid="subs-external-disabled">
      <s-section>
        <s-stack gap="base">
          <s-heading>Subscription (Subscribe &amp; Save)</s-heading>
          <EditorBanner tone="info">
            Assinatura não está disponível com checkout externo: a compra acontece no checkout do produtor. Para usar
            assinatura, troque o checkout para Shopify ou Stripe em &quot;Mercado e checkout&quot;.
          </EditorBanner>
        </s-stack>
      </s-section>
    </div>
  );
}

function ShopifySubsConfig({
  landingPageId,
  shopifyProductGid,
}: {
  landingPageId: string;
  shopifyProductGid: string | null;
}): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [banner, setBanner] = useState<{ tone: 'success' | 'critical' | 'info'; text: string } | null>(null);
  const [state, setState] = useState<State>({
    enabled: false,
    preselected: false,
    discountPercent: '',
    discountLabel: '',
    sellingPlanId: '',
  });

  const fetchPlans = useCallback(async () => {
    if (!shopifyProductGid) return;
    setPlansLoading(true);
    try {
      const res = await fetch(
        `/api/admin/shopify/selling-plans?productGid=${encodeURIComponent(shopifyProductGid)}`,
        { cache: 'no-store' },
      );
      const data = await res.json() as {
        ok: boolean;
        results?: Array<{
          sellingPlanGroups: Array<{
            groupName: string;
            plans: Array<{
              sellingPlanId: string;
              name: string;
              discountPercent: number | null;
            }>;
          }>;
        }>;
        error?: string;
      };
      if (data.ok && data.results?.length) {
        const flat: Plan[] = [];
        for (const product of data.results) {
          for (const group of product.sellingPlanGroups) {
            for (const plan of group.plans) {
              flat.push({ sellingPlanId: plan.sellingPlanId, name: plan.name, groupName: group.groupName, discountPercent: plan.discountPercent });
            }
          }
        }
        setPlans(flat);
      } else {
        setPlans([]);
      }
    } catch {
      setPlans([]);
    } finally {
      setPlansLoading(false);
    }
  }, [shopifyProductGid]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/landing-pages/${landingPageId}/subs-config`, { cache: 'no-store' });
      const data = await res.json() as {
        ok: boolean;
        enabled?: boolean;
        preselected?: boolean;
        discountPercent?: number | null;
        discountLabel?: string | null;
        sellingPlanId?: string | null;
      };
      if (data?.ok) {
        setState({
          enabled: Boolean(data.enabled),
          preselected: Boolean(data.preselected),
          discountPercent: data.discountPercent != null ? String(data.discountPercent) : '',
          discountLabel: data.discountLabel ?? '',
          sellingPlanId: data.sellingPlanId ?? '',
        });
      }
    } catch (err) {
      setBanner({ tone: 'critical', text: `Erro ao carregar config: ${(err as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, [landingPageId]);

  useEffect(() => {
    void load();
    void fetchPlans();
  }, [load, fetchPlans]);

  const save = async () => {
    setSaving(true);
    setBanner(null);
    try {
      const discountPercentNum =
        state.discountPercent !== '' ? parseInt(state.discountPercent, 10) : null;
      const res = await fetch(`/api/landing-pages/${landingPageId}/subs-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: state.enabled,
          preselected: state.preselected,
          discountPercent: discountPercentNum,
          sellingPlanId: state.sellingPlanId || null,
          discountLabel: state.discountLabel || null,
        }),
      });
      const data = await res.json() as { ok: boolean; error?: string; applyBundleQueued?: boolean };
      if (!data?.ok) {
        setBanner({ tone: 'critical', text: data?.error ?? 'Falha ao salvar' });
        return;
      }
      setBanner({
        tone: 'success',
        text: data.applyBundleQueued
          ? 'Salvo. Widget será atualizado na landing em ~30s.'
          : 'Salvo. ATENÇÃO: worker não foi acionado — HTML não será atualizado.',
      });
    } catch (err) {
      setBanner({ tone: 'critical', text: `Erro: ${(err as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  const planOptions = [
    { label: 'Selecione um plano…', value: '' },
    ...plans.map((p) => ({
      label: p.discountPercent != null
        ? `${p.groupName} — ${p.name} (${p.discountPercent}% off)`
        : `${p.groupName} — ${p.name}`,
      value: p.sellingPlanId,
    })),
  ];


  return (
    <s-section>
      <s-stack gap="base">
        <s-stack gap="small-100">
          <s-heading>Subscription (Subscribe &amp; Save)</s-heading>
          <s-paragraph color="subdued">
            Ativa toggle de assinatura na landing. O desconto real é aplicado pelo Shopify (Selling Plan) —
            este painel configura o widget e o plano associado.
          </s-paragraph>
        </s-stack>

        {banner ? (
          <EditorBanner tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </EditorBanner>
        ) : null}

        {loading ? (
          <s-paragraph color="subdued">Carregando…</s-paragraph>
        ) : (
          <s-stack gap="base">
            <DsCheckbox
              label="Ativar Subscribe & Save nesta landing"
              checked={state.enabled}
              onChange={(v) => setState((s) => ({ ...s, enabled: v }))}
              details="Injeta bloco com toggle de assinatura abaixo dos bundles. Pedido vai como assinatura pro Shopify quando ativo."
            />

            <DsCheckbox
              label="Pré-selecionar assinatura"
              checked={state.preselected}
              onChange={(v) => setState((s) => ({ ...s, preselected: v }))}
              disabled={!state.enabled}
              details="Quando ativo, o checkbox de assinatura já vem marcado por padrão ao carregar a landing."
            />

            <DsNumberField
              label="Desconto visual (%)"
              min={0}
              max={99}
              inputMode="numeric"
              value={state.discountPercent}
              onChange={(v) => setState((s) => ({ ...s, discountPercent: v }))}
              disabled={!state.enabled}
              details="Percentual exibido no widget para cálculo do preço com desconto (só visual — Shopify aplica o valor real do plano)."
              placeholder="10"
            />

            <DsTextField
              label="Badge visual (opcional)"
              value={state.discountLabel}
              onChange={(v) => setState((s) => ({ ...s, discountLabel: v.slice(0, 30) }))}
              disabled={!state.enabled}
              details='Texto do badge ao lado do toggle (ex.: "10% off", "Save 10%").'
              placeholder="10% off"
            />

            <s-stack gap="small-200">
              <s-stack direction="inline" justifyContent="space-between" alignItems="end" gap="base">
                <s-text type="strong" fontWeight="bold">
                  Selling Plan
                </s-text>
                <DsButton variant="secondary" onClick={fetchPlans} loading={plansLoading} disabled={plansLoading || !shopifyProductGid}>
                  Atualizar planos
                </DsButton>
              </s-stack>
              {!shopifyProductGid ? (
                <EditorBanner tone="info">
                  Shopify Product GID não configurado nesta landing. Defina em Config → Shopify para carregar os planos.
                </EditorBanner>
              ) : plans.length === 0 && !plansLoading ? (
                <EditorBanner tone="warning">
                  Nenhum plano de assinatura encontrado para este produto. Configure Selling Plans no Shopify Admin → Products → Purchase options.
                </EditorBanner>
              ) : (
                <DsSelect
                  label="Selling Plan"
                  options={planOptions}
                  value={state.sellingPlanId}
                  onChange={(v) => setState((s) => ({ ...s, sellingPlanId: v }))}
                  disabled={!state.enabled || plansLoading}
                />
              )}
            </s-stack>

            <s-stack direction="inline" gap="small-200">
              <DsButton variant="secondary" onClick={save} loading={saving} disabled={saving}>
                Salvar &amp; republicar
              </DsButton>
              <DsButton variant="tertiary" onClick={load} disabled={saving}>
                Recarregar
              </DsButton>
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
