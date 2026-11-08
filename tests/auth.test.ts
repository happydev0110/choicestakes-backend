import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { AuthError, publicPlayer, type AuthStore, type SessionRecord, type StoredPlayer } from '../src/modules/auth/types.js';
import { tokenHash } from '../src/modules/auth/routes.js';
import { verifyPassword } from '../src/modules/auth/password.js';

// Test double only. Production authentication always uses the MySQL repository.
class MemoryStore implements AuthStore {
  players = new Map<string, StoredPlayer>();
  sessions = new Map<string, SessionRecord & { seenAt: Date }>();
  attempts = new Map<string, number>();
  async findPlayerByEmail(email: string) { return this.players.get(email) ?? null; }
  async createPlayer(player: StoredPlayer, session: SessionRecord, previous?: string) {
    if (this.players.has(player.email)) throw new AuthError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Please log in.');
    this.players.set(player.email, player);
    await this.createSession(session, previous);
  }
  async createSession(session: SessionRecord, previous?: string) {
    if (previous) this.sessions.delete(previous);
    this.sessions.set(session.tokenHash, { ...session, seenAt: session.createdAt });
  }
  async findSession(hash: string, now: Date, idle: number) {
    const session = this.sessions.get(hash);
    const player = [...this.players.values()].find((value) => value.id === session?.playerId);
    if (!session || session.expiresAt <= now || session.seenAt.getTime() <= now.getTime() - idle * 60000 || !player || player.status !== 'active') return null;
    session.seenAt = now;
    return publicPlayer(player);
  }
  async deleteSession(hash: string) { this.sessions.delete(hash); }
  async consumeLoginAttempt(email: string) {
    const count = (this.attempts.get(email) ?? 0) + 1;
    this.attempts.set(email, count);
    return count <= 10;
  }
}

const origin = 'http://localhost:3000';
const headers = { origin, 'x-requested-with': 'choicestakes' };
const registration = { email: 'player@example.invalid', displayName: 'Test Player', password: 'A long test password 42!', confirmPassword: 'A long test password 42!', acceptTerms: true };
const cookieOf = (value: unknown) => String(value).split(';')[0]!;

test('registration, persisted session, login rotation and logout work without exposing credentials', async (t) => {
  const store = new MemoryStore();
  const app = await buildApp(loadConfig({ NODE_ENV: 'test' }), { authStore: store });
  t.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload: { ...registration, email: ' Player@Example.Invalid ' } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.player.email, registration.email);
  assert.equal(created.json().data.player.emailVerified, false);
  assert.equal(created.headers['cache-control'], 'no-store');
  assert.match(String(created.headers['set-cookie']), /HttpOnly/);
  assert.match(String(created.headers['set-cookie']), /SameSite=Lax/);
  assert.doesNotMatch(created.body, /password|token|scrypt/);
  const player = store.players.get(registration.email)!;
  assert.notEqual(player.passwordHash, registration.password);
  assert.equal(await verifyPassword(registration.password, player.passwordHash), true);
  const originalCookie = cookieOf(created.headers['set-cookie']);
  const rawToken = originalCookie.split('=')[1]!;
  assert.ok(store.sessions.has(tokenHash(rawToken)));
  assert.equal(store.sessions.has(rawToken), false);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: originalCookie } })).statusCode, 200);
  const duplicate = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload: registration });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(store.players.size, 1);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...headers, cookie: originalCookie }, payload: { email: registration.email, password: registration.password } });
  assert.equal(login.statusCode, 200);
  const cookie = cookieOf(login.headers['set-cookie']);
  assert.notEqual(cookie, originalCookie);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: originalCookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 200);
  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers, cookie }, payload: {} });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401);
  assert.equal(store.sessions.size, 0);
});

test('incorrect and unknown credentials have the same response; account attempts are throttled', async (t) => {
  const store = new MemoryStore();
  const app = await buildApp(loadConfig({ NODE_ENV: 'test' }), { authStore: store });
  t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload: registration });
  const login = (email: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email, password: 'incorrect password' } });
  const wrong = await login(registration.email);
  const missing = await login('unknown@example.invalid');
  assert.equal(wrong.statusCode, 401);
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(wrong.json().error, missing.json().error);
  store.attempts.set(registration.email, 10);
  const limited = await login(registration.email);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '900');
});

test('CSRF checks reject untrusted, missing and incomplete origin/header combinations', async (t) => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test' }), { authStore: new MemoryStore() });
  t.after(() => app.close());
  for (const invalid of [{}, { origin }, { 'x-requested-with': 'choicestakes' }, { ...headers, origin: 'https://attacker.invalid' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: invalid, payload: registration });
    assert.equal(response.statusCode, 403);
  }
});

test('registration validates password confirmation, consent, name and email on the server', async (t) => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test' }), { authStore: new MemoryStore() });
  t.after(() => app.close());
  for (const fields of [{ password: 'short' }, { confirmPassword: 'Another password 42!' }, { acceptTerms: false }, { email: 'invalid' }, { displayName: 'A' }, { role: 'admin' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload: { ...registration, ...fields } });
    assert.equal(response.statusCode, 400);
  }
});

test('expired, idle and disabled-player sessions are rejected', async (t) => {
  const store = new MemoryStore();
  const app = await buildApp(loadConfig({ NODE_ENV: 'test' }), { authStore: store });
  t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload: registration });
  const cookie = cookieOf(result.headers['set-cookie']);
  const session = [...store.sessions.values()][0]!;
  session.expiresAt = new Date(0);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401);
  session.expiresAt = new Date(Date.now() + 3600000);
  session.seenAt = new Date(0);
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401);
  session.seenAt = new Date();
  store.players.get(registration.email)!.status = 'disabled';
  assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode, 401);
});

test('production sessions use a Secure host-only cookie', async (t) => {
  const config = loadConfig({ NODE_ENV: 'production', DB_ENABLED: 'true', MYSQL_USER: 'test', MYSQL_PASSWORD: 'test-only', CORS_ORIGINS: 'https://portal.example' });
  const app = await buildApp(config, { database: { enabled: true, ping: async () => {}, close: async () => {} }, authStore: new MemoryStore() });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { ...headers, origin: 'https://portal.example' }, payload: registration });
  assert.equal(response.statusCode, 201);
  const cookie = String(response.headers['set-cookie']);
  assert.match(cookie, /^__Host-choicestakes_session=/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);
});

test('disabled MySQL returns a service error instead of creating an in-memory account', async (t) => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test' }));
  t.after(() => app.close());
  const result = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers, payload: registration });
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().error.code, 'AUTH_UNAVAILABLE');
});
