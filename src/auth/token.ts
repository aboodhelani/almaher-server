import { createHmac, timingSafeEqual } from 'crypto';

/** Signs session tokens. Development default — set AUTH_SECRET before deploying. */
const secret = () => process.env.AUTH_SECRET ?? 'almaher-dev-secret';

/** Tokens last this long (90 days). */
const LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** `payload.signature`: payload is `{sub, exp}` as base64url JSON. */
export function signToken(userId: string, now = Date.now()): string {
  const payload = b64(JSON.stringify({ sub: userId, exp: now + LIFETIME_MS }));
  const sig = b64(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/** The user ID in a valid, unexpired token, else null. */
export function verifyToken(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: string;
      exp?: number;
    };
    return typeof sub === 'string' && typeof exp === 'number' && exp > now ? sub : null;
  } catch {
    return null;
  }
}
