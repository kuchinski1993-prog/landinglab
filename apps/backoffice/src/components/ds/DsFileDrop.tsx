'use client';

// Story 20.11d (PR A, Decisão 4) — área de arrastar/escolher arquivo no visual novo (no lugar do `DropZone`
// do Polaris React, que não tem equivalente nos Web Components fora do admin da Shopify). Usa o `.ds-dropzone`
// de ds-tokens.css (borda tracejada; `data-dragging` ao arrastar). O campo de arquivo nativo continua na
// página (oculto, com nome acessível) e o botão do DS abre o seletor: funciona por teclado.
// Entrega TODOS os arquivos soltos/escolhidos para a tela (como o `onDrop(files)` do DropZone): o tipo e o
// limite continuam sendo conferidos pela tela, com as mesmas mensagens.

import { useId, useRef, useState, type DragEvent } from 'react';

import { DsButton } from './DsButton';

export interface DsFileDropProps {
  /** Nome acessível do campo de arquivo (ex.: "Importar página (HTML ou ZIP)"). */
  label: string;
  /** `accept` do campo nativo (ex.: ".html,.htm,.zip,text/html,application/zip"). */
  accept: string;
  actionTitle: string;
  actionHint?: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}

export function DsFileDrop({ label, accept, actionTitle, actionHint, disabled = false, onFiles }: DsFileDropProps): JSX.Element {
  const inputId = `ds-file-drop-${useId().replace(/:/g, '')}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const open = (): void => {
    if (!disabled) inputRef.current?.click();
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    onFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  return (
    <div
      className="ds-dropzone"
      data-dragging={dragging || undefined}
      data-testid="ds-file-drop"
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={(event) => {
        // O clique no botão já abre o seletor, e o `click()` do campo também sobe até aqui: não abre duas vezes.
        if (event.target === inputRef.current || (event.target as Element).closest('s-button')) return;
        open();
      }}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        aria-label={label}
        hidden
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          onFiles(files);
        }}
      />
      <s-stack gap="small-200" alignItems="center">
        <DsButton variant="secondary" onClick={open} disabled={disabled} accessibilityLabel={`${actionTitle}: ${label}`}>
          {actionTitle}
        </DsButton>
        {actionHint ? <s-text color="subdued">{actionHint}</s-text> : null}
      </s-stack>
    </div>
  );
}
