import type { FastifyInstance } from 'fastify';
import type { DatabaseHealth } from '../../database/mysql.js';

export async function registerHealthRoutes(app: FastifyInstance, database: DatabaseHealth) {
  app.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', service: 'choicestacks-backend' };
  });

  app.get('/health/ready', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!database.enabled) {
      return reply.code(503).send({ status: 'not_ready', checks: { mysql: 'not_configured' } });
    }
    try {
      await database.ping();
      return { status: 'ok', checks: { mysql: 'up' } };
    } catch (error) {
      request.log.error({ err: error }, 'MySQL readiness check failed');
      return reply.code(503).send({ status: 'not_ready', checks: { mysql: 'down' } });
    }
  });
}
