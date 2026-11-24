'use client';

// @ds-migrated — Story 20.13b (PR D): painel do editor semântico no design system. SÓ VISUAL: estado,
// `callSemanticWrite`, `handleOpen`/`handleSave` (texto e imagem), htmlSha encadeado e as regras de
// "pode editar" são os de antes, linha a linha. Mudou o JSX: `DsPageHeader` (título 26px/700, "Voltar" como
// breadcrumb, "Voltar ao editor clássico" como a primária), cartões `s-section`, selos `DsToneBadge`,
// avisos `s-banner`, modais `DsModal` (montados só quando abertos, como o Modal do Polaris React), campos
// `DsTextField`/`DsTextArea`, dicas dos botões desabilitados em `s-tooltip`, detalhes técnicos montados
// só quando abertos (como o Collapsible).
//
// Semantic Editor V1 — Sprint Final (write-enabled shell).
//
// UX: apresenta PageSemanticModel em 4 áreas:
//   1. Health summary
//   2. Conteúdo (text blocks) — editável quando LANDINGLAB_SEMANTIC_WRITES=true
//   3. Imagens (image slots) — substituível quando LANDINGLAB_SEMANTIC_WRITES=true
//   4. Ofertas + Configuração

import { useCallback, useState } from 'react';
import type {
  PageSemanticModel,
  SemanticImageSlot,
  SemanticTextBlock,
  RegionEntry,
} from '@blackshop/landinglab-adapters';

import { DsButton, DsModal, DsPageHeader, DsTextArea, DsTextField, DsToneBadge, PolarisGate } from '@/components/ds';

interface LandingSummary {
  id: string;
  slug: string | null;
  title: string | null;
  landingKind: string | null;
  currency: string | null;
  htmlBytes: number;
}

interface Props {
  landing: LandingSummary;
  model: PageSemanticModel;
  meta: {
    latencyMs: number;
    mapperError: string | null;
  };
  htmlSha: string;
  semanticWritesEnabled: boolean;
}

export default function SemanticShellPanel({
  landing,
  model,
  meta,
  htmlSha: initialHtmlSha,
  semanticWritesEnabled,
}: Props): JSX.Element {
  // htmlSha é o concurrency token — atualizado após cada write bem-sucedido.
  const [htmlSha, setHtmlSha] = useState(initialHtmlSha);

  return (
    <PolarisGate>
      <s-page>
        <DsPageHeader
          title={landing.title ?? landing.slug ?? 'Landing sem título'}
          breadcrumb={<s-link href={`/landing-pages/${landing.id}/editor`}>Voltar</s-link>}
          primaryAction={
            <DsButton variant="primary" href={`/landing-pages/${landing.id}/editor`}>
              Voltar ao editor clássico
            </DsButton>
          }
        />
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {`Editor semântico V1 · ${semanticWritesEnabled ? 'write-enabled' : 'read-only'} · ${landing.id}`}
          </s-paragraph>

          {!semanticWritesEnabled && (
            <s-banner tone="info" heading="Editor semântico V1 (read-only)">
              <s-paragraph>
                Esta é a nova visão baseada em PageSemanticModel. Nesta versão as
                ações de edição estão <strong>desabilitadas</strong> — preview do fluxo
                futuro. O editor clássico continua sendo autoritativo.
              </s-paragraph>
            </s-banner>
          )}

          {meta.mapperError && (
            <s-banner tone="critical" heading="Semantic mapper error">
              <s-paragraph>{meta.mapperError}</s-paragraph>
            </s-banner>
          )}

          <HealthSummaryCard model={model} landing={landing} meta={meta} />

          <ContentCard
            textBlocks={model.textBlocks}
            landingId={landing.id}
            htmlSha={htmlSha}
            setHtmlSha={setHtmlSha}
            semanticWritesEnabled={semanticWritesEnabled}
          />

          <ImagesCard
            slots={model.imageSlots}
            landingId={landing.id}
            htmlSha={htmlSha}
            setHtmlSha={setHtmlSha}
            semanticWritesEnabled={semanticWritesEnabled}
          />

          <CommercialCard model={model} landing={landing} />

          <DebugCard model={model} />
        </s-stack>
      </s-page>
    </PolarisGate>
  );
}

