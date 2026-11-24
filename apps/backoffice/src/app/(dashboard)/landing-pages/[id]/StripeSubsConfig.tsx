'use client';

// @ds-migrated — Story 20.10b (PR3): assinatura com checkout Stripe no design system.
//
// Subscribe & Save em landing com checkout Stripe (Story 15.6, AC2).
//
// Sem selling plan nem Shopify: a landing define intervalo + frequência e o
// desconto (real, em todas as faturas). O preview usa recurringUnitAmount — a
// mesma conta do servidor. Grava via checkout-settings (`subscription`), que
// valida e reprocessa o HTML; a landing publicada precisa ser republicada.
//
// Story 20.10b — só visual: validação, prévia do preço recorrente e gravação iguais a antes.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { EditorBanner } from './editor/_components/EditorCard';

import { DsButton, DsCheckbox, DsNumberField, DsSelect } from '@/components/ds';
import { SUBSCRIPTION_INTERVALS, formatMinor, intervalLabel } from '@/lib/landing-orders';
import {
  SUBS_INTERVAL_COUNT_MAX,
  YEARLY_COUNT_MESSAGE,
  recurringPreview,
  stripeSubscriptionIssues,
  subsIntervalCountMax,
  type OfferForPreview,
  type StripeSubscriptionSettings,
} from '@/lib/landing-subscription-settings';

interface Props {
  landingPageId: string;
}

interface Issue {
  code: string;
  message: string;
}

interface SettingsResponse {
  ok: boolean;
  message?: string;
  market_id: string | null;
  currency: string;
  markets: Array<{ id: string; currency: string }>;
  subscription?: {
    enabled: boolean;
    preselected: boolean;
    discount_percent: number | null;
    interval: string | null;
    interval_count: number;
    selling_plan_saved: boolean;
  };
  offers?: Array<{ id: string; position: number; title: string; qty: number; price_minor: number }>;
}

interface FormState {
  enabled: boolean;
  preselected: boolean;
  discountPercent: string;
  interval: string;
  intervalCount: string;
}

const INTERVAL_OPTIONS = [
  { label: 'Escolha…', value: '' },
  { label: 'Dia(s)', value: 'day' },
  { label: 'Semana(s)', value: 'week' },
  { label: 'Mês(es)', value: 'month' },
  { label: 'Ano(s)', value: 'year' },
];

const URL_OF = (id: string) => `/api/landing-pages/${id}/checkout-settings`;

function toForm(sub: SettingsResponse['subscription']): FormState {
  return {
    enabled: Boolean(sub?.enabled),
    preselected: Boolean(sub?.preselected),
    discountPercent: sub?.discount_percent != null ? String(sub.discount_percent) : '',
    interval: sub?.interval && (SUBSCRIPTION_INTERVALS as readonly string[]).includes(sub.interval) ? sub.interval : '',
    intervalCount: String(sub?.interval_count ?? 1),
  };
}

/** Converte o formulário; null nos campos numéricos inválidos (o servidor revalida). */
function toSettings(form: FormState): StripeSubscriptionSettings & { invalid: string | null } {
  const pct = form.discountPercent.trim() === '' ? null : Number(form.discountPercent);
  const count = Number(form.intervalCount);
  let invalid: string | null = null;
  if (pct !== null && (!Number.isInteger(pct) || pct < 0 || pct > 99)) invalid = 'O desconto deve ser um inteiro de 0 a 99.';
  if (!Number.isInteger(count) || count < 1 || count > SUBS_INTERVAL_COUNT_MAX) {
    invalid = `A frequência deve ser um inteiro de 1 a ${SUBS_INTERVAL_COUNT_MAX}.`;
  } else if (count > subsIntervalCountMax(form.interval)) {
    // QA 15.6 REQ-001: a Stripe só aceita recorrência de até 1 ano.
    invalid = YEARLY_COUNT_MESSAGE;
  }
  return {
    enabled: form.enabled,
    preselected: form.preselected,
    discountPercent: pct !== null && Number.isInteger(pct) && pct >= 0 && pct <= 99 ? pct : null,
    interval: (SUBSCRIPTION_INTERVALS as readonly string[]).includes(form.interval)
      ? (form.interval as StripeSubscriptionSettings['interval'])
      : null,
    intervalCount: Number.isInteger(count) && count >= 1 && count <= SUBS_INTERVAL_COUNT_MAX ? count : 1,
    invalid,
  };
}

