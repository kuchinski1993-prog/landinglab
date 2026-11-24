'use client';

// Story 26.1 — painel lateral do editor visual: seção selecionada (ocultar/mostrar/excluir), botão (texto e
// link), preço (só o texto mostrado) e a lista de seções da página. Só estado pendente — grava no "Salvar".

import { DsButton, DsTextField, DsToneBadge } from '@/components/ds';

export type TargetKind = 'section' | 'button' | 'price';
export type SectionAction = 'hide' | 'show' | 'remove';

/** Um nível da cadeia clicada no iframe (mais interno primeiro). */
export interface TargetInfo {
  id: string;
  kind: TargetKind;
  label: string;
  text: string;
  href: string;
  multi: boolean;
  hidden: boolean;
}

export interface SectionInfo {
  id: string;
  label: string;
  hidden: boolean;
}

export interface ButtonDraft {
  text?: string;
  href?: string;
}

interface Props {
  chain: TargetInfo[];
  selectedId: string | null;
  sections: SectionInfo[];
  sectionEdits: Map<string, SectionAction>;
  buttonEdits: Map<string, ButtonDraft>;
  priceEdits: Map<string, string>;
  disabled: boolean;
  onSelect: (id: string) => void;
  onSectionAction: (section: SectionInfo, action: SectionAction | null) => void;
  onButtonChange: (target: TargetInfo, field: 'text' | 'href', value: string) => void;
  onPriceChange: (target: TargetInfo, value: string) => void;
}

const KIND_NAME: Record<TargetKind, string> = { section: 'Seção', button: 'Botão', price: 'Preço' };

export function hrefProblem(value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v.startsWith('#')) return /^#[A-Za-z][\w\-:.]{0,100}$/.test(v) ? undefined : 'Use #id-da-seção (começa com letra)';
  return /^https:\/\/[^\s]+$/i.test(v) ? undefined : 'Use um link https:// ou #id-da-seção';
}

function sectionState(s: SectionInfo, edits: Map<string, SectionAction>): 'visible' | 'hidden' | 'remove' {
  const a = edits.get(s.id);
  if (a === 'remove') return 'remove';
  if (a === 'hide') return 'hidden';
  if (a === 'show') return 'visible';
  return s.hidden ? 'hidden' : 'visible';
}

function SectionControls({
  section,
  edits,
  disabled,
  onAction,
  compact,
}: {
  section: SectionInfo;
  edits: Map<string, SectionAction>;
  disabled: boolean;
  onAction: Props['onSectionAction'];
  compact?: boolean;
}): JSX.Element {
  const state = sectionState(section, edits);
  const pending = edits.has(section.id);
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {state === 'remove' ? (
        <DsButton variant="secondary" onClick={() => onAction(section, null)} disabled={disabled}>
          Desfazer exclusão
        </DsButton>
      ) : (
        <>
          <DsButton
            variant="secondary"
            onClick={() => onAction(section, state === 'hidden' ? 'show' : 'hide')}
            disabled={disabled}
          >
            {state === 'hidden' ? 'Mostrar' : 'Ocultar'}
          </DsButton>
          {!compact && (
            <DsButton
              variant="secondary"
              tone="critical"
              onClick={() => {
                if (confirm('Excluir esta seção? Ela sai do HTML ao salvar (dá para voltar em "Versões").')) {
                  onAction(section, 'remove');
                }
              }}
              disabled={disabled}
            >
              Excluir
            </DsButton>
          )}
          {pending && !compact && (
            <DsButton variant="tertiary" onClick={() => onAction(section, null)} disabled={disabled}>
              Desfazer
            </DsButton>
          )}
        </>
      )}
    </div>
  );
}

