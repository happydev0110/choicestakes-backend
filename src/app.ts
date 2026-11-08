import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config/env.js';
import { createDatabase, type DatabaseHealth } from './database/mysql.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { createAuthStore } from './modules/auth/store.js';
import { AuthError, type AuthStore } from './modules/auth/types.js';
import type { Database } from './database/mysql.js';
import { ApiMaticClient } from './modules/gaming/client.js';
import { createGamingStore, type GamingStore } from './modules/gaming/store.js';
import { registerGamingRoutes } from './modules/gaming/routes.js';

export async function buildApp(config: Config, dependencies: { database?: DatabaseHealth; authStore?: AuthStore; gamingStore?: GamingStore; gamingClient?: Pick<ApiMaticClient,'launch'> } = {}) {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: {
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          url: request.url.split('?')[0] ?? '/',
        }),
      },
    },
  });

  const database = dependencies.database ?? createDatabase(config);
  app.addHook('onClose', async () => database.close());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  try {
    await app.register(cors, {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      exposedHeaders: ['X-Request-Id'],
      credentials: false,
      maxAge: 600,
    });
    await app.register(helmet);
    await app.register(cookie);
    await app.register(rateLimit, { global: false });

    app.setErrorHandler((error, request, reply) => {
      const errorStatus = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const status = error instanceof AuthError ? error.statusCode : typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 500
        ? errorStatus : 500;
      if (status >= 500) request.log.error({ err: error }, 'Request failed');
      return reply.code(status).send({
        success: false,
        error: {
          code: error instanceof AuthError ? error.code : status === 429 ? 'TOO_MANY_ATTEMPTS' : status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
          message: error instanceof AuthError ? error.message : status === 429 ? 'Too many requests. Please try again later.' : status >= 500 ? 'An unexpected error occurred.' : 'The request could not be processed.',
        },
        requestId: request.id,
      });
    });
    app.setNotFoundHandler((request, reply) => reply.code(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'This API endpoint does not exist.' },
      requestId: request.id,
    }));

    await registerHealthRoutes(app, database);
    const authStore = dependencies.authStore ?? createAuthStore(database as Database);
    await registerAuthRoutes(app, config, authStore);
    await registerGamingRoutes(app, config, authStore, dependencies.gamingStore ?? createGamingStore(database as Database,config), dependencies.gamingClient ?? new ApiMaticClient(config));
    await app.register(async (api) => {
      api.get('/', async () => ({
        success: true,
        data: { service: 'choicestacks-backend', apiVersion: 'v1' },
      }));
    }, { prefix: '/api/v1' });

    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