export default function StripeSubsConfig({ landingPageId }: Props): JSX.Element {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<FormState>(toForm(undefined));
  const [saving, setSaving] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [banner, setBanner] = useState<{ tone: 'success' | 'critical' | 'warning'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch(URL_OF(landingPageId), { cache: 'no-store' });
      const body = (await res.json()) as SettingsResponse;
      if (!res.ok || !body.ok) {
        setLoadError(body.message ?? 'Falha ao carregar a assinatura.');
        return;
      }
      setData(body);
      setForm(toForm(body.subscription));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Falha ao carregar a assinatura.');
    }
  }, [landingPageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const offers: OfferForPreview[] = useMemo(
    () =>
      (data?.offers ?? []).map((o) => ({
        id: o.id,
        position: o.position,
        title: o.title,
        qty: o.qty,
        priceCents: o.price_minor,
      })),
    [data],
  );
  const currency = data?.markets.find((m) => m.id === data.market_id)?.currency ?? data?.currency ?? '';
  const settings = toSettings(form);
  const preview = recurringPreview(offers, settings.discountPercent).filter((r) => r.priceMinor > 0);
  const localIssues = settings.invalid ? [settings.invalid] : stripeSubscriptionIssues(settings, offers);
  const saved = toForm(data?.subscription);
  const dirty = data !== null && JSON.stringify(saved) !== JSON.stringify(form);

  async function save(): Promise<void> {
    if (settings.invalid) return;
    setSaving(true);
    setBanner(null);
    setServerIssues([]);
    try {
      const res = await fetch(URL_OF(landingPageId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subscription: {
            enabled: settings.enabled,
            preselected: settings.preselected,
            discount_percent: settings.discountPercent,
            interval: settings.interval,
            interval_count: settings.intervalCount,
          },
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        message?: string;
        stripe_issues?: Issue[];
        subscription_issues?: Issue[];
        reprocessing?: boolean;
        subscription_changed?: boolean;
      };
      if (!res.ok || !body.ok) {
        setServerIssues([...(body.subscription_issues ?? []), ...(body.stripe_issues ?? [])]);
        setBanner({ tone: 'critical', text: body.message ?? 'Não foi possível salvar a assinatura.' });
        return;
      }
      setBanner(
        body.subscription_changed && !body.reprocessing
          ? {
              tone: 'warning',
              text: 'Salvo, mas o reprocessamento do HTML não foi enfileirado. Clique em "Republicar landing" (seção Publicação) para reprocessar e o widget refletir a mudança.',
            }
          : {
              tone: 'success',
              text: 'Assinatura salva. O HTML da landing está sendo reprocessado e o widget entra no ar sozinho no domínio publicado em cerca de 1 minuto — não é preciso republicar.',
            },
      );
      await load();
    } catch (err) {
      setBanner({ tone: 'critical', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }


  return (
    <s-section>
      <s-stack gap="base">
        <s-stack gap="small-100">
          <s-heading>Subscription (Subscribe &amp; Save) — checkout Stripe</s-heading>
          <s-paragraph color="subdued">
            O cliente escolhe na landing entre compra única e assinatura da mesma oferta. A cobrança recorrente é feita
            pela Stripe na conta escolhida pela rotação; o cliente cancela pelo Portal da Stripe. Não usa selling plan
            nem Shopify.
          </s-paragraph>
        </s-stack>

        {banner && (
          <EditorBanner tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </EditorBanner>
        )}
        {loadError && <EditorBanner tone="critical">{loadError}</EditorBanner>}

        {!data && !loadError && <s-paragraph color="subdued">Carregando…</s-paragraph>}

        {data && (
          <s-stack gap="base">
            <DsCheckbox
              label="Ativar Subscribe & Save nesta landing"
              checked={form.enabled}
              onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              details="Mostra o bloco de assinatura abaixo das ofertas. Marcado, o checkout cria uma assinatura na Stripe."
            />
            <DsCheckbox
              label="Pré-selecionar assinatura"
              checked={form.preselected}
              onChange={(v) => setForm((f) => ({ ...f, preselected: v }))}
              disabled={!form.enabled}
              details="O checkbox de assinatura já vem marcado ao abrir a landing."
            />
            <s-grid gridTemplateColumns="repeat(3, minmax(140px, 220px))" gap="base" alignItems="start">
              <DsNumberField
                label="Cobrar a cada"
                min={1}
                max={subsIntervalCountMax(form.interval)}
                inputMode="numeric"
                value={form.intervalCount}
                onChange={(v) => setForm((f) => ({ ...f, intervalCount: v }))}
                disabled={!form.enabled}
              />
              <DsSelect
                label="Intervalo"
                options={INTERVAL_OPTIONS}
                value={form.interval}
                onChange={(v) =>
                  // Ao escolher "ano", a frequência volta para 1 (máximo da Stripe).
                  setForm((f) => ({ ...f, interval: v, intervalCount: v === 'year' ? '1' : f.intervalCount }))
                }
                disabled={!form.enabled}
              />
              <DsNumberField
                label="Desconto da assinatura (%)"
                min={0}
                max={99}
                inputMode="numeric"
                value={form.discountPercent}
                onChange={(v) => setForm((f) => ({ ...f, discountPercent: v }))}
                disabled={!form.enabled}
                placeholder="0"
              />
            </s-grid>

            {form.enabled && (
              <EditorBanner tone="info">
                {`Cobrança ${settings.interval ? intervalLabel(settings.interval, settings.intervalCount) : '(escolha o intervalo)'}. `}
                O desconto vale em{' '}
                <s-text type="strong" fontWeight="bold">
                  todas as faturas
                </s-text>{' '}
                (1ª e renovações). O frete é cobrado só na 1ª fatura; as renovações viram novos pedidos a enviar, sem frete.
              </EditorBanner>
            )}

            <s-stack gap="small-100">
              <s-text type="strong" fontWeight="bold">{`Preço recorrente por oferta${currency ? ` (${currency})` : ''}`}</s-text>
              {preview.length === 0 ? (
                <s-paragraph color="subdued">Nenhuma oferta com preço. Cadastre as ofertas na seção Bundles.</s-paragraph>
              ) : (
                <s-stack gap="small-100">
                  {preview.map((r) => (
                    <s-stack key={r.offerId} direction="inline" justifyContent="space-between" gap="base">
                      <s-text>
                        {r.title || `Oferta ${r.position}`}
                        {r.qty > 1 ? ` · ${r.qty} un.` : ''}
                      </s-text>
                      <s-text tone={r.recurringMinor === null ? 'critical' : undefined}>
                        {`${formatMinor(r.priceMinor, currency)} → ${
                          r.recurringMinor === null ? 'inválido (zero)' : formatMinor(r.recurringMinor, currency)
                        }${settings.interval ? ` ${intervalLabel(settings.interval, settings.intervalCount)}` : ''}`}
                      </s-text>
                    </s-stack>
                  ))}
                </s-stack>
              )}
            </s-stack>

            {data.subscription?.selling_plan_saved && (
              <s-paragraph color="subdued">Há um selling plan da Shopify salvo nesta landing; ele é ignorado no checkout Stripe.</s-paragraph>
            )}

            {((form.enabled && localIssues.length > 0) || serverIssues.length > 0) && (
              <EditorBanner tone="critical" title="Falta para ligar a assinatura">
                <s-unordered-list>
                  {(serverIssues.length > 0 ? serverIssues.map((i) => i.message) : localIssues).map((m) => (
                    <s-list-item key={m}>{m}</s-list-item>
                  ))}
                </s-unordered-list>
              </EditorBanner>
            )}

            <s-paragraph color="subdued">
              Ao salvar, o HTML da landing é reprocessado e o widget de assinatura aparece (ou muda) no domínio publicado
              em cerca de 1 minuto —{' '}
              <s-text type="strong" fontWeight="bold">
                não é preciso republicar
              </s-text>
              . Só use &quot;Republicar landing&quot; se o aviso disser que o reprocessamento não foi enfileirado.
            </s-paragraph>

            <s-stack direction="inline" gap="small-200">
              <DsButton
                variant="secondary"
                onClick={() => void save()}
                loading={saving}
                disabled={!dirty || saving || (form.enabled && localIssues.length > 0) || Boolean(settings.invalid)}
              >
                Salvar assinatura
              </DsButton>
              {dirty && (
                <DsButton variant="tertiary" onClick={() => setForm(saved)} disabled={saving}>
                  Cancelar
                </DsButton>
              )}
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
