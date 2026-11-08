import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.js';
import { AuthError, publicPlayer, type AuthStore, type Player, type SessionRecord, type StoredPlayer } from './types.js';

const email = z.string().trim().toLowerCase().max(254).email();
const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
const registerSchema = z.object({
  email,
  displayName: z.string().trim().min(2).max(30).regex(/^[^\u0000-\u001f\u007f]+$/),
  password: z.string().min(12).max(128),
  confirmPassword: z.string().min(12).max(128),
  acceptTerms: z.literal(true),
}).strict().refine((data) => data.password === data.confirmPassword, { message: 'Passwords must match.' });

export function sessionCookieName(config: Config) {
  return config.NODE_ENV === 'production' ? '__Host-choicestakes_session' : 'choicestakes_session';
}
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

export async function registerAuthRoutes(app: FastifyInstance, config: Config, store: AuthStore) {
  const cookieName = sessionCookieName(config);
  const cookieOptions = { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
  const readToken = (request: FastifyRequest) => {
    const token = request.cookies[cookieName];
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  };
  const newSession = (playerId: string) => {
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const record: SessionRecord = { tokenHash: tokenHash(token), playerId, createdAt,
      expiresAt: new Date(createdAt.getTime() + config.SESSION_TTL_HOURS * 3600000) };
    return { token, record };
  };
  const signedIn = (reply: FastifyReply, player: Player, session: ReturnType<typeof newSession>, status = 200) => {
    reply.setCookie(cookieName, session.token, { ...cookieOptions, maxAge: config.SESSION_TTL_HOURS * 3600 });
    return reply.code(status).send({ success: true, data: { player } });
  };

  await app.register(async (auth) => {
    auth.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.method === 'POST') {
        // Origin check plus a custom header protects both authenticated and login/register requests from CSRF.
        if (!config.CORS_ORIGINS.includes(request.headers.origin ?? '') || request.headers['x-requested-with'] !== 'choicestakes') {
          throw new AuthError(403, 'ORIGIN_NOT_ALLOWED', 'This request is not allowed. Reload the page and try again.');
        }
      }
    });

    auth.post('/register', { bodyLimit: 8192, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) throw new AuthError(400, 'INVALID_REGISTRATION', 'Enter a valid name and email, use a password of 12–128 characters, confirm it, and accept the age and terms declaration.');
      const input = parsed.data;
      // Check database readiness before spending resources hashing a password.
      if (await store.findPlayerByEmail(input.email)) throw new AuthError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Please log in.');
      const player: StoredPlayer = { id: randomUUID(), email: input.email, displayName: input.displayName,
        passwordHash: await hashPassword(input.password), emailVerified: false, status: 'active' };
      const session = newSession(player.id);
      const previous = readToken(request);
      await store.createPlayer(player, session.record, previous ? tokenHash(previous) : undefined);
      return signedIn(reply, publicPlayer(player), session, 201);
    });

    auth.post('/login', { bodyLimit: 8192, config: { rateLimit: { max: 100, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) throw new AuthError(400, 'INVALID_LOGIN', 'Enter your email address and password.');
      if (!await store.consumeLoginAttempt(parsed.data.email)) {
        reply.header('Retry-After', '900');
        throw new AuthError(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts. Please try again in 15 minutes.');
      }
      const player = await store.findPlayerByEmail(parsed.data.email);
      const valid = await verifyPassword(parsed.data.password, player?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!valid || !player || player.status !== 'active') throw new AuthError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      const session = newSession(player.id);
      const previous = readToken(request);
      await store.createSession(session.record, previous ? tokenHash(previous) : undefined);
      return signedIn(reply, publicPlayer(player), session);
    });

    auth.get('/me', async (request, reply) => {
      const token = readToken(request);
      const player = token ? await store.findSession(tokenHash(token), new Date(), config.SESSION_IDLE_MINUTES) : null;
      if (!player) {
        reply.clearCookie(cookieName, cookieOptions);
        throw new AuthError(401, 'UNAUTHENTICATED', 'Please log in to continue.');
      }
      return { success: true, data: { player } };
    });

    auth.post('/logout', { config: { rateLimit: { max: 100, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const token = readToken(request);
      if (token) await store.deleteSession(tokenHash(token));
      reply.clearCookie(cookieName, cookieOptions);
      return { success: true, data: { loggedOut: true } };
    });
  }, { prefix: '/api/v1/auth' });
}
