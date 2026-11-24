'use client';

// Story 20.5e — link primário de linha clicável (`s-table-row clickDelegate` → `s-link`).
//
// Só com `clickDelegate` o Polaris liga hover/cursor da linha e transforma o clique na linha em
// clique no link (ignorando s-checkbox/s-button/s-link da linha). Este hook navega pelo router no
// clique simples e deixa Ctrl/Cmd/Shift/Alt/botão do meio com o `href` nativo (nova aba).
//
// Story 20.5h — o delegate repassa o clique da CÉLULA ao link como um clique novo, sem a tecla
// modificadora (medido no Chromium: `ctrlKey: false`, `isTrusted: false`), então Ctrl/Cmd/Shift-clique
// ou botão do meio fora do link abriria na mesma aba. O hook escuta a linha na captura (antes do
// delegate) e, nesses casos, abre o `href` do link em nova aba. Alt fica de fora (no navegador,
// Alt-clique em link é "baixar"). Controles da linha (link, botão, checkbox…) seguem com o próprio
// comportamento.

import { useEffect, type RefObject } from 'react';

import { useElementEvent } from './use-custom-element';

/** Clique "abrir em nova aba/janela": deixa o href nativo do link agir. */
export function isModifiedClick(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

/** Clique numa célula que deve abrir o link da linha em nova aba: Ctrl/Cmd/Shift ou botão do meio (Alt não). */
export function isNewTabClick(event: MouseEvent): boolean {
  if (event.type === 'auxclick') return event.button === 1;
  return event.button === 0 && (event.metaKey || event.ctrlKey || event.shiftKey);
}

/** Controles da linha que têm comportamento próprio: o clique neles nunca vira "abrir a linha". */
export const ROW_CONTROL_SELECTOR =
  's-link, s-button, s-checkbox, s-clickable, s-switch, a, button, input, select, textarea, label';

export function useRowLink(linkRef: RefObject<HTMLElementTagNameMap['s-link']>, onNavigate: () => void): void {
  useElementEvent<HTMLElementTagNameMap['s-link'], MouseEvent>(linkRef, 'click', (event) => {
    if (isModifiedClick(event)) return;
    event.preventDefault();
    onNavigate();
  });

  useEffect(() => {
    const link = linkRef.current;
    const row = link?.closest('s-table-row');
    if (!link || !row) return undefined;
    const onRowClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || !isNewTabClick(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest(ROW_CONTROL_SELECTOR);
      if (control && row.contains(control)) return;
      const href = link.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      // `Immediate`: nenhum outro ouvinte da linha (nem o delegate do Polaris) repete a abertura.
      event.stopImmediatePropagation();
      window.open(href, '_blank', 'noopener');
    };
    row.addEventListener('click', onRowClick, true);
    row.addEventListener('auxclick', onRowClick, true);
    return () => {
      row.removeEventListener('click', onRowClick, true);
      row.removeEventListener('auxclick', onRowClick, true);
    };
  }, [linkRef]);
}
