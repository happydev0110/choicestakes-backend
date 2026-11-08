import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import type { DatabaseHealth } from '../src/database/mysql.js';

const config = loadConfig({ NODE_ENV: 'test' });

test('liveness works without a database; readiness correctly remains unavailable', async (t) => {
  const app = await buildApp(config);
  t.after(() => app.close());
  const live = await app.inject('/health/live');
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().status, 'ok');
  assert.equal(live.headers['cache-control'], 'no-store');
  assert.ok(live.headers['x-request-id']);
  assert.equal(live.headers['x-content-type-options'], 'nosniff');
  const ready = await app.inject('/health/ready');
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json().checks.mysql, 'not_configured');
});

test('readiness reflects MySQL availability and shutdown closes the database', async () => {
  let unavailable = false;
  let closed = false;
  const database: DatabaseHealth = {
    enabled: true,
    async ping() { if (unavailable) throw new Error('private database connection details'); },
    async close() { closed = true; },
  };
  const app = await buildApp(config, { database });
  try {
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    unavailable = true;
    const failed = await app.inject('/health/ready');
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().checks.mysql, 'down');
    assert.doesNotMatch(failed.body, /private database/);
  } finally {
    await app.close();
  }
  assert.equal(closed, true);
});

test('CORS permits the portal and withholds access headers from unlisted origins', async (t) => {
  const app = await buildApp(config);
  t.after(() => app.close());
  const allowed = await app.inject({
    method: 'OPTIONS', url: '/api/v1/',
    headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
  });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
  const denied = await app.inject({ url: '/api/v1/', headers: { origin: 'https://untrusted.example' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('unknown endpoints and internal errors return safe JSON with correlation IDs', async (t) => {
  const app = await buildApp(config);
  t.after(() => app.close());
  app.get('/test-error', async () => { throw new Error('sensitive query details'); });
  const missing = await app.inject('/api/v1/missing');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
  assert.equal(missing.json().requestId, missing.headers['x-request-id']);
  const failed = await app.inject('/test-error');
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(failed.body, /sensitive|stack/);
});
