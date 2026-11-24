// Story 19.3a — registro de módulos (fonte única dos ids).
import { describe, expect, it } from 'vitest';

import {
  MODULE_ID_PATTERN,
  MODULE_IDS,
  MODULES,
  isKnownModule,
  moduleMeta,
  resolveModuleStates,
} from '../modules.js';

describe('MODULES (AC1 d)', () => {
  it('ids únicos e no formato do CHECK da tabela', () => {
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length);
    for (const id of MODULE_IDS) expect(id).toMatch(MODULE_ID_PATTERN);
    expect(MODULE_ID_PATTERN.source).toBe('^[a-z][a-z0-9-]{1,40}$');
  });

  it('lista inicial = ids que o código já usa; todos ligados por padrão; sistema sempre ligado', () => {
    expect([...MODULE_IDS].sort()).toEqual(
      ['atendimento', 'catalogo', 'landinglab', 'loja-online', 'marketing', 'pedidos', 'sistema', 'tracker', 'vsl'].sort(),
    );
    for (const m of MODULES) expect(m.defaultEnabled).toBe(true);
    expect(MODULES.filter((m) => m.alwaysOn).map((m) => m.id)).toEqual(['sistema']);
    expect(moduleMeta('sistema')?.area).toBe('sistema');
  });

  it('envs e queues começam vazios (boot de produção não muda — AC14)', () => {
    for (const m of MODULES) {
      expect(m.envs).toEqual([]);
      expect(m.queues ?? []).toEqual([]);
    }
  });

  it('níveis: landinglab/vsl/tracker na Conta; o resto da loja na Loja', () => {
    expect(MODULES.filter((m) => m.area === 'conta').map((m) => m.id)).toEqual(['landinglab', 'vsl', 'tracker']);
    expect(MODULES.filter((m) => m.area === 'loja').map((m) => m.id)).toEqual([
      'catalogo',
      'pedidos',
      'loja-online',
      'atendimento',
      'marketing',
    ]);
  });

  it('isKnownModule / moduleMeta', () => {
    expect(isKnownModule('vsl')).toBe(true);
    expect(isKnownModule('nao-existe')).toBe(false);
    expect(isKnownModule(42)).toBe(false);
    expect(isKnownModule(undefined)).toBe(false);
    expect(moduleMeta('nao-existe')).toBeUndefined();
    expect(moduleMeta('vsl')?.label).toBe('VSL');
  });
});

describe('resolveModuleStates — ausência de linha = ligado', () => {
  it('sem nenhuma linha: tudo ligado', () => {
    const states = resolveModuleStates([]);
    expect(states.map((s) => s.id)).toEqual([...MODULE_IDS]);
    expect(states.every((s) => s.enabled)).toBe(true);
  });

  it('linha enabled=false desliga só aquele módulo', () => {
    const states = resolveModuleStates([{ module: 'vsl', enabled: false }, { module: 'tracker', enabled: true }]);
    expect(states.find((s) => s.id === 'vsl')?.enabled).toBe(false);
    expect(states.filter((s) => !s.enabled).map((s) => s.id)).toEqual(['vsl']);
  });

  it('sistema nunca é desligado, nem com linha gravada à mão; módulo desconhecido é ignorado', () => {
    const states = resolveModuleStates([
      { module: 'sistema', enabled: false },
      { module: 'modulo-velho', enabled: false },
    ]);
    expect(states.find((s) => s.id === 'sistema')).toMatchObject({ enabled: true, alwaysOn: true });
    expect(states.some((s) => s.id === 'modulo-velho')).toBe(false);
    expect(states.every((s) => s.enabled)).toBe(true);
  });
});
