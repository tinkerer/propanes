import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'dev-secret-change-me'
);

// Mint a bearer token for a user without a password exchange. Used to hand
// agent sessions a credential scoped to their owner (PROPANES_TOKEN in the
// session environment / per-user pod env) — the same shape /auth/login issues,
// so requireAdminAuth and the org scoping treat it identically.
export async function mintUserToken(
  user: { id: string; username: string; role: string; orgId?: string | null },
  ttlDays = 365,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: user.id,
    username: user.username,
    role: user.role,
    orgId: user.orgId ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlDays * 24 * 60 * 60)
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(password), salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
