// API entry point. Builds the Fastify server and binds to PORT (Railway) or PORT_API (local).
import { logIntegrationModes } from './lib/integration-mode.js';
import { buildServer } from './server.js';

async function start(): Promise<void> {
  let app;
  try {
    app = await buildServer();
  } catch (error) {
    console.error('Failed to build server:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  try {
    await app.listen({ port: app.config.port, host: app.config.host });
    app.log.info(`API listening on http://${app.config.host}:${app.config.port}`);
    // Story 0.4 · AC9: modo das integrações no boot (error em produção com mock/sem modo).
    logIntegrationModes(app.log, 'api');
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down gracefully`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start();
