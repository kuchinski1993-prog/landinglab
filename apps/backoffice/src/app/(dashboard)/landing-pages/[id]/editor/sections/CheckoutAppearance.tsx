'use client';

// @ds-migrated — Story 20.10b (PR3): aparência do checkout Stripe no design system.
//
// Story 15.7 — aparência do checkout Stripe na seção "Mercado e checkout":
//   - ProductImageBlock: imagem do produto no resumo (só upload; salva sozinha).
//   - CheckoutHeaderBlock: logo do header (upload salva sozinho), altura,
//     alinhamento e nome da marca (brand_to), com preview desktop e mobile.
// Uploads reaproveitam /upload-image (JPG/PNG/WebP; SVG não é aceito — ver
// LOGO_HELP) e gravam via POST /checkout-settings só com campos de aparência
// (não revalida mercado/Stripe).
//
// Story 20.10b — só visual: upload, salvamento automático, validação da altura e a réplica do header
// (`CheckoutHeaderPreview`, com os estilos do storefront — é a PRÉVIA, fica igual) são os de antes. Os
// controles viram DS; o controle deslizante da altura é um <input type="range"> nativo (o DS não tem).

import { useRef, useState, type CSSProperties } from 'react';

import { DsButton, DsNumberField, DsTextField, useElementProperties } from '@/components/ds';

export type LogoAlign = 'left' | 'center' | 'right';

export interface AppearanceState {
  checkout_product_image: string | null;
  checkout_logo_url: string | null;
  checkout_logo_height: number;
  checkout_logo_align: LogoAlign;
  brand_name: string | null;
}

export const LOGO_HEIGHT_MIN = 16;
/** O slider vai até 80 px (o banco aceita até 120). */
export const LOGO_HEIGHT_SLIDER_MAX = 80;
export const LOGO_HEIGHT_MAX = 120;
export const LOGO_HEIGHT_DEFAULT = 32;

type Banner = (tone: 'success' | 'critical' | 'info' | 'warning', message: string, title?: string) => void;

interface SaveResult {
  ok: boolean;
  message?: string;
}

/** Envia o arquivo ao Storage e devolve a URL pública (ou a mensagem de erro). */
async function uploadToStorage(landingId: string, file: File): Promise<{ url: string } | { error: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/landing-pages/${landingId}/upload-image`, { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; message?: string };
  if (!res.ok || !body.ok || !body.url) return { error: body.message ?? 'Falha ao enviar o arquivo.' };
  return { url: body.url };
}

/** Grava só campos de aparência na landing (salvamento automático). */
export async function saveAppearance(
  landingId: string,
  patch: Record<string, unknown>,
): Promise<SaveResult & Partial<AppearanceState>> {
  const res = await fetch(`/api/landing-pages/${landingId}/checkout-settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => ({}))) as SaveResult & Partial<AppearanceState>;
  if (!res.ok || !body.ok) return { ok: false, message: body.message ?? 'Não foi possível salvar.' };
  return body;
}

