// Story 19.3a — registro de módulos: fonte ÚNICA dos ids de módulo.
//
// O menu do painel (apps/backoffice/src/lib/nav/registry.ts), as fontes de
// pendência da home (apps/api/src/lib/home-blocks.ts) e a tabela
// `store_modules` (migration 0096) usam estes ids. Testes de contrato amarram
// os três: apps/api/src/__tests__/modules-base.test.ts (home + seed da
// migration) e apps/backoffice/src/__tests__/nav-modules-contract.test.ts (menu).
//
// Puro: não importa o banco nem Node — o painel (client components) importa
// este arquivo pelo subcaminho `@blackshop/shared/modules`.
//
// Semântica (decisões da story 19.3a):
//   • Ausência de linha em `store_modules` = ligado (`defaultEnabled`).
//   • Desligar um módulo SÓ esconde o item do menu e a fonte de pendência da
//     home daquela loja. Não bloqueia rota de API, fila nem tabela — em
//     especial Tracker e Atendimento (TrustShield), que são zonas protegidas.
//   • `alwaysOn` (sistema) nunca pode ser desligado.
//   • `envs` e `queues` começam vazios: cada story 19.3b..n declara as do seu
//     módulo; a 19.4 preenche `queues`.

export type ModuleArea = 'conta' | 'loja' | 'sistema';

export interface ModuleMeta {
  /** Id estável (formato `^[a-z][a-z0-9-]{1,40}$`, igual ao CHECK da tabela). */
  readonly id: string;
  /** Nome que o dono vê. */
  readonly label: string;
  /** Nível no painel: Conta (dados da conta inteira), Loja ou Sistema (sempre visível). */
  readonly area: ModuleArea;
  /** Nunca desligável (PATCH responde `plataforma.module_always_on`). */
  readonly alwaysOn?: boolean;
  /** Estado quando a loja não tem linha em `store_modules`. */
  readonly defaultEnabled: boolean;
  /** Variáveis de ambiente que o módulo exige (validadas por `assertModuleEnvs`). */
  readonly envs: readonly string[];
  /** Filas BullMQ do módulo (preenchido pela 19.4). */
  readonly queues?: readonly string[];
  /** Sem item próprio no menu — justificativa obrigatória (teste de contrato). */
  readonly noMenuReason?: string;
}

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;

export const MODULES: readonly ModuleMeta[] = [
  // Nível Loja
  { id: 'catalogo', label: 'Catálogo', area: 'loja', defaultEnabled: true, envs: [] },
  { id: 'pedidos', label: 'Pedidos', area: 'loja', defaultEnabled: true, envs: [] },
  { id: 'loja-online', label: 'Loja online', area: 'loja', defaultEnabled: true, envs: [] },
  { id: 'atendimento', label: 'Atendimento', area: 'loja', defaultEnabled: true, envs: [] },
  { id: 'marketing', label: 'Marketing', area: 'loja', defaultEnabled: true, envs: [] },
  // Nível Conta (avaliados pela loja ativa — decisão 10 da story)
  { id: 'landinglab', label: 'LandingLab', area: 'conta', defaultEnabled: true, envs: [] },
  { id: 'vsl', label: 'VSL', area: 'conta', defaultEnabled: true, envs: [] },
  { id: 'tracker', label: 'Tracker', area: 'conta', defaultEnabled: true, envs: [] },
  // Sistema: sempre visível, nunca desligável.
  {
    id: 'sistema',
    label: 'Sistema',
    area: 'sistema',
    alwaysOn: true,
    defaultEnabled: true,
    envs: [],
    noMenuReason: 'Tarefas, avisos e configurações da plataforma: sempre visíveis, sem item próprio no menu.',
  },
];

export const MODULE_IDS: readonly string[] = MODULES.map((m) => m.id);

const BY_ID: ReadonlyMap<string, ModuleMeta> = new Map(MODULES.map((m) => [m.id, m]));

/** O id existe no registro? */
export function isKnownModule(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Metadados do módulo (ou `undefined` se o id não existe). */
export function moduleMeta(id: string): ModuleMeta | undefined {
  return BY_ID.get(id);
}

/** Estado efetivo de um módulo numa loja (o que menu, home e API usam). */
export interface ModuleState {
  id: string;
  label: string;
  area: ModuleArea;
  enabled: boolean;
  alwaysOn: boolean;
}

/**
 * Mescla o padrão do registro com as linhas gravadas da loja.
 * Ausência de linha = `defaultEnabled`; `alwaysOn` = sempre ligado (mesmo com
 * linha `enabled = false` gravada à mão); linha de módulo desconhecido é ignorada.
 */
export function resolveModuleStates(
  rows: ReadonlyArray<{ module: string; enabled: boolean }>,
): ModuleState[] {
  const saved = new Map<string, boolean>();
  for (const row of rows) if (isKnownModule(row.module)) saved.set(row.module, row.enabled === true);
  return MODULES.map((m) => ({
    id: m.id,
    label: m.label,
    area: m.area,
    alwaysOn: m.alwaysOn === true,
    enabled: m.alwaysOn === true ? true : saved.get(m.id) ?? m.defaultEnabled,
  }));
}
