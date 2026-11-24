'use client';

// @ds-migrated — Story 20.10b (PR3): seção "Bundles / Ofertas" no design system.
//
// BundlesSection — Bundle Engine V2 (set/2026).
//
// Editor completo de ofertas: preço, riscado, save text, badge, qty, variant.
// Fonte de verdade: landing_bundle_offers (não HTML).
//
// Status detecção mostrado no topo: "Kaching detectado, 3 ofertas".
// Se o adapter não detectou nada, dá para reclonar ou cadastrar as ofertas à mão aqui
// (Adicionar oferta / Remover). As posições são renumeradas 0..n-1 a cada mudança.
//
// Story 20.10b — só visual: carga, PUT (com a linha de base e o polling de 30 s), PATCH da Engine V2 e
// avisos iguais a antes. A tabela vira s-table com um campo por célula (rótulo só para leitor de tela) e
// rola DENTRO do cartão quando não cabe (8 colunas).
//
// Story 25.1 — escolha "Usar ofertas da página" / "Usar minhas ofertas" (offers_source), colunas
// Bullets (um por linha) e Link do botão por oferta, posição do bloco do sistema (AC 4–7).

import { useCallback, useEffect, useState } from 'react';
import { centsToDecimal, currencySymbol, formatPrice, minorUnitsToMajor } from '@blackshop/pricing';
import { OFFER_BULLETS_MAX, OFFER_BULLET_MAX_LEN, parseBulletsText, type OffersSource } from '@blackshop/shared/landing-offers';

import { EditorBanner, EditorCardHeader } from '../_components/EditorCard';

import { DsButton, DsSelect, DsTextArea, DsTextField } from '@/components/ds';
import type { OffersAnchorMode, OffersPlacementConfig } from '@/lib/landing-offers-placement';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
  onBanner: (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ) => void;
}

interface OfferRow {
  id?: string;
  position: number;
  title: string;
  qty: number;
  priceCents: number;
  compareAtCents: number | null;
  saveText: string | null;
  badge: string | null;
  variantId: string | null;
  isPreselected: boolean;
  bullets: string[];
  checkoutUrl: string | null;
  /** Só no editor: texto cru do campo Bullets (um por linha). */
  bulletsText: string;
  /** Vindo do GET: o card original tem lista de bullets marcada. */
  bulletsMarked?: boolean;
}

interface BundleData {
  currency: string;
  useNewBundleEngine: boolean;
  bundleAdapter: string | null;
  bundleAdapterNotes: string | null;
  offersSource: OffersSource;
  placement: OffersPlacementConfig;
  hasBundleRoot: boolean;
  offers: OfferRow[];
}

interface OfferFieldError {
  index: number;
  field: string;
  message: string;
}

const ANCHOR_OPTIONS: { value: OffersAnchorMode; label: string }[] = [
  { value: 'auto', label: 'No lugar do bloco detectado' },
  { value: 'price', label: 'Abaixo do preço' },
  { value: 'title', label: 'Abaixo do título do produto' },
  { value: 'selector', label: 'Seletor CSS manual' },
];

function toRow(o: Partial<OfferRow> & { position: number }): OfferRow {
  const bullets = Array.isArray(o.bullets) ? o.bullets : [];
  return {
    id: o.id,
    position: o.position,
    title: o.title ?? '',
    qty: o.qty ?? 1,
    priceCents: o.priceCents ?? 0,
    compareAtCents: o.compareAtCents ?? null,
    saveText: o.saveText ?? null,
    badge: o.badge ?? null,
    variantId: o.variantId ?? null,
    isPreselected: o.isPreselected ?? false,
    bullets,
    checkoutUrl: o.checkoutUrl ?? null,
    bulletsText: bullets.join('\n'),
    bulletsMarked: o.bulletsMarked,
  };
}

