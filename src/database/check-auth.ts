import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { loadConfig } from '../config/env.js';
import { createDatabase } from './mysql.js';
import { createAuthStore } from '../modules/auth/store.js';

async function main() {
  const config = loadConfig();
  if (!config.DB_ENABLED || config.NODE_ENV === 'production') {
    throw new Error('Use an enabled, migrated development MySQL database for this check.');
  }
  const database = createDatabase(config);
  const store = createAuthStore(database);
  const app = await buildApp({ ...config, NODE_ENV: 'test' }, { database, authStore: store });
  const secondApp = await buildApp({ ...config, NODE_ENV: 'test' });
  const email = `auth-check-${randomUUID()}@example.invalid`;
  const password = randomUUID() + '!';
  const headers = { origin: config.CORS_ORIGINS[0]!, 'x-requested-with': 'choicestakes' };
  const payload = { email, password, confirmPassword: password, displayName: 'Auth check', acceptTerms: true };
  const cookieOf = (value: unknown) => String(value).split(';')[0]!;
  try {
    // Two requests also exercise MySQL's unique constraint and transaction rollback.
    const registrations = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload })));
    assert.deepEqual(registrations.map((response) => response.statusCode).sort(), [201, 409]);
    const created = registrations.find((response) => response.statusCode === 201)!;
    const originalCookie = cookieOf(created.headers['set-cookie']);
    const persisted = await store.findPlayerByEmail(email);
    assert.ok(persisted);
    assert.match(persisted.passwordHash, /^scrypt\$/);
    assert.notEqual(persisted.passwordHash, password);
    assert.doesNotMatch(created.body, /password|token|scrypt/);
    const restored = await secondApp.inject({ url: '/api/v1/auth/me', headers: { cookie: originalCookie } });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().data.player.id, persisted.id);
    const incorrect = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email, password: 'incorrect password' } });
    assert.equal(incorrect.statusCode, 401);
    const login = await secondApp.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...headers, cookie: originalCookie }, payload: { email, password } });
    assert.equal(login.statusCode, 200);
    const cookie = cookieOf(login.headers['set-cookie']);
    assert.notEqual(cookie, originalCookie);
    assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: originalCookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers, cookie }, payload: {} })).statusCode, 200);
    assert.equal((await secondApp.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401);
    console.log('PASS: MySQL registration, duplicate protection, hashed password storage, cross-instance session persistence, login rotation and logout.');
  } finally {
    try {
      await database.transaction(async (connection) => {
        // Remove only this run's synthetic account and throttle entry; sessions cascade.
        await connection.execute('DELETE FROM players WHERE email = ?', [email]);
        await connection.execute('DELETE FROM player_auth_attempts WHERE attempt_key = ?', [createHash('sha256').update(`login:${email}`).digest('hex')]);
      });
    } finally {
      await Promise.all([app.close(), secondApp.close()]);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Authentication database check failed.');
  process.exitCode = 1;
});
