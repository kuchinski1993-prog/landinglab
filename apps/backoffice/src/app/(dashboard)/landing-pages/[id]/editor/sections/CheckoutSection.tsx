'use client';

// @ds-migrated — Story 20.10b (PR3): seção "Mercado e checkout" no design system.
//
// CheckoutSection — Mercado (idioma/moeda/frete) + provider do checkout
// (Shopify | Stripe). Story 15.2. A troca para Stripe só é aceita com o
// checklist completo; voltar para Shopify é sempre permitido.
// Story 15.7: imagem do produto (só upload) e cabeçalho do checkout (logo,
// altura, alinhamento, nome da marca) — uploads salvam sozinhos
// (CheckoutAppearance); "Salvar" cuida de mercado, checkout e nome do produto.
//
// Story 20.10b — só visual: carga e gravação de `checkout-settings` iguais a antes.
// Story 16.3 — provider "Checkout externo" (checkout do produtor): URLs de 1/3/5 potes, kit
// padrão e opt-in do tracker do Sphere (terceiro, desligado por padrão). Validação no servidor
// (validador único); erro mostra o kit e o motivo.

import type { CheckoutProvider, ExternalCheckoutConfig, ExternalKit } from '@blackshop/shared/external-checkout';
import { useCallback, useEffect, useState } from 'react';

import { EditorBanner, EditorCardHeader } from '../_components/EditorCard';

import { CheckoutHeaderBlock, ProductImageBlock, type AppearanceState } from './CheckoutAppearance';

import { DsButton, DsCheckbox, DsSelect, DsTextField } from '@/components/ds';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
  onLandingUpdate: (patch: Partial<LandingPageRow>) => void;
  onBanner: (tone: 'success' | 'critical' | 'info' | 'warning', message: string, title?: string) => void;
}

interface MarketOption {
  id: string;
  name: string;
  currency: string;
  locale: string;
  status: 'active' | 'archived';
  country_codes: string[];
}

interface Issue {
  code: string;
  message: string;
}

interface SettingsResponse {
  ok: boolean;
  message?: string;
  market_id: string | null;
  checkout_provider: CheckoutProvider;
  /** Story 16.3 — mapa kit->URL revalidado pelo servidor. */
  external_checkout?: ExternalCheckoutConfig;
  currency: string;
  markets: MarketOption[];
  stripe_ready: boolean;
  stripe_issues: Issue[];
  checkout_product_name: string | null;
  checkout_product_name_default: string;
  checkout_product_image: string | null;
  /** Story 15.7 — header do checkout. */
  checkout_logo_url: string | null;
  checkout_logo_height: number;
  checkout_logo_align: AppearanceState['checkout_logo_align'];
  brand_name: string | null;
  /** Story 15.6 — assinatura Stripe (editada em SubsConfig/StripeSubsConfig). */
  subscription?: { enabled: boolean; interval: string | null };
}

const URL_OF = (id: string) => `/api/landing-pages/${id}/checkout-settings`;

const KITS: ExternalKit[] = ['1', '3', '5'];
const PROVIDER_LABEL: Record<CheckoutProvider, string> = {
  shopify: 'Checkout: Shopify',
  stripe: 'Checkout: Stripe',
  external: 'Checkout: externo',
};

interface ExternalForm {
  urls: Record<ExternalKit, string>;
  defaultKit: '' | ExternalKit;
  allowSphereTracker: boolean;
}

function externalFormOf(cfg: ExternalCheckoutConfig | undefined): ExternalForm {
  return {
    urls: { '1': cfg?.['1'] ?? '', '3': cfg?.['3'] ?? '', '5': cfg?.['5'] ?? '' },
    defaultKit: cfg?.default ?? '',
    allowSphereTracker: cfg?.allowSphereTracker === true,
  };
}

const sameExternal = (a: ExternalForm, b: ExternalForm): boolean =>
  KITS.every((k) => a.urls[k].trim() === b.urls[k].trim()) &&
  a.defaultKit === b.defaultKit &&
  a.allowSphereTracker === b.allowSphereTracker;