// Fase 8C · Landing Lab Stabilization: fonte única @blackshop/pricing.
// Overrides locais mantidos pras 4 moedas onde o pacote (Intl) diverge
// do que o backoffice UI mostra desde sempre (bate com worker apply-bundle):
//   CAD='C$' (pacote='$'), AUD='A$' (pacote='$'),
//   CHF='CHF ' (pacote='CHF'), DKK='kr' (pacote='kr.')
//
// Fase 8E (currency-aware pricing): JPY e outras zero-decimal usam
// Intl.NumberFormat via formatPrice pra render correto (¥7,980 vs ¥79.80).
// Para as 4 moedas com override histórico, mantemos símbolo customizado +
// major units via minorUnitsToMajor (continua 2 casas pros overrides).
const CURRENCY_OVERRIDES: Record<string, string> = {
  CAD: 'C$',
  AUD: 'A$',
  CHF: 'CHF ',
  DKK: 'kr',
};
function symbolFor(currency: string): string {
  const upper = currency.toUpperCase();
  return CURRENCY_OVERRIDES[upper] ?? currencySymbol(upper);
}
function formatCents(cents: number, currency: string): string {
  const upper = currency.toUpperCase();
  // Overrides mantém símbolo custom + 2 casas decimais (comportamento histórico).
  if (CURRENCY_OVERRIDES[upper]) {
    return `${symbolFor(currency)}${centsToDecimal(cents)}`;
  }
  // Resto: Intl formatPrice (trata JPY=0, USD/EUR=2 corretamente).
  return formatPrice(minorUnitsToMajor(cents, currency), currency);
}

