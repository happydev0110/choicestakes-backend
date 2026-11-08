import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AuthError } from './types.js';

// OWASP scrypt option: 64 MiB, r=8, p=2. Limit concurrent memory-intensive jobs.
const N = 65536;
const r = 8;
const p = 2;
let active = 0;
export const DUMMY_PASSWORD_HASH = `scrypt$${N}$${r}$${p}$${'01'.repeat(16)}$${'02'.repeat(32)}`;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= 4) throw new AuthError(503, 'AUTH_BUSY', 'Sign-in is busy. Please try again shortly.');
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N, r, p, maxmem: 80 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error); else resolve(key);
      });
    });
  } finally { active--; }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const match = /^scrypt\$65536\$8\$2\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
  if (!match?.[1] || !match[2]) return false;
  const key = await derive(password, Buffer.from(match[1], 'hex'));
  return timingSafeEqual(key, Buffer.from(match[2], 'hex'));
}
