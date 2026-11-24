'use client';

// Moldura do checkout no padrão Shopify one-page (Story 15.7): header com
// borda, grade de 2 colunas (formulário | resumo cinza até a borda) e, em
// ≤ 999px, barra "Resumo do pedido" colapsável no topo. Só apresentação.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { LOGO_HEIGHT, type HeaderBrand } from './brand';
import styles from './checkout.module.css';

/** Evento disparado pelo bloco "Total" do mobile para abrir o resumo do topo. */
export const OPEN_SUMMARY_EVENT = 'll-checkout-open-summary';

export function openMobileSummary(): void {
  window.dispatchEvent(new Event(OPEN_SUMMARY_EVENT));
}

function BagIcon(): JSX.Element {
  return (
    <svg className={styles.bagIcon} viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
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

export function ChevronIcon({ up = false }: { up?: boolean }): JSX.Element {
  return (
    <svg
      className={styles.chevron}
      viewBox="0 0 14 14"
      width="11"
      height="11"
      aria-hidden="true"
      style={up ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="M2.5 5 7 9.5 11.5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Header Shopify: marca (logo ou nome; vazio se não houver), sacola à direita.
 * Logo centralizado ou à direita não sobrepõe a sacola (grade/flex com gap).
 * Sem logo, o nome fica à esquerda como antes.
 */
export function CheckoutHeader({ brand }: { brand?: HeaderBrand | null }): JSX.Element {
  const logoUrl = brand?.logoUrl ?? null;
  const align = logoUrl ? (brand?.logoAlign ?? 'left') : 'left';
  const logoStyle = { '--ll-logo-h': `${brand?.logoHeight ?? LOGO_HEIGHT.default}px` } as CSSProperties;
  return (
    <header className={styles.header}>
      <div className={styles.headerInner} data-align={align}>
        <div className={styles.brand} data-ll-checkout-brand>
          {logoUrl ? (
            <img className={styles.brandLogo} src={logoUrl} alt={brand?.name || 'Logo'} style={logoStyle} />
          ) : (
            (brand?.name ?? null)
          )}
        </div>
        <BagIcon />
      </div>
    </header>
  );
}

interface ShellProps {
  /** Resumo do pedido (coluna direita no desktop; painel colapsável no mobile). */
  summary: ReactNode;
  /** Rótulo da barra do mobile ("Order summary"). */
  summaryLabel: string;
  /** Total formatado exibido na barra do mobile. */
  summaryTotal: string;
  /** Marca da landing no header (logo ou nome); sem marca, o header fica só com a sacola. */
  brand?: HeaderBrand | null;
  children: ReactNode;
}

export function CheckoutShell({ summary, summaryLabel, summaryTotal, brand, children }: ShellProps): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener(OPEN_SUMMARY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SUMMARY_EVENT, onOpen);
  }, []);

  return (
    <div className={styles.page}>
      <CheckoutHeader brand={brand ?? null} />
      <button
        type="button"
        className={styles.summaryToggle}
        aria-expanded={open}
        aria-controls="ll-mobile-summary"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.summaryToggleLabel}>
          {summaryLabel}
          <ChevronIcon up={open} />
        </span>
        <strong className={styles.summaryToggleTotal}>{summaryTotal}</strong>
      </button>
      <div id="ll-mobile-summary" className={styles.summaryMobile} data-open={open ? 'true' : 'false'}>
        {open ? summary : null}
      </div>
      <div className={styles.layout}>
        <main className={styles.main}>
          <div className={styles.mainInner}>{children}</div>
        </main>
        <aside className={styles.aside}>
          <div className={styles.asideInner}>{summary}</div>
        </aside>
      </div>
    </div>
  );
}