// ────────────────────────────────────────────────────────────────
// Health Summary
// ────────────────────────────────────────────────────────────────

function HealthSummaryCard({
  model,
  landing,
  meta,
}: {
  model: PageSemanticModel;
  landing: LandingSummary;
  meta: Props['meta'];
}): JSX.Element {
  const healthTone: 'success' | 'warning' | 'critical' =
    model.criticalRegionsHealthy && model.warnings.length === 0
      ? 'success'
      : model.warnings.some((w) => w.severity === 'error')
      ? 'critical'
      : 'warning';

  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Saúde semântica</s-heading>
          <DsToneBadge tone={healthTone}>
            {healthTone === 'success' ? 'Healthy' : healthTone === 'warning' ? 'Warning' : 'Critical'}
          </DsToneBadge>
        </s-stack>
        <s-divider />

        <s-stack direction="inline" gap="large">
          <Metric label="Family" value={model.family} tone={model.familySource === 'user_hint' ? 'success' : 'info'} />
          <Metric label="Family source" value={model.familySource} />
          <Metric label="Family confidence" value={pct(model.familyConfidence)} />
          <Metric label="Overall confidence" value={pct(model.overallConfidence)} />
          <Metric
            label="Critical healthy"
            value={model.criticalRegionsHealthy ? 'Yes' : 'No'}
            tone={model.criticalRegionsHealthy ? 'success' : 'critical'}
          />
          <Metric label="Components" value={String(model.components.length)} />
          <Metric label="Regions" value={String(model.regions.length)} />
          <Metric label="Warnings" value={String(model.warnings.length)} tone={model.warnings.length > 0 ? 'warning' : undefined} />
          <Metric label="Conflicts" value={String(model.conflicts.length)} tone={model.conflicts.length > 0 ? 'warning' : undefined} />
          <Metric label="Unclassified" value={String(model.unclassified.length)} />
          <Metric label="HTML bytes" value={landing.htmlBytes.toLocaleString()} />
          <Metric label="Latency" value={`${meta.latencyMs}ms`} />
        </s-stack>

        {model.components.length > 0 && (
          <>
            <s-divider />
            <s-stack gap="small-200">
              <s-heading>Componentes detectados</s-heading>
              {model.components.map((c) => (
                <s-stack key={c.componentId} direction="inline" gap="small-200" alignItems="center">
                  <DsToneBadge tone="success">{c.componentId}</DsToneBadge>
                  <s-text color="subdued">
                    {`score=${c.score.toFixed(2)} · cards=${c.cards} · confidence=${pct(c.overallConfidence)}`}
                  </s-text>
                </s-stack>
              ))}
            </s-stack>
          </>
        )}
      </s-stack>
    </s-section>
  );
}

// ────────────────────────────────────────────────────────────────
// Content (text blocks)
// ────────────────────────────────────────────────────────────────

interface WriteProps {
  landingId: string;
  htmlSha: string;
  setHtmlSha: (sha: string) => void;
  semanticWritesEnabled: boolean;
}

const ALLOWED_TEXT_KINDS = new Set([
  'headline', 'subheadline', 'product_title', 'cta_label',
  'article_paragraph', 'faq_question', 'faq_answer',
]);

const ALLOWED_IMAGE_KINDS = new Set([
  'product_main', 'gallery_image', 'advertorial_image', 'section_image',
]);

