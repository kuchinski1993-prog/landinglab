// html-snapshot-repo — Persistência + restore de landing_html_snapshots.
//
// Fase 7 do Landing Lab Stabilization Roadmap.
//
// Complementa html-safety (Fase 6):
//   html-safety valida + retorna snapshot em memória (in-memory HtmlSnapshot)
//   este módulo persiste em landing_html_snapshots pra rollback futuro
//
// USO TÍPICO no worker:
//   const safe = safeApplyHtmlMutation(before, mutator, opts);
//   if (safe.ok) {
//     await persistSnapshot(db, landingPageId, safe.snapshot, {
//       bytesAfter: safe.newHtml.length,
//       sha256After: sha256Hex(safe.newHtml),
//       warnings: safe.warnings,
//     });
//     await db.update(landingPages)...set({ htmlBody: safe.newHtml });
//   }
//
// USO PRA ROLLBACK (via ferramenta admin ou API):
//   const restored = await restorePreviousSnapshot(db, landingPageId);
//   if (restored.ok) {
//     // html_body voltou pra versão do snapshot mais recente

import { desc, eq } from 'drizzle-orm';

import type { HtmlSnapshot } from './html-safety.js';

// Type-only import evita ciclo com @blackshop/db em runtime, mas mantém tipagem.
// O caller passa o `db` client já instanciado (injetável = testável).
type Db = {
  insert: (table: unknown) => {
    values: (v: unknown) => Promise<unknown> | Promise<void>;
  };
  select: () => {
    from: (table: unknown) => {
      where: (cond: unknown) => {
        orderBy: (col: unknown) => {
          limit: (n: number) => Promise<Array<unknown>>;
        };
      };
    };
  };
  update: (table: unknown) => {
    set: (values: unknown) => {
      where: (cond: unknown) => Promise<unknown> | Promise<void>;
    };
  };
};

// ─────────────────────────────────────────────────────────────────
// Persistência
// ─────────────────────────────────────────────────────────────────

export interface PersistSnapshotExtras {
  /** Bytes do HTML pós-mutação (opcional, ajuda auditoria) */
  bytesAfter?: number;
  /** SHA256 do HTML pós-mutação */
  sha256After?: string;
  /** Warnings emitidos pela safeApplyHtmlMutation */
  warnings?: string[];
  /**
   * Fingerprint dos dados canônicos usados no render (Fase 9A).
   * Permite detectar não-idempotência: 2 jobs consecutivos com mesmo
   * fingerprint mas sha256After diferente = bug de determinismo.
   */
  dataFingerprint?: string;
}

/**
 * Persiste snapshot pré-mutação em landing_html_snapshots.
 *
 * Não bloqueia — se falhar, apenas loga (histórico é best-effort).
 * Snapshot em memória (retornado por safeApplyHtmlMutation) continua útil
 * mesmo se persist falhar.
 */
