import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'Closing HTTP server and MySQL pool');
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    if (config.NODE_ENV === 'production') {
      const readiness = await app.inject({ method: 'GET', url: '/health/ready' });
      if (readiness.statusCode !== 200) throw new Error('MySQL is unavailable; production startup stopped.');
    }
    await app.listen({ port: config.PORT, host: config.HOST });
    if (!config.DB_ENABLED) app.log.warn('MySQL is disabled. Configure .env before adding database features.');
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backend startup failed.');
  process.exitCode = 1;
});