export default function TargetPanel(props: Props): JSX.Element {
  const { chain, selectedId, sections, sectionEdits, buttonEdits, priceEdits, disabled } = props;
  const selected = chain.find((t) => t.id === selectedId) ?? null;
  const selectedSection =
    selected?.kind === 'section'
      ? sections.find((s) => s.id === selected.id) ?? { id: selected.id, label: selected.label, hidden: selected.hidden }
      : null;

  return (
    <aside
      aria-label="Painel de edição"
      style={{
        width: 340,
        flexShrink: 0,
        overflowY: 'auto',
        borderLeft: '1px solid var(--p-color-border, #e3e3e3)',
        background: 'var(--p-color-bg-surface, #fff)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {chain.length > 1 && (
          <nav aria-label="Elemento selecionado" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {[...chain].reverse().map((t, i) => (
              <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <s-text color="subdued">›</s-text>}
                <DsButton variant={t.id === selectedId ? 'secondary' : 'tertiary'} onClick={() => props.onSelect(t.id)}>
                  {KIND_NAME[t.kind]}
                </DsButton>
              </span>
            ))}
          </nav>
        )}

        {!selected && (
          <s-text color="subdued">
            Clique numa seção, botão ou preço na página para editar. Textos soltos e imagens continuam editáveis direto na
            página.
          </s-text>
        )}

        {selected && selectedSection && (
          <>
            <strong>Seção · {selected.label || 'sem título'}</strong>
            <SectionControls section={selectedSection} edits={sectionEdits} disabled={disabled} onAction={props.onSectionAction} />
            <s-text color="subdued">
              Ocultar esconde na página publicada e no zip, mas mantém no HTML. Excluir tira do HTML.
            </s-text>
          </>
        )}

        {selected?.kind === 'button' && (
          <>
            <strong>Botão</strong>
            <DsTextField
              label="Texto do botão"
              value={buttonEdits.get(selected.id)?.text ?? selected.text}
              onChange={(v) => props.onButtonChange(selected, 'text', v)}
              maxLength={300}
              disabled={disabled}
              details={selected.multi ? 'Este botão tem mais de um texto; só o principal é trocado.' : undefined}
            />
            <DsTextField
              label="Link do botão"
              value={buttonEdits.get(selected.id)?.href ?? selected.href}
              onChange={(v) => props.onButtonChange(selected, 'href', v)}
              placeholder="https://… ou #id-da-seção"
              disabled={disabled}
              error={hrefProblem(buttonEdits.get(selected.id)?.href ?? '')}
              details="Com link, o clique vai para ele (passando utm/fbclid da página) em vez do carrinho ou checkout."
            />
          </>
        )}

        {selected?.kind === 'price' && (
          <>
            <strong>Preço</strong>
            <DsTextField
              label="Preço mostrado"
              value={priceEdits.get(selected.id) ?? selected.text}
              onChange={(v) => props.onPriceChange(selected, v)}
              maxLength={300}
              disabled={disabled}
              details="Só muda o que aparece na página. O valor cobrado é o do link."
            />
          </>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong>Seções da página ({sections.length})</strong>
        {sections.length === 0 && <s-text color="subdued">Nenhuma seção encontrada.</s-text>}
        {sections.map((s, i) => {
          const state = sectionState(s, sectionEdits);
          return (
            <div
              key={s.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: 8,
                borderRadius: 8,
                border: `1px solid ${s.id === selectedId ? 'var(--p-color-border-emphasis, #2c6ecb)' : 'var(--p-color-border, #e3e3e3)'}`,
                opacity: state === 'visible' ? 1 : 0.7,
              }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                <DsButton variant="tertiary" onClick={() => props.onSelect(s.id)} accessibilityLabel={`Ir para a seção ${i + 1}`}>
                  {`${i + 1}. ${s.label || 'sem título'}`.slice(0, 42)}
                </DsButton>
                {state === 'hidden' && <DsToneBadge tone="attention">Oculta</DsToneBadge>}
                {state === 'remove' && <DsToneBadge tone="critical">Será excluída</DsToneBadge>}
              </div>
              <SectionControls section={s} edits={sectionEdits} disabled={disabled} onAction={props.onSectionAction} compact />
            </div>
          );
        })}
      </section>
    </aside>
  );
}