export default function BundlesSection({ landing, onBanner }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<BundleData | null>(null);
  const [edits, setEdits] = useState<OfferRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [pollDone, setPollDone] = useState(false);
  const [source, setSource] = useState<OffersSource>('page');
  const [placement, setPlacement] = useState<OffersPlacementConfig>({ anchor: 'auto' });
  const [fieldErrors, setFieldErrors] = useState<OfferFieldError[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/bundle-offers`, { signal: ctrl.signal });
      const json = (await res.json()) as { ok: boolean; message?: string } & Partial<BundleData>;
      if (!res.ok || !json.ok) {
        onBanner('critical', json.message ?? 'Falha ao carregar ofertas.');
        return;
      }
      const d: BundleData = {
        currency: json.currency ?? landing.currency,
        useNewBundleEngine: json.useNewBundleEngine ?? false,
        bundleAdapter: json.bundleAdapter ?? null,
        bundleAdapterNotes: json.bundleAdapterNotes ?? null,
        offersSource: json.offersSource === 'system' ? 'system' : 'page',
        placement: json.placement ?? { anchor: 'auto' },
        hasBundleRoot: json.hasBundleRoot ?? false,
        offers: (json.offers ?? []).map((o) => toRow(o)),
      };
      setData(d);
      // As ofertas detectadas na clonagem já são a lista inicial do modo "sistema" (mesma tabela).
      setEdits(d.offers.map((o) => ({ ...o })));
      setSource(d.offersSource);
      setPlacement(d.placement);
      setFieldErrors([]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBanner('critical', msg.includes('aborted') ? 'Tempo limite excedido ao carregar ofertas.' : msg);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, [landing.id, landing.currency, onBanner]);

  useEffect(() => {
    if (expanded && !data) void fetchData();
  }, [expanded, data, fetchData]);

  const updateOffer = useCallback((position: number, patch: Partial<OfferRow>) => {
    setEdits((prev) => prev.map((o) => (o.position === position ? { ...o, ...patch } : o)));
  }, []);

  const addOffer = useCallback(() => {
    setEdits((prev) => [
      ...prev,
      {
        position: prev.length,
        title: '',
        qty: prev.length + 1,
        priceCents: 0,
        compareAtCents: null,
        saveText: null,
        badge: null,
        variantId: null,
        isPreselected: prev.length === 0,
        bullets: [],
        checkoutUrl: null,
        bulletsText: '',
      },
    ]);
  }, []);

  const removeOffer = useCallback((position: number) => {
    setEdits((prev) => {
      const rest = prev.filter((o) => o.position !== position).map((o, i) => ({ ...o, position: i }));
      // Mantém uma oferta pré-selecionada se a removida era a escolhida.
      if (rest.length > 0 && !rest.some((o) => o.isPreselected)) rest[0] = { ...rest[0]!, isPreselected: true };
      return rest;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    let beforeUpdatedAt: string | null = null;
    try {
      const preCtrl = new AbortController();
      const preTimer = setTimeout(() => preCtrl.abort(), 10000);
      try {
        const preRes = await fetch(`/api/landing-pages/${landing.id}/bundle-offers`, { signal: preCtrl.signal });
        const preJson = (await preRes.json()) as { landingUpdatedAt?: string | null };
        beforeUpdatedAt = preJson.landingUpdatedAt ?? null;
      } catch { /* Sem baseline, poll funciona com null */ }
      finally { clearTimeout(preTimer); }
    } catch { /* silêncio */ }
    const saveCtrl = new AbortController();
    const saveTimer = setTimeout(() => saveCtrl.abort(), 20000);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/bundle-offers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offers: edits.map(({ bulletsText, bulletsMarked: _marked, ...o }) => ({
            ...o,
            bullets: parseBulletsText(bulletsText),
            checkoutUrl: o.checkoutUrl?.trim() || null,
          })),
          offersSource: source,
          placement,
        }),
        signal: saveCtrl.signal,
      });
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        errors?: OfferFieldError[];
        count?: number;
        placement?: OffersPlacementConfig | null;
        reprocessing?: boolean;
        deduped?: boolean;
      };
      if (!res.ok || !json.ok) {
        setFieldErrors(json.errors ?? []);
        onBanner('critical', json.message ?? 'Falha ao salvar ofertas.');
        return;
      }
      setFieldErrors([]);
      const placementWarning =
        source === 'system' && json.placement
          ? json.placement.anchorOk === false
            ? ' A posição escolhida não foi encontrada na página: o bloco do sistema não vai aparecer até ajustar.'
            : json.placement.removeOk === false
              ? ' O seletor do bloco a remover não casou com exatamente 1 elemento: nada foi removido.'
              : ''
          : '';
      if (placementWarning) onBanner('warning', placementWarning.trim());
      if (json.reprocessing) {
        setPollDone(false);
        onBanner(
          'info',
          `${json.count ?? edits.length} ofertas salvas. Atualizando página publicada${json.deduped ? ' (job já em andamento)' : ''}...`,
        );
        // Poll a cada 2s pra detectar quando worker terminou (updatedAt muda).
        // Timeout 30s (worker leva ~10-15s). Se timeout, mostra fallback + botão "Verificar agora".
        void (async () => {
          for (let i = 0; i < 15; i += 1) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const pollRes = await fetch(`/api/landing-pages/${landing.id}/bundle-offers`);
              const pollJson = (await pollRes.json()) as { landingUpdatedAt?: string | null };
              if (pollJson.landingUpdatedAt && pollJson.landingUpdatedAt !== beforeUpdatedAt) {
                onBanner('success', 'Página publicada atualizada com os novos preços.');
                setPollDone(true);
                return;
              }
            } catch {
              // ignora — continua polling
            }
          }
          setPollDone(true);
          onBanner(
            'warning',
            'Preços salvos, mas o reprocessamento demorou mais que 30s. Recarregue a landing publicada em ~1min pra ver.',
          );
        })();
      } else {
        onBanner(
          'warning',
          `${json.count ?? edits.length} ofertas salvas, mas reprocessamento não foi enfileirado (Redis/worker indisponível). Use "Recalcular preços" quando estiver acessível.`,
        );
      }
      setData(null); // forçar refetch na próxima abertura
      setExpanded(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onBanner('critical', msg.includes('aborted') ? 'Tempo limite excedido ao salvar. Tente novamente.' : msg);
    } finally {
      clearTimeout(saveTimer);
      setIsSaving(false);
    }
  }, [landing.id, edits, source, placement, onBanner]);

  const errorFor = useCallback(
    (index: number, field: string) => fieldErrors.find((e) => e.index === index && e.field === field)?.message,
    [fieldErrors],
  );

  const toggleEngine = useCallback(async (next: boolean) => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/bundle-offers`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ useNewBundleEngine: next }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (!res.ok || !json.ok) {
        onBanner('critical', json.message ?? 'Falha ao alternar engine.');
        return;
      }
      onBanner('success', `Engine V2 ${next ? 'LIGADA' : 'DESLIGADA'}.`);
      setData(null);
      void fetchData();
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [landing.id, onBanner, fetchData]);


  return (
    <s-section>
      <s-stack gap="base">
        <EditorCardHeader
          title="Bundles / Ofertas"
          badges={
            <>
              {data && data.bundleAdapter && data.bundleAdapter !== 'none' && (
                <s-badge tone="success">{`${data.bundleAdapter} · ${data.offers.length} ofertas`}</s-badge>
              )}
              {data && (data.bundleAdapter === 'none' || data.bundleAdapter == null) && <s-badge tone="caution">Não detectado</s-badge>}
            </>
          }
          action={
            <DsButton variant="secondary" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Fechar' : 'Editar'}
            </DsButton>
          }
        />

        {!expanded && <s-paragraph color="subdued">Preço, moeda e destino de compra dos bundles. Ofertas detectadas ao clonar.</s-paragraph>}

        {expanded && loading && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Carregando ofertas" />
            <s-text>Carregando ofertas…</s-text>
          </s-stack>
        )}

        {expanded && !loading && data && (
          <s-stack gap="base">
            <EditorBanner tone={data.useNewBundleEngine ? 'success' : 'warning'}>
              <s-stack gap="small-200">
                <s-paragraph>
                  <s-text type="strong" fontWeight="bold">
                    Status:
                  </s-text>{' '}
                  {data.bundleAdapterNotes ?? 'Sem detecção ainda (adapter não rodou).'}
                  <br />
                  <s-text type="strong" fontWeight="bold">
                    Engine V2:
                  </s-text>{' '}
                  {data.useNewBundleEngine
                    ? 'LIGADA (storefront usa banco, ignora scripts do concorrente)'
                    : 'DESLIGADA (storefront usa HTML original)'}
                </s-paragraph>
                <s-stack direction="inline">
                  <DsButton variant="secondary" onClick={() => toggleEngine(!data.useNewBundleEngine)} disabled={isSaving}>
                    {data.useNewBundleEngine ? 'Desligar Engine V2' : 'Ligar Engine V2'}
                  </DsButton>
                </s-stack>
              </s-stack>
            </EditorBanner>

            <s-stack gap="small-200">
              <DsSelect
                label="Ofertas exibidas na landing"
                value={source}
                options={[
                  { value: 'page', label: 'Usar ofertas da página' },
                  { value: 'system', label: 'Usar minhas ofertas' },
                ]}
                onChange={(v) => setSource(v === 'system' ? 'system' : 'page')}
                disabled={isSaving}
                details={
                  source === 'system'
                    ? 'O bloco de ofertas original sai da página e entra um bloco próprio com as ofertas abaixo, nas cores e fontes da landing.'
                    : 'Mantém o bloco original da página; título, preço, riscado, save, badge e bullets são trocados onde o card tiver o campo.'
                }
              />
              {source === 'system' && (
                <>
                  {!data.hasBundleRoot && placement.anchor === 'auto' && (
                    <EditorBanner tone="warning" title="Escolha onde o bloco entra">
                      Esta clonagem não marcou o bloco de ofertas original. Escolha a posição do bloco do sistema
                      abaixo; sem posição, a página continua com as ofertas originais.
                    </EditorBanner>
                  )}
                  <DsSelect
                    label="Posição do bloco do sistema"
                    value={placement.anchor}
                    options={ANCHOR_OPTIONS}
                    onChange={(v) => setPlacement((p) => ({ ...p, anchor: v as OffersAnchorMode }))}
                    disabled={isSaving}
                    error={
                      data.placement.anchor === placement.anchor && placement.anchor !== 'auto' && data.placement.anchorOk === false
                        ? 'A posição salva não foi encontrada na página.'
                        : undefined
                    }
                  />
                  {placement.anchor === 'selector' && (
                    <DsTextField
                      label="Seletor CSS da âncora (o bloco entra logo depois)"
                      value={placement.anchorSelector ?? ''}
                      onChange={(v) => setPlacement((p) => ({ ...p, anchorSelector: v || undefined }))}
                      disabled={isSaving}
                      maxLength={300}
                      placeholder=".product__info .price"
                      details="Precisa casar com exatamente 1 elemento."
                    />
                  )}
                  <DsTextField
                    label="Seletor CSS do bloco a remover (opcional)"
                    value={placement.removeSelector ?? ''}
                    onChange={(v) => setPlacement((p) => ({ ...p, removeSelector: v || undefined }))}
                    disabled={isSaving}
                    maxLength={300}
                    placeholder=".product-form__bundles"
                    details="Precisa casar com exatamente 1 elemento; nunca body, main ou html."
                    error={
                      data.placement.removeSelector && data.placement.removeSelector === placement.removeSelector && data.placement.removeOk === false
                        ? 'Este seletor não casou com exatamente 1 elemento: nada foi removido.'
                        : undefined
                    }
                  />
                </>
              )}
            </s-stack>

            {edits.length === 0 && (
              <EditorBanner tone="warning" title="Nenhuma oferta">
                Nenhuma oferta detectada ao clonar. Clique em &quot;Adicionar
                oferta&quot;, preencha título, quantidade e preço de cada uma,
                salve e ligue a Engine V2. Depois, na seção Publicação, use
                &quot;Publicar landing + criar produto Shopify&quot; para criar as
                variantes.
              </EditorBanner>
            )}

            {edits.length > 0 && (
              <>
                <s-paragraph color="subdued">
                  {edits.length} oferta(s). Moeda: {data.currency}. Preços em
                  cents (3990 = 39.90). Deixe compare/save/badge vazios se
                  não quiser mostrar. O link do botão, se preenchido, tem
                  prioridade sobre o destino da seção Checkout.
                </s-paragraph>
                <div className="ds-table-scroll">
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>#</s-table-header>
                      <s-table-header listSlot="primary">Título</s-table-header>
                      <s-table-header>Qtd</s-table-header>
                      <s-table-header>Preço</s-table-header>
                      <s-table-header>Riscado</s-table-header>
                      <s-table-header>Save</s-table-header>
                      <s-table-header>Badge</s-table-header>
                      <s-table-header>Variant Shopify</s-table-header>
                      <s-table-header>Bullets</s-table-header>
                      <s-table-header>Link do botão</s-table-header>
                      <s-table-header>Ações</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {edits.map((o) => {
                        const n = o.position + 1;
                        return (
                          <s-table-row key={o.position}>
                            <s-table-cell>
                              <span className="ds-bundle-field ds-bundle-field--index">
                                <s-badge>{`${n}`}</s-badge>
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field ds-bundle-field--wide">
                                <DsTextField label={`Título da oferta ${n}`} labelHidden value={o.title} onChange={(v) => updateOffer(o.position, { title: v })} disabled={isSaving} />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field ds-bundle-field--narrow">
                                <DsTextField
                                  labelHidden
                                  label={`Quantidade da oferta ${n}`}
                                  value={String(o.qty)}
                                  onChange={(v) => updateOffer(o.position, { qty: Math.max(1, parseInt(v || '1', 10)) })}
                                  disabled={isSaving}
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field">
                                <DsTextField
                                  labelHidden
                                  label={`Preço da oferta ${n} (cents)`}
                                  value={String(o.priceCents)}
                                  onChange={(v) => updateOffer(o.position, { priceCents: Math.max(0, parseInt(v || '0', 10)) })}
                                  disabled={isSaving}
                                  details={formatCents(o.priceCents, data.currency)}
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field">
                                <DsTextField
                                  labelHidden
                                  label={`Preço riscado da oferta ${n} (cents)`}
                                  value={o.compareAtCents == null ? '' : String(o.compareAtCents)}
                                  onChange={(v) =>
                                    updateOffer(o.position, {
                                      compareAtCents: v ? Math.max(0, parseInt(v, 10)) : null,
                                    })
                                  }
                                  disabled={isSaving}
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field">
                                <DsTextField
                                  label={`Texto de economia da oferta ${n}`}
                                  labelHidden
                                  value={o.saveText ?? ''}
                                  onChange={(v) => updateOffer(o.position, { saveText: v || null })}
                                  disabled={isSaving}
                                  placeholder="SAVE 33%"
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field">
                                <DsTextField
                                  label={`Selo da oferta ${n}`}
                                  labelHidden
                                  value={o.badge ?? ''}
                                  onChange={(v) => updateOffer(o.position, { badge: v || null })}
                                  disabled={isSaving}
                                  placeholder="Mais vendido"
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field">
                                <DsTextField
                                  label={`Variante Shopify da oferta ${n}`}
                                  labelHidden
                                  value={o.variantId ?? ''}
                                  onChange={(v) => updateOffer(o.position, { variantId: v || null })}
                                  disabled={isSaving}
                                  placeholder="ID do variante Shopify"
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field ds-bundle-field--wide">
                                <DsTextArea
                                  label={`Bullets da oferta ${n} (um por linha)`}
                                  labelHidden
                                  rows={3}
                                  value={o.bulletsText}
                                  onChange={(v) => updateOffer(o.position, { bulletsText: v })}
                                  disabled={isSaving}
                                  placeholder="Um por linha"
                                  error={errorFor(o.position, 'bullets')}
                                  details={
                                    source === 'page' && !o.bulletsMarked && o.bulletsText.trim()
                                      ? 'Este card não tem lista; use Minhas ofertas para exibir bullets.'
                                      : `Até ${OFFER_BULLETS_MAX}, com ${OFFER_BULLET_MAX_LEN} caracteres cada.`
                                  }
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <span className="ds-bundle-field ds-bundle-field--wide">
                                <DsTextField
                                  label={`Link do botão da oferta ${n}`}
                                  labelHidden
                                  value={o.checkoutUrl ?? ''}
                                  onChange={(v) => updateOffer(o.position, { checkoutUrl: v || null })}
                                  disabled={isSaving}
                                  placeholder="https://… (opcional)"
                                  error={errorFor(o.position, 'checkoutUrl')}
                                />
                              </span>
                            </s-table-cell>
                            <s-table-cell>
                              <DsButton variant="tertiary" onClick={() => removeOffer(o.position)} disabled={isSaving} accessibilityLabel={`Remover oferta ${n}`}>
                                Remover
                              </DsButton>
                            </s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>
                </div>
              </>
            )}

            <s-stack direction="inline" gap="small-200">
              <DsButton variant="secondary" onClick={addOffer} disabled={isSaving}>
                Adicionar oferta
              </DsButton>
              <DsButton variant="secondary" onClick={handleSave} loading={isSaving} disabled={isSaving}>
                Salvar ofertas
              </DsButton>
              {/* Botão verificar: aparece após poll timeout (SB-05) */}
              {pollDone && (
                <DsButton
                  variant="secondary"
                  onClick={() => {
                    setPollDone(false);
                    setData(null);
                    void fetchData();
                  }}
                  disabled={isSaving || loading}
                >
                  Verificar agora
                </DsButton>
              )}
              <DsButton
                variant="tertiary"
                onClick={() => {
                  setExpanded(false);
                  setData(null);
                }}
                disabled={isSaving}
              >
                Fechar
              </DsButton>
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}