async function callSemanticWrite(
  landingId: string,
  body: Record<string, string>,
): Promise<{ ok: boolean; newHtmlSha?: string; error?: string }> {
  const res = await fetch(`/api/landing-pages/${landingId}/semantic-write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { ok?: boolean; newHtmlSha?: string; error?: string };
  if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  return { ok: true, newHtmlSha: json.newHtmlSha };
}

function ContentCard({
  textBlocks,
  landingId,
  htmlSha,
  setHtmlSha,
  semanticWritesEnabled,
}: { textBlocks: SemanticTextBlock[] } & WriteProps): JSX.Element {
  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Conteúdo</s-heading>
          <DsToneBadge>{`${textBlocks.length} campos`}</DsToneBadge>
        </s-stack>
        <s-divider />

        {textBlocks.length === 0 ? (
          <s-paragraph color="subdued">
            Nenhum bloco de texto semântico foi identificado. Isso é normal se
            a landing não tem article/faq/CTA reconhecidos.
          </s-paragraph>
        ) : (
          <s-stack gap="small-100">
            {textBlocks.map((block) => (
              <TextBlockRow
                key={block.id}
                block={block}
                landingId={landingId}
                htmlSha={htmlSha}
                setHtmlSha={setHtmlSha}
                semanticWritesEnabled={semanticWritesEnabled}
              />
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

function TextBlockRow({
  block,
  landingId,
  htmlSha,
  setHtmlSha,
  semanticWritesEnabled,
}: { block: SemanticTextBlock } & WriteProps): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState(block.content);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canEdit = semanticWritesEnabled && ALLOWED_TEXT_KINDS.has(block.blockKind);

  const handleOpen = useCallback(() => {
    setDraft(block.content);
    setSaveError(null);
    setModalOpen(true);
  }, [block.content]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const result = await callSemanticWrite(landingId, {
      instanceId: block.instanceId,
      mutationKind: 'text',
      value: draft,
      htmlSha,
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error ?? 'Erro desconhecido');
      return;
    }
    if (result.newHtmlSha) setHtmlSha(result.newHtmlSha);
    setModalOpen(false);
  }, [landingId, block.id, draft, htmlSha, setHtmlSha]);

  return (
    <>
      <s-box padding="small" border="base" borderRadius="base" background="subdued">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <DsToneBadge tone="info">{humanizeBlockKind(block.blockKind)}</DsToneBadge>
            {block.regionKind && (
              <DsToneBadge>{`region: ${block.regionKind}`}</DsToneBadge>
            )}
            <s-text color="subdued">{`confidence: ${pct(block.confidence)}`}</s-text>
          </s-stack>
          <s-paragraph>{truncateText(block.content, 260)}</s-paragraph>
          <s-stack direction="inline" gap="small-200">
            {canEdit ? (
              <DsButton variant="secondary" onClick={handleOpen}>
                Editar
              </DsButton>
            ) : (
              <>
                <DsButton variant="secondary" disabled interestFor={`semantic-edit-tip-${block.id}`}>
                  Editar
                </DsButton>
                <s-tooltip id={`semantic-edit-tip-${block.id}`}>
                  {semanticWritesEnabled ? 'Tipo não editável nesta fase' : 'Writes desabilitados (feature flag OFF)'}
                </s-tooltip>
              </>
            )}
            {block.capabilities.includes('translate') && (
              <>
                <DsButton variant="secondary" disabled interestFor={`semantic-translate-tip-${block.id}`}>
                  Traduzir
                </DsButton>
                <s-tooltip id={`semantic-translate-tip-${block.id}`}>Tradução futura (não implementado nesta fase)</s-tooltip>
              </>
            )}
          </s-stack>
        </s-stack>
      </s-box>

      {modalOpen && (
        <DsModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          heading={`Editar ${humanizeBlockKind(block.blockKind)}`}
          primaryAction={{
            content: 'Salvar',
            onAction: handleSave,
            loading: saving,
            disabled: draft === block.content || draft.trim() === '',
          }}
          secondaryActions={[{ content: 'Cancelar', onAction: () => setModalOpen(false) }]}
        >
          <s-stack gap="base">
            {saveError && (
              <s-banner tone="critical">
                <s-paragraph>{saveError}</s-paragraph>
              </s-banner>
            )}
            {block.blockKind === 'article_paragraph' || block.blockKind === 'faq_answer' ? (
              <DsTextArea label={humanizeBlockKind(block.blockKind)} value={draft} onChange={setDraft} rows={4} />
            ) : (
              <DsTextField label={humanizeBlockKind(block.blockKind)} value={draft} onChange={setDraft} />
            )}
          </s-stack>
        </DsModal>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Images
// ────────────────────────────────────────────────────────────────

function ImagesCard({
  slots,
  landingId,
  htmlSha,
  setHtmlSha,
  semanticWritesEnabled,
}: { slots: SemanticImageSlot[] } & WriteProps): JSX.Element {
  const classified = slots.filter((s) => s.slotKind !== 'unknown');
  const unknown = slots.filter((s) => s.slotKind === 'unknown');

  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Imagens</s-heading>
          <s-stack direction="inline" gap="small-200">
            <DsToneBadge tone="success">{`${classified.length} classificadas`}</DsToneBadge>
            {unknown.length > 0 && <DsToneBadge tone="warning">{`${unknown.length} não classificadas`}</DsToneBadge>}
          </s-stack>
        </s-stack>
        <s-divider />

        {classified.length > 0 && (
          <s-stack gap="small-100">
            <s-heading>Classificadas</s-heading>
            <ImageGrid
              slots={classified}
              landingId={landingId}
              htmlSha={htmlSha}
              setHtmlSha={setHtmlSha}
              semanticWritesEnabled={semanticWritesEnabled}
            />
          </s-stack>
        )}

        {unknown.length > 0 && (
          <>
            <s-divider />
            <s-stack gap="small-100">
              <s-heading>Imagens não classificadas</s-heading>
              <ImageGrid
                slots={unknown}
                landingId={landingId}
                htmlSha={htmlSha}
                setHtmlSha={setHtmlSha}
                semanticWritesEnabled={semanticWritesEnabled}
              />
            </s-stack>
          </>
        )}
      </s-stack>
    </s-section>
  );
}

function ImageGrid({
  slots,
  landingId,
  htmlSha,
  setHtmlSha,
  semanticWritesEnabled,
}: { slots: SemanticImageSlot[] } & WriteProps): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 12,
      }}
    >
      {slots.slice(0, 100).map((slot) => (
        <ImageCard
          key={slot.id}
          slot={slot}
          landingId={landingId}
          htmlSha={htmlSha}
          setHtmlSha={setHtmlSha}
          semanticWritesEnabled={semanticWritesEnabled}
        />
      ))}
      {slots.length > 100 && (
        <div style={{ padding: 12, gridColumn: '1 / -1' }}>
          <s-text color="subdued">{`+ ${slots.length - 100} imagens não exibidas`}</s-text>
        </div>
      )}
    </div>
  );
}

function ImageCard({
  slot,
  landingId,
  htmlSha,
  setHtmlSha,
  semanticWritesEnabled,
}: { slot: SemanticImageSlot } & WriteProps): JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canReplace = semanticWritesEnabled && ALLOWED_IMAGE_KINDS.has(slot.slotKind);

  const handleOpen = useCallback(() => {
    setUrlDraft('');
    setSaveError(null);
    setModalOpen(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!urlDraft.startsWith('https://')) {
      setSaveError('URL deve começar com https://');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = await callSemanticWrite(landingId, {
      instanceId: slot.instanceId,
      mutationKind: 'image',
      value: urlDraft,
      htmlSha,
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error ?? 'Erro desconhecido');
      return;
    }
    if (result.newHtmlSha) setHtmlSha(result.newHtmlSha);
    setModalOpen(false);
  }, [landingId, slot.id, urlDraft, htmlSha, setHtmlSha]);

  return (
    <>
      <s-box padding="small-200" border="base" borderRadius="base" background="subdued">
        <s-stack gap="small-200">
          <s-thumbnail src={slot.currentUrl} alt={slot.slotKind} size="large" />
          <s-stack direction="inline">
            <DsToneBadge tone={slot.slotKind === 'unknown' ? 'warning' : 'info'}>
              {humanizeSlotKind(slot.slotKind)}
            </DsToneBadge>
          </s-stack>
          <s-text color="subdued">{`confidence: ${pct(slot.confidence)}`}</s-text>
          <s-stack direction="inline">
            {canReplace ? (
              <DsButton variant="secondary" onClick={handleOpen}>
                Substituir
              </DsButton>
            ) : (
              <>
                <DsButton variant="secondary" disabled interestFor={`semantic-replace-tip-${slot.id}`}>
                  Substituir
                </DsButton>
                <s-tooltip id={`semantic-replace-tip-${slot.id}`}>
                  {semanticWritesEnabled ? 'Tipo não substituível nesta fase' : 'Writes desabilitados (feature flag OFF)'}
                </s-tooltip>
              </>
            )}
          </s-stack>
        </s-stack>
      </s-box>

      {modalOpen && (
        <DsModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          heading={`Substituir ${humanizeSlotKind(slot.slotKind)}`}
          primaryAction={{
            content: 'Substituir',
            onAction: handleSave,
            loading: saving,
            disabled: !urlDraft.startsWith('https://'),
          }}
          secondaryActions={[{ content: 'Cancelar', onAction: () => setModalOpen(false) }]}
        >
          <s-stack gap="base">
            {saveError && (
              <s-banner tone="critical">
                <s-paragraph>{saveError}</s-paragraph>
              </s-banner>
            )}
            <DsTextField
              label="URL da nova imagem (deve ser https://)"
              value={urlDraft}
              onChange={setUrlDraft}
              placeholder="https://cdn.shopify.com/..."
              details="URL pública da imagem. Apenas CDNs de confiança."
            />
            <s-text color="subdued">URL atual: {truncateText(slot.currentUrl, 80)}</s-text>
          </s-stack>
        </DsModal>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Commercial (Bundles + Currency + CTA)
// ────────────────────────────────────────────────────────────────

function CommercialCard({
  model,
  landing,
}: {
  model: PageSemanticModel;
  landing: LandingSummary;
}): JSX.Element {
  const bundleRegion = model.regions.find((r) => r.kind === 'bundles');
  const bundleFields = model.editableFields.filter((f) => f.region === 'bundles');
  const ctaRegion = model.regions.find((r) => r.kind === 'cta_primary');
  const ctaField = model.editableFields.find((f) => f.region === 'cta_primary');

  return (
    <s-section>
      <s-stack gap="base">
        <s-heading>Ofertas e Configuração</s-heading>
        <s-divider />

        <s-stack direction="inline" gap="small-200" alignItems="center">
          <DsToneBadge>Moeda</DsToneBadge>
          <s-text>{landing.currency ?? 'não configurada'}</s-text>
        </s-stack>

        <s-divider />

        <s-stack gap="small-200">
          <s-heading>Bundles</s-heading>
          {bundleRegion ? (
            <>
              <s-paragraph color="subdued">
                {`${bundleRegion.region.children?.length ?? 0} ofertas · confidence ${pct(bundleRegion.confidence)} · owner ${bundleRegion.ownerId}`}
              </s-paragraph>
              {bundleFields.length > 0 && (
                <BundleFieldsList fields={bundleFields} />
              )}
              <s-link href={`/landing-pages/${landing.id}/editor`}>
                Ver bundles no editor clássico (canonical)
              </s-link>
            </>
          ) : (
            <s-paragraph color="subdued">
              Nenhum bundle detectado. Se essa landing tem ofertas, verifique
              adapter kaching / bundle_offers no editor clássico.
            </s-paragraph>
          )}
        </s-stack>

        <s-divider />

        <s-stack gap="small-200">
          <s-heading>CTA</s-heading>
          {ctaRegion ? (
            <s-paragraph color="subdued">
              {`Detectado em ${ctaRegion.structuralPath} · confidence ${pct(ctaRegion.confidence)} · ${ctaField?.value ?? '—'}`}
            </s-paragraph>
          ) : (
            <s-paragraph color="subdued">
              Nenhum CTA principal detectado semanticamente.
            </s-paragraph>
          )}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function BundleFieldsList({ fields }: { fields: PageSemanticModel['editableFields'] }): JSX.Element {
  return (
    <s-stack gap="small-200">
      {fields.map((f) => (
        <s-stack key={f.id} direction="inline" gap="small-200" alignItems="center">
          <DsToneBadge>{f.type}</DsToneBadge>
          <s-text color="subdued">{`${f.id} · source=${f.source}`}</s-text>
        </s-stack>
      ))}
    </s-stack>
  );
}

// ────────────────────────────────────────────────────────────────
// Debug (regions raw, warnings, conflicts) — collapsable
// ────────────────────────────────────────────────────────────────

function DebugCard({ model }: { model: PageSemanticModel }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <s-section>
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading>Debug</s-heading>
          <DsButton variant="secondary" onClick={() => setOpen((v) => !v)}>
            {open ? 'Ocultar' : 'Mostrar detalhes técnicos'}
          </DsButton>
        </s-stack>
        {open && (
          <div id="semantic-debug">
            <s-stack gap="base">
              <Section title={`Warnings (${model.warnings.length})`}>
                {model.warnings.length === 0 ? (
                  <s-paragraph color="subdued">Sem warnings.</s-paragraph>
                ) : (
                  <s-stack gap="small-300">
                    {model.warnings.map((w, i) => (
                      <s-paragraph key={i}>{`[${w.severity}] ${w.code}: ${w.message}`}</s-paragraph>
                    ))}
                  </s-stack>
                )}
              </Section>

              <Section title={`Conflicts (${model.conflicts.length})`}>
                {model.conflicts.length === 0 ? (
                  <s-paragraph color="subdued">Sem conflicts.</s-paragraph>
                ) : (
                  <s-stack gap="small-300">
                    {model.conflicts.map((c, i) => (
                      <s-paragraph key={i}>{`${c.regionKind} @ ${c.scope.structuralPath}: ${c.resolution} — ${c.reason}`}</s-paragraph>
                    ))}
                  </s-stack>
                )}
              </Section>

              <Section title={`Regions (${model.regions.length})`}>
                <s-stack gap="small-300">
                  {model.regions.map((r) => (
                    <RegionDebugRow key={`${r.instanceId}:${r.kind}`} region={r} />
                  ))}
                </s-stack>
              </Section>

              <Section title={`Unclassified (${model.unclassified.length})`}>
                {model.unclassified.length === 0 ? (
                  <s-paragraph color="subdued">Sem unclassified elements.</s-paragraph>
                ) : (
                  <s-stack gap="small-300">
                    {model.unclassified.slice(0, 20).map((u, i) => (
                      <s-paragraph key={i}>{`${u.selector}: ${u.reason}`}</s-paragraph>
                    ))}
                    {model.unclassified.length > 20 && (
                      <s-paragraph color="subdued">{`+ ${model.unclassified.length - 20} não exibidos`}</s-paragraph>
                    )}
                  </s-stack>
                )}
              </Section>
            </s-stack>
          </div>
        )}
      </s-stack>
    </s-section>
  );
}

function RegionDebugRow({ region }: { region: RegionEntry }): JSX.Element {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <DsToneBadge>{region.kind}</DsToneBadge>
      <DsToneBadge tone="info">{region.source}</DsToneBadge>
      <s-text color="subdued">{`${region.ownerId} · confidence ${pct(region.confidence)} · ${region.structuralPath}`}</s-text>
    </s-stack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <s-stack gap="small-200">
      <s-heading>{title}</s-heading>
      {children}
    </s-stack>
  );
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'info' | 'success' | 'warning' | 'critical';
}): JSX.Element {
  return (
    <s-stack gap="small-300">
      <s-text color="subdued">{label}</s-text>
      {tone ? <DsToneBadge tone={tone}>{value}</DsToneBadge> : <s-text>{value}</s-text>}
    </s-stack>
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function truncateText(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function humanizeBlockKind(kind: SemanticTextBlock['blockKind']): string {
  const map: Record<SemanticTextBlock['blockKind'], string> = {
    headline: 'Headline',
    subheadline: 'Subheadline',
    product_title: 'Título do produto',
    cta_label: 'Rótulo do CTA',
    benefit_item: 'Benefício',
    faq_question: 'Pergunta FAQ',
    faq_answer: 'Resposta FAQ',
    article_paragraph: 'Parágrafo',
    testimonial: 'Depoimento',
    guarantee_text: 'Garantia',
    footer_text: 'Rodapé',
    unknown: 'Não classificado',
  };
  return map[kind] ?? kind;
}

function humanizeSlotKind(kind: SemanticImageSlot['slotKind']): string {
  const map: Record<SemanticImageSlot['slotKind'], string> = {
    product_main: 'Imagem principal',
    gallery_image: 'Galeria',
    section_image: 'Imagem de seção',
    advertorial_image: 'Imagem de artigo',
    logo: 'Logo',
    decorative: 'Decorativa',
    unknown: 'Não classificada',
  };
  return map[kind] ?? kind;
}
