import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config/env.js';

test('configuration rejects malformed flags, ports, origins and incomplete database setup', () => {
  for (const input of [
    { DB_ENABLED: 'yes' },
    { PORT: '0' },
    { PORT: '4000oops' },
    { DB_ENABLED: 'true', MYSQL_USER: '' },
    { CORS_ORIGINS: '*' },
    { CORS_ORIGINS: 'http://localhost:3000/path' },
    { MYSQL_SSL_CA: 'certificate.pem', MYSQL_SSL: 'false' },
  ]) assert.throws(() => loadConfig(input), /Invalid environment configuration/);
});

test('production requires database configuration and explicit HTTPS origins', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DB_ENABLED/);
  const config = loadConfig({
    NODE_ENV: 'production', DB_ENABLED: 'true', MYSQL_USER: 'app',
    MYSQL_PASSWORD: 'test-only', CORS_ORIGINS: 'https://portal.example',
  });
  assert.equal(config.DB_ENABLED, true);
  assert.deepEqual(config.CORS_ORIGINS, ['https://portal.example']);
});

test('configuration errors never include supplied secret values', () => {
  assert.throws(() => loadConfig({ MYSQL_PASSWORD: 'do-not-expose', PORT: 'invalid' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /do-not-expose/);
    return true;
  });
});
