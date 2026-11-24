// Erro de aplicação com código estável (ver docs/architecture/erros.md).
export interface AppErrorOptions {
  /** A `message` foi escolhida pelo código chamador para o usuário (PT-BR) e pode ir no corpo. */
  publicMessage?: boolean;
  cause?: unknown;
}

/**
 * Base dos erros tipados. Assinatura `(message, statusCode = 400, code?, details?)` igual à do
 * `VslError`, que a estende. A `message` só vai para o corpo quando é a do catálogo ou quando
 * `publicMessage` é true (criada por `catalog.error(code, details, message)`).
 */
export class AppError extends Error {
  readonly publicMessage: boolean;

  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code?: string,
    readonly details?: unknown,
    options: AppErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.publicMessage = options.publicMessage === true;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
