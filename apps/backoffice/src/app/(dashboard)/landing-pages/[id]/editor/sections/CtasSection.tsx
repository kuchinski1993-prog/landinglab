'use client';

// @ds-migrated — Story 20.10b (PR2): seção "CTAs" no design system.
//
// CtasSection — Editar URL destino de CTAs (Wave B).
// Focado em advertorial (troca destino do botão pra sales_page).
// Não mexe em texto — só href.
//
// Só visual: detect-editable e edit-html (`update-cta-urls`) iguais a antes; a tabela vira s-table com
// um campo por linha (rótulo para leitor de tela com o texto do CTA).

import { useCallback, useEffect, useState } from 'react';

import { EditorBanner, EditorCardHeader } from '../_components/EditorCard';

import { DsButton, DsTextField } from '@/components/ds';
import type { LandingPageRow } from '@/lib/landing-types';

interface Props {
  landing: LandingPageRow;
  onBanner: (
    tone: 'success' | 'critical' | 'info' | 'warning',
    message: string,
    title?: string,
  ) => void;
}

interface Cta {
  href: string;
  text: string;
  count: number;
}

export default function CtasSection({ landing, onBanner }: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ctas, setCtas] = useState<Cta[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  const detect = useCallback(async () => {
    setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/detect-editable`, {
        signal: controller.signal,
      });
      const data = (await res.json()) as { ok: boolean; ctas?: Cta[]; message?: string };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao detectar CTAs.');
        return;
      }
      setCtas(data.ctas ?? []);
      const initial: Record<string, string> = {};
      for (const c of data.ctas ?? []) initial[c.href] = c.href;
      setEdits(initial);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        onBanner('critical', 'Timeout ao detectar CTAs. Tente novamente.');
      } else {
        onBanner('critical', err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, [landing.id, onBanner]);

  useEffect(() => {
    if (editing && ctas.length === 0) {
      void detect();
    }
  }, [editing, ctas.length, detect]);

  const handleSave = useCallback(async () => {
    const mappings = ctas
      .map((c) => {
        const newHref = edits[c.href]?.trim();
        if (!newHref || newHref === c.href) return null;
        if (!/^https?:\/\/|^\/|^#/i.test(newHref)) return null;
        return { oldHref: c.href, newHref };
      })
      .filter((x): x is { oldHref: string; newHref: string } => x !== null);

    if (mappings.length === 0) {
      onBanner('info', 'Nenhuma alteração de URL detectada.');
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/edit-html`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'update-cta-urls', mappings }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; updatedFields?: string[] };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao atualizar CTAs.');
        return;
      }
      onBanner('success', `${mappings.length} CTA(s) atualizado(s).`);
      setEditing(false);
      setCtas([]);
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [ctas, edits, landing.id, onBanner]);


  return (
    <s-section>
      <s-stack gap="base">
        <EditorCardHeader
          title="CTAs (Botões de ação)"
          action={
            !editing ? (
              <DsButton variant="secondary" onClick={() => setEditing(true)}>
                Editar
              </DsButton>
            ) : null
          }
        />

        {!editing && (
          <s-paragraph color="subdued">
            Muda a URL de destino de botões e links (não altera texto). Ideal
            pra apontar CTAs de advertoriais pra sua sales_page.
          </s-paragraph>
        )}

        {editing && loading && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Detectando CTAs" />
            <s-text>Detectando CTAs no HTML…</s-text>
          </s-stack>
        )}

        {editing && !loading && ctas.length === 0 && (
          <EditorBanner tone="warning" title="Nenhum CTA detectado">
            Nenhum link de ação encontrado no HTML. Isso pode acontecer quando
            a landing usa apenas âncoras de scroll ou assets (imagens, fontes).
            Se a clonagem terminou recentemente, feche e reabra esta seção.
          </EditorBanner>
        )}

        {editing && !loading && ctas.length > 0 && (
          <s-stack gap="base">
            <s-paragraph color="subdued">
              {ctas.length} CTA(s) detectado(s). Edite a URL de destino nas linhas.
              Deixe idêntico ao original pra não alterar.
            </s-paragraph>
            <s-table>
              <s-table-header-row>
                <s-table-header>Texto</s-table-header>
                <s-table-header>Uso</s-table-header>
                <s-table-header>URL atual</s-table-header>
                <s-table-header listSlot="primary">Nova URL</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {ctas.map((c) => (
                  <s-table-row key={c.href}>
                    <s-table-cell>
                      {c.text ? <s-text>{c.text.length > 30 ? `${c.text.slice(0, 30)}…` : c.text}</s-text> : <s-text color="subdued">(sem texto)</s-text>}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone="info">{`${c.count}x`}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{c.href.length > 40 ? `${c.href.slice(0, 40)}…` : c.href}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <span className="ds-cell-wrap">
                        <DsTextField
                          label={`Nova URL de ${c.text || c.href}`}
                          labelHidden
                          value={edits[c.href] ?? ''}
                          onChange={(v) => setEdits((prev) => ({ ...prev, [c.href]: v }))}
                          disabled={isSaving}
                        />
                      </span>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-stack direction="inline" gap="small-200">
              <DsButton variant="secondary" onClick={handleSave} loading={isSaving} disabled={isSaving}>
                Salvar URLs
              </DsButton>
              <DsButton
                variant="tertiary"
                onClick={() => {
                  setEditing(false);
                  setCtas([]);
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
  );
}
