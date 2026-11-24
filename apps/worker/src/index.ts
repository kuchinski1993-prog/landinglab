// Entry point: boots the worker, wires shutdown signals, and traps uncaught errors.
import { logger } from './logger.js';
import { registerShutdownHandlers } from './shutdown.js';
import { startWorker, toShutdownResources } from './worker.js';

async function main(): Promise<void> {
  // Diagnóstico: confirma quais variáveis Supabase chegaram ao processo
  logger.info(
    {
      hasSupabaseUrl: Boolean(process.env['SUPABASE_URL']),
      hasNextPublicSupabaseUrl: Boolean(process.env['NEXT_PUBLIC_SUPABASE_URL']),
      hasServiceRoleKey: Boolean(process.env['SUPABASE_SERVICE_ROLE_KEY']),
    },
    '[BOOT] supabase env vars',
  );

  const runtime = await startWorker();
  const resources = toShutdownResources(runtime);
  registerShutdownHandlers(resources);
}

// Tesseract.js 5.x tem bug conhecido: WebP mal-formados disparam
// uncaughtException do Worker thread ("pixReadMemWebP: WebP decode failed").
// Sharp em runOcr já pré-processa, mas se alguma edge case escapa, não matar
// o worker inteiro — só logar. Todo OUTRO uncaughtException ainda mata.
function isTesseractWebpError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  const stack = err.stack || '';
  return (
    msg.includes('Error attempting to read image') &&
    stack.includes('tesseract.js')
  );
}

process.on('uncaughtException', (err) => {
  if (isTesseractWebpError(err)) {
    logger.warn({ err }, 'uncaughtException: tesseract WebP decode failed — ignoring (worker continues)');
    return;
  }
  logger.fatal({ err }, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isTesseractWebpError(reason)) {
    logger.warn({ reason }, 'unhandledRejection: tesseract WebP decode failed — ignoring');
    return;
  }
  logger.fatal({ reason }, 'unhandledRejection');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker bootstrap failed');
  process.exit(1);
});