export async function persistSnapshot(
  db: Db,
  landingHtmlSnapshotsTable: unknown,
  landingPageId: string,
  snapshot: HtmlSnapshot,
  extras: PersistSnapshotExtras = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.insert(landingHtmlSnapshotsTable).values({
      landingPageId,
      reason: snapshot.reason,
      actor: snapshot.actor,
      htmlBody: snapshot.htmlBody,
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
      bytesAfter: extras.bytesAfter ?? null,
      sha256After: extras.sha256After ?? null,
      warnings: extras.warnings ?? [],
      dataFingerprint: extras.dataFingerprint ?? null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────
// Rollback / restore
// ─────────────────────────────────────────────────────────────────

export interface RestoreResult {
  ok: boolean;
  restoredSha256?: string;
  restoredBytes?: number;
  restoredAt?: string;
  error?: string;
}

/**
 * Restaura landing_pages.html_body pro snapshot mais recente.
 *
 * ATENÇÃO: essa operação **cria um novo snapshot** do estado atual
 * antes de sobrescrever, pra que rollback do rollback seja possível.
 *
 * Retorna metadados do estado restaurado ou erro.
 */
export async function restorePreviousSnapshot(
  db: Db,
  landingPagesTable: unknown,
  landingHtmlSnapshotsTable: unknown,
  landingPageId: string,
  landingPagesIdCol: unknown,
  landingPageIdCol: unknown,
  createdAtCol: unknown,
): Promise<RestoreResult> {
  try {
    // 1. Busca snapshot mais recente
    const [snapshot] = (await db
      .select()
      .from(landingHtmlSnapshotsTable)
      .where(eq(landingPageIdCol as never, landingPageId))
      .orderBy(desc(createdAtCol as never))
      .limit(1)) as Array<{
      id: string;
      htmlBody: string;
      bytes: number;
      sha256: string;
      createdAt: Date;
    }>;

    if (!snapshot) {
      return { ok: false, error: 'no snapshot found for landing' };
    }

    // 2. Aplica restore
    await db
      .update(landingPagesTable)
      .set({ htmlBody: snapshot.htmlBody, updatedAt: new Date() })
      .where(eq(landingPagesIdCol as never, landingPageId));

    // Nota: não criamos snapshot do estado pré-rollback aqui por evitar dep
    // circular no import. Ferramenta admin que expor esse endpoint deve
    // wrappar em safeApplyHtmlMutation + persistSnapshot antes de chamar.

    return {
      ok: true,
      restoredSha256: snapshot.sha256,
      restoredBytes: snapshot.bytes,
      restoredAt: snapshot.createdAt.toISOString(),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────
// Clone Source Preservation — Fase 9E.1 (27/09/2026)
// ─────────────────────────────────────────────────────────────────

export interface PersistCloneInitialResult {
  /** true = operação concluiu sem erro de infra (landing tem source válido) */
  ok: boolean;
  /**
   * true = INSERT criou row nova (primeira execução).
   * false = já existia clone-initial pra landing (retry OU divergência).
   *
   * NUNCA use created pra inferir SHA — sempre use `diverged` pra isso.
   */
  created: boolean;
  /**
   * SHA do snapshot ATUAL na tabela pós-operação
   * (o que foi criado agora se created=true, ou o preexistente se created=false).
   */
  currentSha: string | null;
  /**
   * true = já existia clone-initial com SHA DIFERENTE do finalHtml passado.
   * Snapshot original preservado. Caller DEVE bloquear write em html_body.
   *
   * false quando: primeira execução (created=true) OU retry com MESMO HTML.
   */
  diverged: boolean;
  /** Presente quando ok=false (erro de infra: DB down, etc) */
  error?: string;
}

/**
 * Persiste snapshot clone-initial IDEMPOTENTE.
 *
 * Semântica Fase 9E.1:
 * - Se NÃO existe clone-initial pra landing → INSERT + created=true
 * - Se EXISTE clone-initial → ON CONFLICT DO NOTHING + created=false.
 *   Preserva o primeiro. NÃO sobrescreve.
 * - Se retry gerou HTML diferente do preservado → diverged=true (audit).
 *
 * Depende de UNIQUE INDEX parcial `idx_landing_html_snapshots_clone_initial_unique`
 * criado pela migration 0073. Se índice não existir, comportamento cai em
 * INSERT sem proteção (racy) — mas Fase 9E.1 assume índice presente.
 *
 * FAILURE SEMANTICS: caller (clone processor) DEVE tratar ok=false como bloqueio
 * pra não enfileirar mutations downstream. Fase 9E.1 estabelece regra: "clone
 * não é considerado concluído até source estar preservado."
 *
 * @param db                          Client Drizzle (repo passa direto db-object)
 * @param landingHtmlSnapshotsTable   Reference pra tabela
 * @param whereClause                 Callable que retorna condição drizzle (landingPageId AND reason='clone-initial')
 * @param landingPageId               UUID da landing (usado no INSERT)
 * @param snapshot                    Snapshot in-memory
 */
export async function persistCloneInitialSnapshot(
  db: {
    insert: (table: unknown) => {
      values: (v: unknown) => {
        onConflictDoNothing: () => Promise<unknown> | Promise<void>;
      };
    };
    select: () => {
      from: (table: unknown) => {
        where: (cond: unknown) => {
          limit: (n: number) => Promise<Array<unknown>>;
        };
      };
    };
  },
  landingHtmlSnapshotsTable: unknown,
  whereClause: unknown, // drizzle condition built by caller
  landingPageId: string,
  snapshot: HtmlSnapshot,
): Promise<PersistCloneInitialResult> {
  try {
    // FIX 9E.1 CLOSURE (27/09/2026): SELECT ANTES do INSERT.
    //
    // Contrato correto:
    //   created = "criei row nova AGORA" (não "SHA bate")
    //   diverged = "já existia com SHA diferente"
    //
    // Implementação anterior (v1) misturava os dois em `created = sha === snapshot.sha`.
    // Cenário retry mesmo HTML: reportava created=true incorretamente.
    // Fix: SELECT preexistente antes do INSERT decide os flags sem ambiguidade.

    // Passo 1: verifica se já existe (pré-INSERT)
    const preExisting = (await db
      .select()
      .from(landingHtmlSnapshotsTable)
      .where(whereClause)
      .limit(1)) as Array<{ sha256: string } | undefined>;
    const priorSha = preExisting[0]?.sha256 ?? null;

    if (priorSha !== null) {
      // JÁ EXISTE. INSERT vai ON CONFLICT DO NOTHING — não precisa nem tentar.
      // Preserva original SEM tocar.
      const diverged = priorSha !== snapshot.sha256;
      return {
        ok: true,
        created: false,
        currentSha: priorSha,
        diverged,
      };
    }

    // Passo 2: NÃO EXISTIA — tenta INSERT idempotente
    // (ON CONFLICT DO NOTHING protege contra race condition entre 2 workers)
    await db
      .insert(landingHtmlSnapshotsTable)
      .values({
        landingPageId,
        reason: snapshot.reason, // caller passa 'clone-initial'
        actor: snapshot.actor,
        htmlBody: snapshot.htmlBody,
        bytes: snapshot.bytes,
        sha256: snapshot.sha256,
        bytesAfter: null,
        sha256After: null,
        warnings: [],
        dataFingerprint: null,
      })
      .onConflictDoNothing();

    // Passo 3: re-SELECT pra confirmar que insert aconteceu (ou race foi tratada)
    const [confirmed] = (await db
      .select()
      .from(landingHtmlSnapshotsTable)
      .where(whereClause)
      .limit(1)) as Array<{ sha256: string } | undefined>;

    if (!confirmed) {
      // INSERT rodou mas SELECT nada — bug de invariante ou race grave
      return {
        ok: false,
        created: false,
        currentSha: null,
        diverged: false,
        error: 'snapshot select returned empty after INSERT (invariant violation)',
      };
    }

    // Race edge case: outro worker criou entre nosso SELECT pré e INSERT.
    // Nesse caso `confirmed.sha256` pode ser DIFERENTE do que tentamos inserir.
    if (confirmed.sha256 !== snapshot.sha256) {
      return {
        ok: true,
        created: false,
        currentSha: confirmed.sha256,
        diverged: true,
      };
    }

    // Caminho feliz: primeira criação
    return {
      ok: true,
      created: true,
      currentSha: confirmed.sha256,
      diverged: false,
    };
  } catch (err) {
    return {
      ok: false,
      created: false,
      currentSha: null,
      diverged: false,
      error: (err as Error).message,
    };
  }
}
