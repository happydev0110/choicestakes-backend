import { z } from 'zod';
import { validApiMaticKey, validApiMaticSecret } from './apimatic-credentials.js';

const boolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const port = z.coerce.number().int().min(1).max(65535);
const origins = z.string().transform((value) => value.split(',').map((origin) => origin.trim()))
  .pipe(z.array(z.string().refine((origin) => {
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
    } catch {
      return false;
    }
  }, 'Use an exact http(s) origin without a path or trailing slash')).min(1));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: port.default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: origins.default([
    'http://localhost:3000', 'http://127.0.0.1:3000', 'http://198.18.1.255:3000',
  ]),
  DB_ENABLED: boolean.default(false),
  MYSQL_HOST: z.string().trim().min(1).default('127.0.0.1'),
  MYSQL_PORT: port.default(3306),
  MYSQL_DATABASE: z.string().trim().min(1).default('choicestacks_sandbox'),
  MYSQL_USER: z.string().trim().default(''),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  MYSQL_SSL: boolean.default(false),
  MYSQL_SSL_CA: z.string().trim().default(''),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  APIMATIC_ENABLED: boolean.default(false),
  APIMATIC_API_KEY: z.string().trim().default(''),
  APIMATIC_SECRET_KEY: z.string().default(''),
  APIMATIC_CALLBACK_URL: z.string().default(''),
  APIMATIC_CURRENCY: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/).default('EUR'),
  APIMATIC_CURRENCY_DECIMALS: z.coerce.number().int().min(2).max(3).default(2),
  APIMATIC_TEST_CREDITS: z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/).default('1000'),
}).superRefine((env, ctx) => {
  if (env.APIMATIC_ENABLED) {
    if (!env.DB_ENABLED) ctx.addIssue({ code: 'custom', path: ['APIMATIC_ENABLED'], message: 'Requires DB_ENABLED=true' });
    if (!validApiMaticKey(env.APIMATIC_API_KEY)) ctx.addIssue({ code: 'custom', path: ['APIMATIC_API_KEY'], message: 'Requires the API key from your sandbox credentials, without embedded whitespace or control characters' });
    if (!validApiMaticSecret(env.APIMATIC_SECRET_KEY)) ctx.addIssue({ code: 'custom', path: ['APIMATIC_SECRET_KEY'], message: 'Requires a 64-character hexadecimal sandbox secret' });
    try {
      const callback = new URL(env.APIMATIC_CALLBACK_URL);
      if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/api/v1/provider/apimatic/sandbox') throw new Error();
    } catch { ctx.addIssue({ code: 'custom', path: ['APIMATIC_CALLBACK_URL'], message: 'Use https://your-api-domain/api/v1/provider/apimatic/sandbox without query parameters' }); }
    if ((env.APIMATIC_TEST_CREDITS.split('.')[1]?.length ?? 0) > env.APIMATIC_CURRENCY_DECIMALS) ctx.addIssue({ code: 'custom', path: ['APIMATIC_TEST_CREDITS'], message: 'Too many decimals for the configured currency' });
  }
  if (env.DB_ENABLED && !env.MYSQL_USER) {
    ctx.addIssue({ code: 'custom', path: ['MYSQL_USER'], message: 'Required when DB_ENABLED=true' });
  }
  if (env.MYSQL_SSL_CA && !env.MYSQL_SSL) {
    ctx.addIssue({ code: 'custom', path: ['MYSQL_SSL_CA'], message: 'Requires MYSQL_SSL=true' });
  }
  if (env.NODE_ENV === 'production') {
    if (!env.DB_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['DB_ENABLED'], message: 'Must be true in production' });
    }
    if (!env.MYSQL_PASSWORD) {
      ctx.addIssue({ code: 'custom', path: ['MYSQL_PASSWORD'], message: 'Required in production' });
    }
    if (env.CORS_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Use HTTPS origins in production' });
    }
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Report field names and rules, never environment values or passwords.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