function BagIcon({ size = 20, color = 'rgb(93, 93, 93)' }: { size?: number; color?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true" style={{ color, flex: '0 0 auto' }}>
      <path
        d="M5.5 8.5h13l-.9 10.4a2 2 0 0 1-2 1.8H8.4a2 2 0 0 1-2-1.8L5.5 8.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const SQUARE: CSSProperties = {
  width: 120,
  height: 120,
  borderRadius: 8,
  border: '1px solid #d9d9d9',
  background: '#fff',
  display: 'block',
  objectFit: 'cover',
  flex: '0 0 auto',
};

// ─── Imagem do produto ──────────────────────────────────────────────────────

interface ImageProps {
  landingId: string;
  image: string | null;
  onSaved: (patch: Partial<AppearanceState>) => void;
  onBanner: Banner;
  disabled?: boolean;
}

export function ProductImageBlock({ landingId, image, onSaved, onBanner, disabled }: ImageProps): JSX.Element {
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function persist(url: string | null, kind: 'upload' | 'remove', file?: File): Promise<void> {
    setBusy(kind);
    setSaved(false);
    setError(null);
    try {
      let next = url;
      if (file) {
        const up = await uploadToStorage(landingId, file);
        if ('error' in up) throw new Error(up.error);
        next = up.url;
      }
      const res = await saveAppearance(landingId, { checkout_product_image: next ?? '' });
      if (!res.ok) throw new Error(res.message);
      onSaved({ checkout_product_image: next });
      setSaved(true);
      onBanner('success', next ? 'Imagem salva. Novos checkouts já usam a imagem.' : 'Imagem removida.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onBanner('critical', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <s-stack gap="small-200">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text type="strong" fontWeight="bold">
          Imagem do produto no checkout
        </s-text>
        {saved && image && <s-badge tone="success">Imagem salva</s-badge>}
      </s-stack>
      <s-stack direction="inline" gap="base" alignItems="center">
        {image ? (
          <img src={image} alt="Imagem do produto no checkout" style={SQUARE} data-testid="checkout-image-preview" />
        ) : (
          <div
            data-testid="checkout-image-placeholder"
            aria-hidden="true"
            style={{ ...SQUARE, background: '#f2f2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <BagIcon size={36} color="rgba(0,0,0,0.32)" />
          </div>
        )}
        <s-stack gap="small-200">
          {!image && (
            <s-paragraph color="subdued">
              Nenhuma imagem enviada — o checkout mostra um quadro neutro. Envie a imagem do produto para o checkout.
            </s-paragraph>
          )}
          <s-stack direction="inline" gap="small-200">
            <DsButton variant="secondary" onClick={() => inputRef.current?.click()} loading={busy === 'upload'} disabled={disabled || busy !== null}>
              Enviar imagem do computador
            </DsButton>
            {image && (
              <DsButton
                variant="tertiary"
                tone="critical"
                onClick={() => void persist(null, 'remove')}
                loading={busy === 'remove'}
                disabled={disabled || busy !== null}
              >
                Remover imagem
              </DsButton>
            )}
          </s-stack>
          {error && (
            <div role="alert">
              <s-text tone="critical">{error}</s-text>
            </div>
          )}
        </s-stack>
      </s-stack>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        data-testid="checkout-image-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void persist(null, 'upload', file);
        }}
      />
      <s-paragraph color="subdued">
        JPG, PNG ou WebP até 10 MB; imagem quadrada fica melhor. Salva automaticamente ao enviar. Vale para checkouts
        abertos a partir de agora — quem já estava com o checkout aberto continua vendo a imagem anterior.
      </s-paragraph>
    </s-stack>
  );
}

// ─── Header do checkout ────────────────────────────────────────────────────

const LOGO_HELP =
  'PNG ou WebP com fundo transparente recomendado (JPG também é aceito), até 10 MB. SVG não é aceito: o arquivo ' +
  'ficaria público no Storage e pode conter scripts — exporte o logo em PNG.';

interface HeaderPreviewProps {
  logoUrl: string | null;
  brandName: string;
  height: number;
  align: LogoAlign;
  mobile?: boolean;
}

/** Réplica do header do checkout (mesmas regras do storefront: CheckoutShell). */
export function CheckoutHeaderPreview({ logoUrl, brandName, height, align, mobile }: HeaderPreviewProps): JSX.Element {
  const effectiveAlign: LogoAlign = logoUrl ? align : 'left';
  const logoHeight = mobile ? Math.min(height, 40) : height;
  const brandEl = logoUrl ? (
    <img
      src={logoUrl}
      alt={brandName || 'Logo'}
      style={{
        display: 'block',
        height: logoHeight,
        width: 'auto',
        maxWidth: mobile ? 192 /* ~60% de 320px */ : 360,
        objectFit: 'contain',
        minWidth: 0,
      }}
    />
  ) : (
    <span style={{ fontSize: 20, fontWeight: 600, color: '#000' }}>{brandName}</span>
  );
  const inner: CSSProperties =
    effectiveAlign === 'center'
      ? { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', gap: 16 }
      : {
          display: 'flex',
          alignItems: 'center',
          justifyContent: effectiveAlign === 'right' ? 'flex-end' : 'space-between',
          gap: 16,
        };
  return (
    <div
      data-testid={mobile ? 'checkout-header-preview-mobile' : 'checkout-header-preview-desktop'}
      data-align={effectiveAlign}
      style={{
        width: mobile ? 320 : '100%',
        maxWidth: '100%',
        background: '#fff',
        borderBottom: '1px solid #dedede',
        boxShadow: '0 0 0 1px #ebebeb',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      <div style={{ ...inner, minHeight: 64, padding: mobile ? '8px 14px' : '8px 21px' }}>
        {effectiveAlign === 'center' ? (
          <>
            <span />
            <div style={{ display: 'flex', justifyContent: 'center', minWidth: 0 }}>{brandEl}</div>
            <div style={{ justifySelf: 'end' }}>
              <BagIcon />
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: mobile ? '0 1 auto' : undefined }}>
              {brandEl}
            </div>
            <BagIcon />
          </>
        )}
      </div>
    </div>
  );
}

interface HeaderProps {
  landingId: string;
  state: AppearanceState;
  onSaved: (patch: Partial<AppearanceState>) => void;
  onBanner: Banner;
  disabled?: boolean;
}

export function CheckoutHeaderBlock({ landingId, state, onSaved, onBanner, disabled }: HeaderProps): JSX.Element {
  const [height, setHeight] = useState<number>(state.checkout_logo_height);
  const [align, setAlign] = useState<LogoAlign>(state.checkout_logo_align);
  const [brandName, setBrandName] = useState<string>(state.brand_name ?? '');
  const [busy, setBusy] = useState<'upload' | 'remove' | 'save' | null>(null);
  const [logoSaved, setLogoSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const logo = state.checkout_logo_url;
  const heightValid = Number.isInteger(height) && height >= LOGO_HEIGHT_MIN && height <= LOGO_HEIGHT_MAX;
  const dirty =
    height !== state.checkout_logo_height ||
    align !== state.checkout_logo_align ||
    brandName.trim() !== (state.brand_name ?? '');

  async function persistLogo(kind: 'upload' | 'remove', file?: File): Promise<void> {
    setBusy(kind);
    setLogoSaved(false);
    setError(null);
    try {
      let next: string | null = null;
      if (file) {
        const up = await uploadToStorage(landingId, file);
        if ('error' in up) throw new Error(up.error);
        next = up.url;
      }
      const res = await saveAppearance(landingId, { checkout_logo_url: next ?? '' });
      if (!res.ok) throw new Error(res.message);
      onSaved({ checkout_logo_url: next });
      setLogoSaved(true);
      onBanner('success', next ? 'Logo salvo. O header do checkout já mostra o logo.' : 'Logo removido.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onBanner('critical', message);
    } finally {
      setBusy(null);
    }
  }

  async function saveHeader(): Promise<void> {
    if (!heightValid) return;
    setBusy('save');
    setError(null);
    try {
      const res = await saveAppearance(landingId, {
        checkout_logo_height: height,
        checkout_logo_align: align,
        brand_name: brandName,
      });
      if (!res.ok) throw new Error(res.message);
      const name = brandName.replace(/\s+/g, ' ').trim() || null;
      onSaved({ checkout_logo_height: height, checkout_logo_align: align, brand_name: name });
      setBrandName(name ?? '');
      onBanner('success', 'Cabeçalho do checkout salvo.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onBanner('critical', message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-heading>Cabeçalho do checkout</s-heading>

        <s-stack direction="inline" gap="base" alignItems="center">
          {logo ? (
            <img
              src={logo}
              alt="Logo do checkout"
              data-testid="checkout-logo-preview"
              style={{ ...SQUARE, objectFit: 'contain', padding: 8, background: '#f6f6f7' }}
            />
          ) : (
            <div aria-hidden="true" style={{ ...SQUARE, background: '#f6f6f7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <s-text color="subdued">Sem logo</s-text>
            </div>
          )}
          <s-stack gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong" fontWeight="bold">
                Logo
              </s-text>
              {logoSaved && logo && <s-badge tone="success">Logo salvo</s-badge>}
            </s-stack>
            {!logo && <s-paragraph color="subdued">Sem logo, o checkout mostra o nome da marca.</s-paragraph>}
            <s-stack direction="inline" gap="small-200">
              <DsButton variant="secondary" onClick={() => inputRef.current?.click()} loading={busy === 'upload'} disabled={disabled || busy !== null}>
                {logo ? 'Trocar logo' : 'Enviar logo'}
              </DsButton>
              {logo && (
                <DsButton
                  variant="tertiary"
                  tone="critical"
                  onClick={() => void persistLogo('remove')}
                  loading={busy === 'remove'}
                  disabled={disabled || busy !== null}
                >
                  Remover logo
                </DsButton>
              )}
            </s-stack>
            <s-paragraph color="subdued">{LOGO_HELP} Salva automaticamente ao enviar.</s-paragraph>
          </s-stack>
        </s-stack>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          hidden
          data-testid="checkout-logo-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void persistLogo('upload', file);
          }}
        />

        <DsTextField
          label="Nome da marca"
          value={brandName}
          onChange={setBrandName}
          disabled={disabled || busy !== null}
          details="Aparece no header quando não há logo e é o texto alternativo do logo. É a mesma marca usada na tradução e nos e-mails do pedido."
        />

        <s-grid gridTemplateColumns="minmax(220px, 1fr) 120px" gap="base" alignItems="end">
          <s-stack gap="small-100">
            <label className="ds-range-label" htmlFor="checkout-logo-height-range">
              Altura do logo <s-text color="subdued">{`${height}px`}</s-text>
            </label>
            <input
              id="checkout-logo-height-range"
              className="ds-range"
              type="range"
              min={LOGO_HEIGHT_MIN}
              max={LOGO_HEIGHT_SLIDER_MAX}
              value={Math.min(Math.max(height || LOGO_HEIGHT_MIN, LOGO_HEIGHT_MIN), LOGO_HEIGHT_SLIDER_MAX)}
              onChange={(e) => setHeight(Number(e.target.value))}
              disabled={disabled || !logo || busy !== null}
            />
            <s-text color="subdued">A largura acompanha a proporção da imagem. No celular o logo fica com no máximo 40px.</s-text>
          </s-stack>
          <DsNumberField
            label="px"
            value={Number.isFinite(height) ? String(height) : ''}
            onChange={(v) => setHeight(Number.parseInt(v, 10))}
            min={LOGO_HEIGHT_MIN}
            max={LOGO_HEIGHT_MAX}
            suffix="px"
            inputMode="numeric"
            disabled={disabled || !logo || busy !== null}
            error={heightValid ? undefined : `Entre ${LOGO_HEIGHT_MIN} e ${LOGO_HEIGHT_MAX}px`}
          />
        </s-grid>

        <s-stack gap="small-100">
          <s-text>Alinhamento do logo</s-text>
          <div role="group" aria-label="Alinhamento do logo">
            <s-stack direction="inline" gap="small-200">
              {(
                [
                  ['left', 'Esquerda'],
                  ['center', 'Centro'],
                  ['right', 'Direita'],
                ] as const
              ).map(([value, label]) => (
                <AlignButton key={value} pressed={align === value} disabled={disabled || !logo || busy !== null} onClick={() => setAlign(value)}>
                  {label}
                </AlignButton>
              ))}
            </s-stack>
          </div>
        </s-stack>

        <s-stack gap="small-200">
          <s-text color="subdued">Prévia — computador</s-text>
          <CheckoutHeaderPreview logoUrl={logo} brandName={brandName.trim()} height={height || 32} align={align} />
          <s-text color="subdued">Prévia — celular</s-text>
          <CheckoutHeaderPreview logoUrl={logo} brandName={brandName.trim()} height={height || 32} align={align} mobile />
        </s-stack>

        {error && (
          <div role="alert">
            <s-text tone="critical">{error}</s-text>
          </div>
        )}

        <s-stack direction="inline" gap="small-200">
          <DsButton variant="secondary" onClick={() => void saveHeader()} loading={busy === 'save'} disabled={disabled || !dirty || !heightValid || busy !== null}>
            Salvar cabeçalho
          </DsButton>
          {dirty && (
            <DsButton
              variant="tertiary"
              onClick={() => {
                setHeight(state.checkout_logo_height);
                setAlign(state.checkout_logo_align);
                setBrandName(state.brand_name ?? '');
              }}
              disabled={busy !== null}
            >
              Cancelar
            </DsButton>
          )}
        </s-stack>
      </s-stack>
    </s-box>
  );
}

/** Botão de alternância do alinhamento (s-press-button com `pressed`/`disabled` como propriedades). */
function AlignButton({ pressed, disabled, onClick, children }: { pressed: boolean; disabled: boolean; onClick: () => void; children: string }): JSX.Element {
  const ref = useRef<HTMLElementTagNameMap['s-press-button']>(null);
  useElementProperties(ref, { pressed, disabled });
  return (
    <s-press-button ref={ref} onClick={onClick}>
      {children}
    </s-press-button>
  );
}
