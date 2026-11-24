'use client';

// @ds-migrated — Story 20.10b (PR2): seção "Preços" no design system.
//
// PriceSection — Editor de preço base + moeda (Wave B).
// Aplica em product-json + kaching-bundles-config + spans .money.
//
// Só visual: validação, edit-html (`set-price-currency`) e avisos iguais a antes.

import { useCallback, useState } from 'react';
import { SUPPORTED_CURRENCIES } from '@blackshop/payments/markets';

import { EditorBanner, EditorCardHeader } from '../_components/EditorCard';

import { DsButton, DsNumberField, DsSelect } from '@/components/ds';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
  onLandingUpdate: (patch: Partial<LandingPageRow>) => void;
  onBanner: (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ) => void;
}

// Story 15.2: lista única de moedas (@blackshop/payments/markets).
const CURRENCIES: Array<{ label: string; value: string }> = SUPPORTED_CURRENCIES.map((c) => ({
  label: c,
  value: c,
}));

export default function PriceSection({
  landing,
  onLandingUpdate,
  onBanner,
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState(landing.price);
  const [currency, setCurrency] = useState(landing.currency || 'USD');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(async () => {
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      onBanner('critical', 'Preço inválido. Use formato 39.90 (ponto ou vírgula decimal).');
      return;
    }
    setIsSaving(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/edit-html`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'set-price-currency',
          price: priceNum.toFixed(2),
          currency,
        }),
        signal: ctrl.signal,
      });
      const data = (await res.json()) as { ok: boolean; message?: string; updatedFields?: string[] };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao atualizar preço.');
        return;
      }
      onLandingUpdate({ price: priceNum.toFixed(2), currency });
      onBanner(
        'success',
        `Preço atualizado: ${currency} ${priceNum.toFixed(2)} (${data.updatedFields?.length ?? 0} elementos alterados no HTML)`,
      );
      setEditing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBanner('critical', msg.includes('aborted') ? 'Tempo limite excedido ao salvar preço. Tente novamente.' : msg);
    } finally {
      clearTimeout(timer);
      setIsSaving(false);
    }
  }, [landing.id, price, currency, onLandingUpdate, onBanner]);


  return (
    <div data-section="price">
      <s-section>
        <s-stack gap="base">
          <EditorCardHeader
            title="Preços"
            action={
              !editing ? (
                <DsButton variant="secondary" onClick={() => setEditing(true)}>
                  Editar
                </DsButton>
              ) : null
            }
          />

          {!editing &&
            (() => {
              const priceNum = Number(landing.price);
              const isZero = !Number.isFinite(priceNum) || priceNum === 0;
              if (isZero && landing.useNewBundleEngine) {
                return (
                  <EditorBanner tone="info" title="Preço derivado dos bundles (Engine V2)">
                    O preço base está em 0,00, mas os preços reais dos pacotes são
                    definidos na seção Bundles (price_cents por oferta). O checkout
                    usa os preços dos bundles diretamente — este campo só afeta
                    exibição em JSON-LD e meta tags de SEO.
                  </EditorBanner>
                );
              }
              return isZero ? (
                <EditorBanner tone="warning" title="Preço não configurado">
                  O preço está em 0,00. Configure antes de publicar — o storefront
                  vai exibir este valor para os visitantes.
                </EditorBanner>
              ) : (
                <s-paragraph color="subdued">
                  <s-text type="strong" fontWeight="bold">
                    {landing.currency}
                  </s-text>{' '}
                  {landing.price}
                  <s-text color="subdued"> — aplica em product-json + bundles + spans .money</s-text>
                </s-paragraph>
              );
            })()}

          {editing && (
            <s-stack gap="base">
              <s-grid gridTemplateColumns="minmax(140px, 200px) minmax(220px, 320px)" gap="base" alignItems="start">
                <DsNumberField label="Preço base" value={price} onChange={setPrice} step={0.01} min={0} disabled={isSaving} />
                <DsSelect
                  label="Moeda"
                  options={
                    CURRENCIES.some((c) => c.value === currency)
                      ? CURRENCIES
                      : [...CURRENCIES, { label: currency, value: currency }]
                  }
                  value={currency}
                  onChange={setCurrency}
                  disabled={isSaving || landing.marketId !== null}
                  details={landing.marketId !== null ? 'Definida pelo mercado — altere na seção Mercado e checkout.' : undefined}
                />
              </s-grid>
              <s-paragraph color="subdued">
                A alteração reescreve o preço em: <span className="ds-mono">&lt;script product-json&gt;</span>,{' '}
                <span className="ds-mono">kaching-bundles-config</span>, spans <span className="ds-mono">.money</span> e{' '}
                <span className="ds-mono">.price-item</span>. Bundles individuais podem ter preços diferentes
                (edite na seção Bundles).
              </s-paragraph>
              <s-stack direction="inline" gap="small-200">
                <DsButton variant="secondary" onClick={handleSave} loading={isSaving} disabled={isSaving}>
                  Salvar preço
                </DsButton>
                <DsButton
                  variant="tertiary"
                  onClick={() => {
                    setPrice(landing.price);
                    setCurrency(landing.currency);
                    setEditing(false);
                  }}
                  disabled={isSaving}
                >
                  Cancelar
                </DsButton>
              </s-stack>
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </div>
  );
}
