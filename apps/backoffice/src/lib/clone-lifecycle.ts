// Clone lifecycle — fonte única de verdade para derivar estado de clonagem.
//
// Estratégia sem migration:
//   clone_metadata == null                          → nunca clonado (manual/autopilot)
//   clone_metadata.clone_status == 'cloning'        → clone em andamento
//   clone_metadata.clone_status == 'failed'         → clone falhou
//   clone_metadata.clone_status ausente + cloned_at → completado (inclui rows legadas)
//   htmlBody startsWith '<!-- cloning')             → fallback para rows pré-esta-mudança
//
// O worker grava clone_metadata = { clone_status: 'cloning' } ao enfileirar e
// sobrescreve com dados reais ao concluir (clone_status ausente = completo).
//
// Legacy/Manual classification:
//   generation_mode === 'manual' AND clone_metadata === null → legacy manual
//   generation_mode === null AND clone_metadata === null    → legacy (pré-pipeline)

export type CloneLifecycleStatus =
  | 'not_cloned'   // manual ou autopilot — nunca passou pelo cloner
  | 'cloning'      // clone em andamento
  | 'processing'   // clone completo, worker secundário ainda processando (translate etc)
  | 'failed'       // clone falhou
  | 'ready';       // clone completo e pronto

export interface CloneLifecycleInfo {
  status: CloneLifecycleStatus;
  /** Mensagem human-readable para exibir na UI */
  label: string;
  /** true = editor deve bloquear ações destrutivas */
  isBlocked: boolean;
  /** Erro descritivo quando status === 'failed' */
  errorMessage: string | null;
}

const HTML_CLONING_MARKERS = ['<!-- cloning in progress -->', '<!-- reclone in progress -->'];

/**
 * Classifica se uma landing é "legacy/manual" — criada fora do pipeline atual
 * de clonagem. Critérios:
 *   - generation_mode === 'manual' (nunca passou pelo cloner)
 *   - OU generation_mode === null (row pré-pipeline, anterior ao campo)
 *   - E clone_metadata === null (confirma que nenhum clone foi feito)
 *
 * Landings com generation_mode === 'cloned' NUNCA são legacy, mesmo que
 * clone_metadata seja null (seria um clone antigo sem metadata, mas ainda
 * passou pelo pipeline).
 *
 * @returns true se a landing é legacy/manual e deve exibir aviso ao operador.
 */
export function isLegacyManualLanding(
  generationMode: string | null,
  cloneMetadata: Record<string, unknown> | null,
): boolean {
  if (generationMode === 'cloned') return false;
  if (generationMode === 'autopilot') return false;
  // manual ou null + sem clone_metadata = legacy
  return cloneMetadata === null;
}

export function deriveCloneLifecycle(
  generationMode: string | null,
  cloneMetadata: Record<string, unknown> | null,
  clonedAt: string | null,
  htmlBody: string,
): CloneLifecycleInfo {
  // Não é clone — não aplica lifecycle de clonagem.
  if (generationMode !== 'cloned') {
    return { status: 'not_cloned', label: '', isBlocked: false, errorMessage: null };
  }

  // Fallback para rows pré-lifecycle: htmlBody é o único indicador.
  if (cloneMetadata === null) {
    const isPlaceholder = HTML_CLONING_MARKERS.some((m) => htmlBody.startsWith(m));
    if (isPlaceholder) {
      return { status: 'cloning', label: 'Clonando…', isBlocked: true, errorMessage: null };
    }
    // clone_metadata null + htmlBody real + clonedAt null → clone antigo sem metadata
    return { status: 'ready', label: '', isBlocked: false, errorMessage: null };
  }

  const cloneStatus = cloneMetadata['clone_status'] as string | undefined;

  if (cloneStatus === 'cloning') {
    return { status: 'cloning', label: 'Clonando…', isBlocked: true, errorMessage: null };
  }

  if (cloneStatus === 'failed') {
    const err = (cloneMetadata['clone_error'] as string | undefined) ?? 'Erro desconhecido.';
    return {
      status: 'failed',
      label: 'Falha no clone',
      isBlocked: true,
      errorMessage: err,
    };
  }

  // clone_status ausente em clone_metadata real = clone completo.
  // Mas tradução/processamento secundário pode ainda estar rodando.
  const translationStatus = cloneMetadata['translation_status'] as string | undefined;
  const isProcessing =
    translationStatus === 'text_pending' ||
    translationStatus === 'text_running' ||
    translationStatus === 'images_pending' ||
    translationStatus === 'images_running';

  if (isProcessing) {
    return {
      status: 'processing',
      label: 'Processando…',
      isBlocked: false,
      errorMessage: null,
    };
  }

  // cloned_at presente ou clone_metadata com chaves canônicas de conclusão = pronto.
  // GAP-05 (2026-09-28): antes checávamos `Object.keys(cloneMetadata).length > 0`,
  // que dava falso positivo quando o worker gravava só `clone_started_at` no início
  // (metadata parcial). Agora exigimos chaves canônicas escritas pelo cloner ao
  // finalizar: 'assets_ok' (contador de assets baixados) ou 'bytes' (tamanho do
  // htmlBody final). Presence de 'source_url' também qualifica (rows legadas).
  const hasCompletionKey =
    'assets_ok' in cloneMetadata ||
    'bytes' in cloneMetadata ||
    'source_url' in cloneMetadata ||
    'fidelity_verdict' in cloneMetadata;
  if (clonedAt || hasCompletionKey) {
    return { status: 'ready', label: '', isBlocked: false, errorMessage: null };
  }

  // Fallback seguro
  return { status: 'cloning', label: 'Clonando…', isBlocked: true, errorMessage: null };
}
