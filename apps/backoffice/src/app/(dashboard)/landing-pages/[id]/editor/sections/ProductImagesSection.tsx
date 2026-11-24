'use client';

// @ds-migrated — Story 20.10b (PR3): seção "Imagens do produto (carrossel)" no design system.
//
// ProductImagesSection — Grid do carrossel do produto (Wave B).
// Substitui + reordena imagens do carrossel principal.
// Upload local → slider-images POST (multipart). URL como alternativa secundária.
//
// Story 20.10b — só visual: detecção, reordenar, upload, substituir e validações iguais a antes; a área
// de soltar arquivo usa `.ds-dropzone` (estado de arrastar em `data-dragging`) em vez de estilo inline.

import { useCallback, useEffect, useRef, useState } from 'react';

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

interface CarouselImage {
  index: number;
  src: string;
  alt: string;
}

interface ReplaceState {
  slotIndex: number;
  // file-upload flow
  file: File | null;
  previewUrl: string | null;
  // url flow (secondary)
  urlMode: boolean;
  newUrl: string;
}

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export default function ProductImagesSection({ landing, onBanner }: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [images, setImages] = useState<CarouselImage[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [replace, setReplace] = useState<ReplaceState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detect = useCallback(async () => {
    setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/detect-editable`, {
        signal: controller.signal,
      });
      const data = (await res.json()) as { ok: boolean; carouselImages?: CarouselImage[]; message?: string };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao detectar imagens.');
        return;
      }
      const imgs = data.carouselImages ?? [];
      setImages(imgs);
      setOrder(imgs.map((i) => i.index));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        onBanner('critical', 'Timeout ao detectar imagens. Tente novamente.');
      } else {
        onBanner('critical', err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, [landing.id, onBanner]);

  useEffect(() => {
    if (editing && images.length === 0) {
      void detect();
    }
  }, [editing, images.length, detect]);

  // Revoga object URL ao desmontar ou trocar de arquivo
  useEffect(() => {
    return () => {
      if (replace?.previewUrl) URL.revokeObjectURL(replace.previewUrl);
    };
  }, [replace?.previewUrl]);

  const moveImage = useCallback((from: number, to: number): void => {
    setOrder((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(from, 1);
      if (moved === undefined) return prev;
      copy.splice(to, 0, moved);
      return copy;
    });
  }, []);

  const handleSaveReorder = useCallback(async () => {
    const originalOrder = images.map((i) => i.index);
    const changed = order.some((v, i) => v !== originalOrder[i]);
    if (!changed) {
      onBanner('info', 'Nenhuma alteração de ordem.');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(`/api/landing-pages/${landing.id}/edit-html`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'reorder-carousel-images', imageIndexOrder: order }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao reordenar.');
        return;
      }
      onBanner('success', 'Imagens reordenadas.');
      setImages([]);
      setOrder([]);
      setEditing(false);
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [order, images, landing.id, onBanner]);

  const applyFile = useCallback((file: File): void => {
    if (!ACCEPTED_MIME.includes(file.type)) {
      onBanner('critical', `Formato não suportado: ${file.type}. Use JPG, PNG, WebP ou AVIF.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      onBanner('critical', `Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo 10 MB.`);
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setReplace((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return prev ? { ...prev, file, previewUrl, urlMode: false, newUrl: '' } : null;
    });
  }, [onBanner]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) applyFile(file);
    // Reset input so selecting same file again triggers onChange
    e.target.value = '';
  }, [applyFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) applyFile(file);
  }, [applyFile]);

  const handleReplaceConfirm = useCallback(async () => {
    if (!replace) return;

    setIsSaving(true);
    try {
      let newImageUrl: string;

      if (!replace.urlMode && replace.file) {
        // Upload puro — armazena no Supabase e retorna URL (não modifica HTML)
        const form = new FormData();
        form.append('file', replace.file);

        const upRes = await fetch(`/api/landing-pages/${landing.id}/upload-image`, {
          method: 'POST',
          body: form,
        });
        const upData = (await upRes.json()) as { ok: boolean; url?: string; message?: string };
        if (!upRes.ok || !upData.ok) {
          onBanner('critical', upData.message ?? 'Falha no upload.');
          return;
        }
        if (!upData.url) {
          onBanner('critical', 'Upload concluído mas URL não retornada.');
          return;
        }
        newImageUrl = upData.url;
      } else {
        if (!replace.newUrl.trim() || !/^https?:\/\//i.test(replace.newUrl)) {
          onBanner('critical', 'URL inválida — deve começar com http:// ou https://');
          return;
        }
        newImageUrl = replace.newUrl.trim();
      }

      // Substitui o slot no HTML
      const res = await fetch(`/api/landing-pages/${landing.id}/edit-html`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'replace-carousel-image',
          slotIndex: replace.slotIndex,
          newImageUrl,
        }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      if (!res.ok || !data.ok) {
        onBanner('critical', data.message ?? 'Falha ao substituir.');
        return;
      }
      onBanner('success', `Imagem #${replace.slotIndex + 1} substituída.`);
      if (replace.previewUrl) URL.revokeObjectURL(replace.previewUrl);
      setReplace(null);
      setImages([]);
      setOrder([]);
    } catch (err) {
      onBanner('critical', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [replace, landing.id, onBanner]);

  const openReplace = useCallback((slotIndex: number) => {
    setReplace({ slotIndex, file: null, previewUrl: null, urlMode: false, newUrl: '' });
  }, []);

  const closeReplace = useCallback(() => {
    if (replace?.previewUrl) URL.revokeObjectURL(replace.previewUrl);
    setReplace(null);
  }, [replace]);

  const formatBytes = (n: number): string =>
    n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;


  return (
    <s-section>
      <s-stack gap="base">
        <EditorCardHeader
          title="Imagens do produto (carrossel)"
          action={
            !editing ? (
              <DsButton variant="secondary" onClick={() => setEditing(true)}>
                Editar
              </DsButton>
            ) : null
          }
        />

        {!editing && <s-paragraph color="subdued">Reordena e substitui imagens do carrossel principal (apenas — não afeta seções).</s-paragraph>}

        {editing && loading && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Detectando imagens" />
            <s-text>Detectando imagens do carrossel…</s-text>
          </s-stack>
        )}

        {editing && !loading && images.length === 0 && (
          <EditorBanner tone="warning" title="Nenhuma imagem de carrossel detectada">
            <s-stack gap="small-200">
              <s-paragraph>
                Nenhuma galeria de produto foi reconhecida nesta landing.
                Temas suportados: Klensia, Shopify Dawn, Aurivita, Kaching, Broadcast e variantes.
              </s-paragraph>
              <s-stack direction="inline">
                <DsButton
                  variant="secondary"
                  onClick={() => {
                    setImages([]);
                    void detect();
                  }}
                >
                  Tentar novamente
                </DsButton>
              </s-stack>
            </s-stack>
          </EditorBanner>
        )}

        {editing && !loading && images.length > 0 && (
          <s-stack gap="base">
            <s-paragraph color="subdued">
              {images.length} imagem(ns). Use os botões ↑↓ pra reordenar ou &quot;Substituir&quot; pra trocar.
            </s-paragraph>
            <s-stack gap="small-200">
              {order.map((originalIdx, currentPos) => {
                const img = images.find((i) => i.index === originalIdx);
                if (!img) return null;
                return (
                  <s-box key={originalIdx} border="base" borderRadius="base" padding="small-200">
                    <s-grid gridTemplateColumns="auto auto minmax(0, 1fr) auto" gap="base" alignItems="center">
                      <s-text type="strong" fontWeight="bold">
                        #{currentPos + 1}
                      </s-text>
                      <s-thumbnail src={img.src} alt={img.alt || `Imagem ${currentPos + 1}`} size="base" />
                      <span className="ds-clamp-2">
                        <s-text color="subdued">{img.src.length > 60 ? `${img.src.slice(0, 60)}…` : img.src}</s-text>
                      </span>
                      <s-stack direction="inline" gap="small-200">
                        <DsButton
                          variant="secondary"
                          onClick={() => moveImage(currentPos, Math.max(0, currentPos - 1))}
                          disabled={currentPos === 0 || isSaving}
                          accessibilityLabel={`Mover imagem #${currentPos + 1} para cima`}
                        >
                          ↑
                        </DsButton>
                        <DsButton
                          variant="secondary"
                          onClick={() => moveImage(currentPos, Math.min(order.length - 1, currentPos + 1))}
                          disabled={currentPos === order.length - 1 || isSaving}
                          accessibilityLabel={`Mover imagem #${currentPos + 1} para baixo`}
                        >
                          ↓
                        </DsButton>
                        <DsButton variant="secondary" onClick={() => openReplace(originalIdx)} disabled={isSaving}>
                          Substituir
                        </DsButton>
                      </s-stack>
                    </s-grid>
                  </s-box>
                );
              })}
            </s-stack>

            {replace && (
              <s-box border="base" borderRadius="base" padding="base">
                <s-stack gap="base">
                  <s-heading>Substituir imagem #{replace.slotIndex + 1}</s-heading>

                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
                    hidden
                    onChange={handleFileChange}
                  />

                  {/* Drop zone / preview */}
                  {!replace.urlMode && (
                    <div
                      className="ds-dropzone"
                      data-dragging={isDragging || undefined}
                      data-has-preview={replace.previewUrl ? true : undefined}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setIsDragging(true);
                      }}
                      onDragLeave={() => setIsDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => !isSaving && fileInputRef.current?.click()}
                    >
                      {replace.previewUrl ? (
                        <s-stack gap="small-200" alignItems="center">
                          <img src={replace.previewUrl} alt="Preview" className="ds-dropzone__preview" />
                          <s-text color="subdued">
                            {replace.file?.name}
                            {replace.file ? ` · ${formatBytes(replace.file.size)}` : ''}
                          </s-text>
                          <DsButton variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={isSaving}>
                            Trocar arquivo
                          </DsButton>
                        </s-stack>
                      ) : (
                        <s-stack gap="small-200" alignItems="center">
                          <s-text>Arraste uma imagem aqui ou clique para selecionar</s-text>
                          <s-text color="subdued">JPG, PNG, WebP, AVIF · máx 10 MB</s-text>
                          <DsButton variant="secondary" disabled={isSaving}>
                            Selecionar arquivo
                          </DsButton>
                        </s-stack>
                      )}
                    </div>
                  )}

                  {/* URL alternativa */}
                  {replace.urlMode ? (
                    <s-stack gap="small-200">
                      <DsTextField
                        label="URL da nova imagem"
                        value={replace.newUrl}
                        onChange={(v) => setReplace((prev) => (prev ? { ...prev, newUrl: v } : prev))}
                        placeholder="https://..."
                        details="Cole URL pública da nova imagem (HTTPS)."
                        disabled={isSaving}
                      />
                      <s-stack direction="inline">
                        <DsButton
                          variant="tertiary"
                          onClick={() => setReplace((prev) => (prev ? { ...prev, urlMode: false, newUrl: '' } : prev))}
                          disabled={isSaving}
                        >
                          ← Usar arquivo do computador
                        </DsButton>
                      </s-stack>
                    </s-stack>
                  ) : (
                    <s-stack direction="inline">
                      <DsButton variant="tertiary" onClick={() => setReplace((prev) => (prev ? { ...prev, urlMode: true } : prev))} disabled={isSaving}>
                        Ou usar URL externa
                      </DsButton>
                    </s-stack>
                  )}

                  <s-stack direction="inline" gap="small-200">
                    <DsButton
                      variant="secondary"
                      onClick={handleReplaceConfirm}
                      loading={isSaving}
                      disabled={isSaving || (replace.urlMode ? !replace.newUrl.trim() : !replace.file)}
                    >
                      Confirmar substituição
                    </DsButton>
                    <DsButton variant="tertiary" onClick={closeReplace} disabled={isSaving}>
                      Cancelar
                    </DsButton>
                  </s-stack>
                </s-stack>
              </s-box>
            )}

            <s-stack direction="inline" gap="small-200">
              <DsButton variant="secondary" onClick={handleSaveReorder} loading={isSaving} disabled={isSaving}>
                Salvar nova ordem
              </DsButton>
              <DsButton
                variant="tertiary"
                onClick={() => {
                  setEditing(false);
                  setImages([]);
                  setOrder([]);
                  setReplace(null);
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
