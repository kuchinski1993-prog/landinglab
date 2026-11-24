'use client';

// @ds-migrated — Story 20.2: seletor de loja do topo do shell (visual novo).
//
// Mostra a loja ativa, troca de loja (cookie `bs:activeStoreId` + `X-Store-Id`,
// tela recarregada pelo shell), "+ Nova loja" (cria a linha, como antes) e
// "Ver todas as lojas". Se a lista não carregar: mensagem em português com
// "Tentar de novo", mantendo a última loja usada — nunca troca sozinho.
//
// HTML próprio (classes ds-shell-*) em vez de `s-*`: o seletor faz parte da
// moldura e precisa funcionar mesmo se o script do Polaris 2 falhar.

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { STORES_LOAD_ERROR, useActiveStore, type CreateStorePayload } from '@/components/shell/active-store';

export function StoreSwitcher(): JSX.Element {
  const { stores, status, activeId, activeName, reload, select, createStore } = useActiveStore();
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Fecha ao clicar fora.
  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function close(returnFocus = true): void {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close();
    }
  }

  function handleSelect(storeId: string): void {
    setOpen(false);
    if (storeId !== activeId) select(storeId);
  }

  function handleOpenModal(): void {
    setOpen(false);
    setModalOpen(true);
  }

  async function handleCreate(payload: CreateStorePayload): Promise<void> {
    await createStore(payload);
    setModalOpen(false);
  }

  return (
    <div className="ds-shell-store" ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="ds-shell-store__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Trocar de loja"
      >
        <s-icon type="store" />
        <span className="ds-shell-store__name" data-testid="active-store-name">
          {activeName}
        </span>
        {status === 'error' ? (
          <span className="ds-shell-store__warn" aria-label="Lista de lojas indisponível">
            !
          </span>
        ) : null}
        <span className="ds-shell-store__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div id={panelId} className="ds-shell-popover ds-shell-store__panel" role="group" aria-label="Trocar de loja">
          <p className="ds-shell-popover__title">Lojas</p>
          {status === 'error' ? (
            <div className="ds-shell-store__error" role="alert">
              <p className="ds-shell-store__error-text">
                {STORES_LOAD_ERROR} A loja ativa continua a mesma.
              </p>
              <button type="button" className="ds-shell-button" onClick={() => void reload()}>
                Tentar de novo
              </button>
            </div>
          ) : null}
          {status === 'loading' && stores.length === 0 ? (
            <p className="ds-shell-popover__hint" aria-busy="true">
              Carregando lojas…
            </p>
          ) : null}
          <ul className="ds-shell-store__list">
            {stores.map((store) => (
              <li key={store.id}>
                <button
                  type="button"
                  className={store.id === activeId ? 'ds-shell-menu-item ds-shell-menu-item--active' : 'ds-shell-menu-item'}
                  aria-current={store.id === activeId ? 'true' : undefined}
                  disabled={!store.isActive}
                  onClick={() => handleSelect(store.id)}
                >
                  {store.isActive ? store.name : `${store.name} (desativada)`}
                </button>
              </li>
            ))}
            {status === 'ready' && stores.length === 0 ? (
              <li className="ds-shell-popover__hint">Nenhuma loja cadastrada</li>
            ) : null}
          </ul>
          <div className="ds-shell-popover__footer">
            <button type="button" className="ds-shell-menu-item" onClick={handleOpenModal}>
              + Nova loja
            </button>
            <Link href="/lojas" className="ds-shell-menu-item" onClick={() => close(false)}>
              Ver todas as lojas
            </Link>
          </div>
        </div>
      ) : null}

      {modalOpen ? <CreateStoreDialog onClose={() => setModalOpen(false)} onSubmit={handleCreate} /> : null}
    </div>
  );
}

export interface CreateStoreDialogProps {
  onClose: () => void;
  onSubmit: (payload: CreateStorePayload) => Promise<void>;
}

/** Story 17.4a · preset de região do diálogo "Nova loja" (nenhum vem marcado: a plataforma não presume Brasil). */
export const REGION_PRESET_BRASIL = { currency: 'BRL', locale: 'pt-BR', timezone: 'America/Sao_Paulo' } as const;
type RegionChoice = 'brasil' | 'depois' | null;

/** Diálogo "Nova loja" (cria a linha da loja, como antes; Story 17.4a: escolha da região). */
export function CreateStoreDialog({ onClose, onSubmit }: CreateStoreDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [region, setRegion] = useState<RegionChoice>(null);
  const regionName = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    nameRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (name.trim().length === 0) {
      setError('Informe o nome da loja.');
      return;
    }
    setSubmitting(true);
    setError(null);
    onSubmit({
      name: name.trim(),
      domain: domain.trim().length > 0 ? domain.trim() : null,
      ...(region === 'brasil' ? REGION_PRESET_BRASIL : {}),
    })
      .catch(() => setError('Não foi possível criar a loja. Tente de novo.'))
      .finally(() => setSubmitting(false));
  }

  return (
    <div
      className="ds-shell-dialog__backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <form
        className="ds-shell-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !submitting) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          // Foco preso no diálogo: Tab/Shift+Tab circulam só pelos controles dele.
          if (e.key === 'Tab') {
            const focusable = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])'),
            );
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id={titleId} className="ds-shell-dialog__title">
          Nova loja
        </h2>
        <label className="ds-shell-field">
          <span className="ds-shell-field__label">Nome da loja</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="ds-shell-field__input"
            data-testid="new-store-name-input"
          />
        </label>
        <label className="ds-shell-field">
          <span className="ds-shell-field__label">Domínio (opcional)</span>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="minhaloja.com"
            className="ds-shell-field__input"
            data-testid="new-store-domain-input"
          />
        </label>
        <fieldset className="ds-shell-field" data-testid="new-store-region" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="ds-shell-field__label">Região (opcional)</legend>
          <label className="ds-shell-field__radio" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="radio"
              name={regionName}
              value="brasil"
              checked={region === 'brasil'}
              onChange={() => setRegion('brasil')}
              data-testid="new-store-region-brasil"
            />{' '}
            Brasil — BRL · pt-BR · America/Sao_Paulo
          </label>
          <label className="ds-shell-field__radio" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="radio"
              name={regionName}
              value="depois"
              checked={region === 'depois'}
              onChange={() => setRegion('depois')}
              data-testid="new-store-region-depois"
            />{' '}
            Definir depois nas Configurações
          </label>
        </fieldset>
        {error ? (
          <p className="ds-shell-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="ds-shell-dialog__actions">
          <button type="button" className="ds-shell-button" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          <button type="submit" className="ds-shell-button ds-shell-button--primary" disabled={submitting}>
            {submitting ? 'Criando…' : 'Criar loja'}
          </button>
        </div>
      </form>
    </div>
  );
}
