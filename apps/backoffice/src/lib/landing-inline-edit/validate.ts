// Story 26.1 — validação das edições de seção, botão e preço vindas do editor visual.
import { validateButtonHref } from '@blackshop/shared/landing-edits-runtime';

import { TEXT_MAX, type ButtonEdit, type PriceEdit, type SectionEdit, type TargetEdits } from './targets';

const MAX_EDITS = 500;
const ID_RE = /^[sbp]_\d{1,5}_[0-9a-z]{1,13}$/;
const SECTION_ACTIONS = new Set(['hide', 'show', 'remove']);

export type ParseTargetEditsResult = { ok: true; edits: TargetEdits } | { ok: false; message: string };

/** Remove caracteres de controle e junta espaços (texto de botão/preço é uma linha). */
export function cleanLineText(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    out += c < 32 || c === 127 ? ' ' : input[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export function parseTargetEdits(payload: Record<string, unknown>): ParseTargetEditsResult {
  const rawSections = list(payload['sectionEdits']);
  const rawButtons = list(payload['buttonEdits']);
  const rawPrices = list(payload['priceEdits']);
  if (rawSections.length + rawButtons.length + rawPrices.length > MAX_EDITS) {
    return { ok: false, message: `No máximo ${MAX_EDITS} edições por vez` };
  }

  const sectionEdits: SectionEdit[] = [];
  for (const r of rawSections) {
    const e = (r ?? {}) as Record<string, unknown>;
    const id = e['id'];
    const action = e['action'];
    if (typeof id !== 'string' || !ID_RE.test(id) || !id.startsWith('s_')) return { ok: false, message: 'Seção inválida' };
    if (typeof action !== 'string' || !SECTION_ACTIONS.has(action)) return { ok: false, message: 'Ação de seção inválida' };
    sectionEdits.push({ id, action: action as SectionEdit['action'] });
  }

  const buttonEdits: ButtonEdit[] = [];
  for (const r of rawButtons) {
    const e = (r ?? {}) as Record<string, unknown>;
    const id = e['id'];
    if (typeof id !== 'string' || !ID_RE.test(id) || !id.startsWith('b_')) return { ok: false, message: 'Botão inválido' };
    const edit: ButtonEdit = { id };
    if (e['text'] !== undefined) {
      if (typeof e['text'] !== 'string') return { ok: false, message: 'Texto do botão inválido' };
      const text = cleanLineText(e['text']);
      if (!text) return { ok: false, message: 'O texto do botão não pode ficar vazio' };
      if (text.length > TEXT_MAX) return { ok: false, message: `Texto do botão com mais de ${TEXT_MAX} caracteres` };
      edit.text = text;
    }
    if (e['href'] !== undefined) {
      if (typeof e['href'] !== 'string') return { ok: false, message: 'Link do botão inválido' };
      if (!e['href'].trim()) {
        edit.href = '';
      } else {
        const res = validateButtonHref(e['href']);
        if (!res.ok) return { ok: false, message: `Link do botão: ${res.reason}` };
        edit.href = res.href;
      }
    }
    if (edit.text === undefined && edit.href === undefined) continue;
    buttonEdits.push(edit);
  }

  const priceEdits: PriceEdit[] = [];
  for (const r of rawPrices) {
    const e = (r ?? {}) as Record<string, unknown>;
    const id = e['id'];
    if (typeof id !== 'string' || !ID_RE.test(id) || !id.startsWith('p_')) return { ok: false, message: 'Preço inválido' };
    if (typeof e['text'] !== 'string') return { ok: false, message: 'Texto do preço inválido' };
    const text = cleanLineText(e['text']);
    if (!text) return { ok: false, message: 'O preço não pode ficar vazio' };
    if (text.length > TEXT_MAX) return { ok: false, message: `Preço com mais de ${TEXT_MAX} caracteres` };
    priceEdits.push({ id, text });
  }

  return { ok: true, edits: { sectionEdits, buttonEdits, priceEdits } };
}

export function hasTargetEdits(e: TargetEdits): boolean {
  return e.sectionEdits.length + e.buttonEdits.length + e.priceEdits.length > 0;
}