export default function CheckoutSection({ landing, onLandingUpdate, onBanner }: Props): JSX.Element {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [marketId, setMarketId] = useState<string>(landing.marketId ?? '');
  const [provider, setProvider] = useState<CheckoutProvider>(landing.checkoutProvider);
  const [external, setExternal] = useState<ExternalForm>(() => externalFormOf(undefined));
  const [externalErrors, setExternalErrors] = useState<Array<{ kit: string; reason: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [productName, setProductName] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(URL_OF(landing.id));
    const body = (await res.json()) as SettingsResponse;
    if (!res.ok || !body.ok) {
      onBanner('critical', body.message ?? 'Falha ao carregar mercado e checkout.');
      return;
    }
    setData(body);
    setMarketId(body.market_id ?? '');
    setProvider(body.checkout_provider);
    setProductName(body.checkout_product_name ?? '');
    setExternal(externalFormOf(body.external_checkout));
  }, [landing.id, onBanner]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = data?.markets.find((m) => m.id === marketId) ?? null;
  const dirty =
    data !== null &&
    ((data.market_id ?? '') !== marketId ||
      data.checkout_provider !== provider ||
      (data.checkout_product_name ?? '') !== productName ||
      (provider === 'external' && !sameExternal(external, externalFormOf(data.external_checkout))));

  /** Aparência gravada automaticamente (upload/remoção/header) → estado local. */
  const onAppearanceSaved = useCallback(
    (patch: Partial<AppearanceState>) => {
      setData((prev) => (prev ? { ...prev, ...patch } : prev));
      if ('brand_name' in patch) onLandingUpdate({ brandTo: patch.brand_name ?? null });
    },
    [onLandingUpdate],
  );
  const currencyWillChange = selected !== null && selected.currency !== landing.currency;

  async function save(): Promise<void> {
    setSaving(true);
    setIssues([]);
    setExternalErrors([]);
    try {
      const res = await fetch(URL_OF(landing.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          market_id: marketId || null,
          checkout_provider: provider,
          checkout_product_name: productName,
          ...(provider === 'external'
            ? {
                external_checkout: {
                  '1': external.urls['1'].trim() || undefined,
                  '3': external.urls['3'].trim() || undefined,
                  '5': external.urls['5'].trim() || undefined,
                  default: external.defaultKit || undefined,
                  allowSphereTracker: external.allowSphereTracker,
                },
              }
            : {}),
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        message?: string;
        stripe_issues?: Issue[];
        external_errors?: Array<{ kit: string; reason: string }>;
        currency?: string;
        currency_changed?: boolean;
      };
      if (!res.ok || !body.ok) {
        setIssues(body.stripe_issues ?? []);
        setExternalErrors(body.external_errors ?? []);
        onBanner('critical', body.message ?? 'Não foi possível salvar.');
        return;
      }
      onLandingUpdate({
        marketId: marketId || null,
        checkoutProvider: provider,
        ...(body.currency ? { currency: body.currency } : {}),
      });
      onBanner(
        'success',
        body.currency_changed
          ? `Mercado salvo. A moeda da landing mudou para ${body.currency} — confira os preços das ofertas na seção Bundles.`
          : 'Mercado e checkout salvos.',
      );
      await load();
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const marketOptions = [
    { label: 'Sem mercado', value: '' },
    ...(data?.markets ?? [])
      .filter((m) => m.status === 'active' || m.id === data?.market_id)
      .map((m) => ({
        label: `${m.name} — ${m.locale.toUpperCase()} · ${m.currency}${m.status === 'archived' ? ' (arquivado)' : ''}`,
        value: m.id,
      })),
  ];


  return (
    <div data-section="checkout">
      <s-section>
        <s-stack gap="base">
          <EditorCardHeader
            title="Mercado e checkout"
            action={
              data ? (
                <s-badge tone={data.checkout_provider === 'shopify' ? 'info' : 'success'}>
                  {PROVIDER_LABEL[data.checkout_provider]}
                </s-badge>
              ) : null
            }
          />

          {!data && (
            <s-stack direction="inline" justifyContent="center">
              <s-spinner size="base" accessibilityLabel="Carregando" />
            </s-stack>
          )}

          {data && (
            <>
              {data.markets.length === 0 && (
                <EditorBanner tone="info">
                  Nenhum mercado cadastrado. Crie um em{' '}
                  <s-link href="/settings/conta/mercados">Configurações da conta → Mercados e moeda</s-link>{' '}
                  (ex.: Itália — italiano, EUR, frete grátis e expresso).
                </EditorBanner>
              )}

              <s-grid gridTemplateColumns="minmax(280px, 2fr) minmax(220px, 1fr)" gap="base" alignItems="start">
                <DsSelect
                  label="Mercado"
                  options={marketOptions}
                  value={marketId}
                  onChange={setMarketId}
                  disabled={saving}
                  details="Define idioma do checkout, moeda e frete."
                />
                <DsSelect
                  label="Checkout"
                  options={[
                    { label: 'Shopify', value: 'shopify' },
                    { label: 'Stripe', value: 'stripe' },
                    { label: 'Checkout externo', value: 'external' },
                  ]}
                  value={provider}
                  onChange={(v) => setProvider(v as CheckoutProvider)}
                  disabled={saving}
                />
              </s-grid>

              {provider === 'stripe' && (
                <s-stack gap="base">
                  <DsTextField
                    label="Nome do produto no checkout"
                    value={productName}
                    onChange={setProductName}
                    placeholder={data.checkout_product_name_default}
                    details={`Aparece no checkout e no pedido. Em branco usa "${data.checkout_product_name_default}" (título sem o nome da loja de origem).`}
                    disabled={saving}
                  />
                  <ProductImageBlock landingId={landing.id} image={data.checkout_product_image} onSaved={onAppearanceSaved} onBanner={onBanner} disabled={saving} />
                  <CheckoutHeaderBlock
                    landingId={landing.id}
                    state={{
                      checkout_product_image: data.checkout_product_image,
                      checkout_logo_url: data.checkout_logo_url,
                      checkout_logo_height: data.checkout_logo_height,
                      checkout_logo_align: data.checkout_logo_align,
                      brand_name: data.brand_name,
                    }}
                    onSaved={onAppearanceSaved}
                    onBanner={onBanner}
                    disabled={saving}
                  />
                </s-stack>
              )}

              {provider === 'external' && (
                <s-stack gap="base" data-testid="external-checkout-fields">
                  <s-paragraph color="subdued">
                    O botão de compra leva direto ao checkout do produtor (sem Stripe nem Shopify). Use os links
                    exatamente como no catálogo; UTMs e <s-text type="strong">ref</s-text> só seguem se já estiverem na
                    URL da página.
                  </s-paragraph>
                  {KITS.map((kit) => {
                    const err = externalErrors.find((e) => e.kit === kit);
                    return (
                      <DsTextField
                        key={kit}
                        label={`Checkout de ${kit} ${kit === '1' ? 'pote' : 'potes'}`}
                        value={external.urls[kit]}
                        onChange={(v) => setExternal((prev) => ({ ...prev, urls: { ...prev.urls, [kit]: v } }))}
                        placeholder="https://"
                        error={err ? err.reason : undefined}
                        disabled={saving}
                      />
                    );
                  })}
                  <DsSelect
                    label="Kit padrão (quando o botão não indica o kit)"
                    options={[
                      { label: 'Automático (1 pote, senão o primeiro disponível)', value: '' },
                      ...KITS.map((k) => ({ label: `${k} ${k === '1' ? 'pote' : 'potes'}`, value: k })),
                    ]}
                    value={external.defaultKit}
                    onChange={(v) => setExternal((prev) => ({ ...prev, defaultKit: v as ExternalForm['defaultKit'] }))}
                    disabled={saving}
                  />
                  <DsCheckbox
                    label="Usar tracker do Sphere (terceiro, opcional)"
                    checked={external.allowSphereTracker}
                    onChange={(checked) => setExternal((prev) => ({ ...prev, allowSphereTracker: checked }))}
                    details="Script de terceiro (sphereaffiliate.com). Desligado por padrão; o Blackshop não precisa dele."
                    disabled={saving}
                  />
                  {external.allowSphereTracker && (
                    <EditorBanner tone="warning">
                      O tracker do Sphere é um script de terceiro e roda na página do visitante. Ligue só se a oferta exigir.
                    </EditorBanner>
                  )}
                  {externalErrors.some((e) => e.kit === 'config' || e.kit === 'default') && (
                    <EditorBanner tone="critical" title="Checkout externo">
                      <s-unordered-list>
                        {externalErrors
                          .filter((e) => e.kit === 'config' || e.kit === 'default')
                          .map((e) => (
                            <s-list-item key={`${e.kit}-${e.reason}`}>{e.reason}</s-list-item>
                          ))}
                      </s-unordered-list>
                    </EditorBanner>
                  )}
                </s-stack>
              )}

              {currencyWillChange && (
                <EditorBanner tone="warning">
                  O mercado{' '}
                  <s-text type="strong" fontWeight="bold">
                    {selected?.name}
                  </s-text>{' '}
                  usa{' '}
                  <s-text type="strong" fontWeight="bold">
                    {selected?.currency}
                  </s-text>{' '}
                  e a landing está em{' '}
                  <s-text type="strong" fontWeight="bold">
                    {landing.currency}
                  </s-text>
                  . Ao salvar, a moeda da landing muda para {selected?.currency}. Os valores das ofertas{' '}
                  <s-text type="strong" fontWeight="bold">
                    não
                  </s-text>{' '}
                  são convertidos — confira na seção Bundles.
                </EditorBanner>
              )}

              {provider === 'stripe' && (
                <EditorBanner tone="info">
                  Com Stripe, o botão de compra leva ao checkout próprio no domínio da landing (idioma, moeda e
                  frete do mercado). Use cartões de teste enquanto a conta estiver em modo de teste.
                </EditorBanner>
              )}

              {provider === 'stripe' && (
                <s-paragraph color="subdued">
                  Assinatura (Subscribe &amp; Save) com Stripe: configure intervalo e desconto na seção
                  &quot;Subscription&quot; depois de salvar o checkout como Stripe. Ao salvar, o widget entra no ar
                  sozinho em cerca de 1 minuto (sem republicar).
                </s-paragraph>
              )}

              {provider === 'stripe' && data.subscription?.enabled && !data.subscription.interval && (
                <EditorBanner tone="warning">
                  Subscribe &amp; Save está ligado sem intervalo de cobrança: no checkout Stripe o widget de
                  assinatura não aparece até você escolher o intervalo na seção &quot;Subscription&quot;.
                </EditorBanner>
              )}

              {provider === 'stripe' && issues.length === 0 && !data.stripe_ready && data.checkout_provider !== 'stripe' && (
                <s-paragraph color="subdued">
                  Para usar Stripe, a landing precisa de: conta Stripe ativa, mercado com a mesma moeda e ofertas com
                  preço. O sistema confere ao salvar.
                </s-paragraph>
              )}

              {issues.length > 0 && (
                <EditorBanner tone="critical" title="Falta para usar o checkout Stripe">
                  <s-unordered-list>
                    {issues.map((i) => (
                      <s-list-item key={i.code}>{i.message}</s-list-item>
                    ))}
                  </s-unordered-list>
                </EditorBanner>
              )}

              <s-stack direction="inline" gap="small-200">
                <DsButton variant="secondary" onClick={() => void save()} loading={saving} disabled={!dirty || saving}>
                  Salvar
                </DsButton>
                {dirty && (
                  <DsButton
                    variant="tertiary"
                    onClick={() => {
                      setMarketId(data.market_id ?? '');
                      setProvider(data.checkout_provider);
                      setProductName(data.checkout_product_name ?? '');
                      setExternal(externalFormOf(data.external_checkout));
                      setExternalErrors([]);
                      setIssues([]);
                    }}
                    disabled={saving}
                  >
                    Cancelar
                  </DsButton>
                )}
              </s-stack>
            </>
          )}
        </s-stack>
      </s-section>
    </div>
  );
}
