import { Hono } from 'hono';
import { SignJWT, type JWTPayload } from 'jose';
import { eq } from 'drizzle-orm';
import { changePasswordSchema, loginSchema } from '@propanes/shared';
import { hashPassword, JWT_SECRET, verifyPassword, verifyToken } from '../auth.js';
import { db, schema } from '../db/index.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let envAdminPass = process.env.ADMIN_PASS || 'admin';

export const authRoutes = new Hono();

async function signToken(payload: JWTPayload) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(JWT_SECRET);
  return { token, expiresAt };
}

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { username, password } = parsed.data;

  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .get();
  if (user) {
    if (user.status !== 'active') {
      return c.json({ error: 'Account disabled' }, 403);
    }
    if (!verifyPassword(password, user.passwordHash)) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const { token, expiresAt } = await signToken({
      sub: user.id,
      username: user.username,
      role: user.role,
      orgId: user.orgId ?? null,
    });
    return c.json({
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, username: user.username, role: user.role, orgId: user.orgId ?? null },
    });
  }

  if (username === ADMIN_USER && password === envAdminPass) {
    const { token, expiresAt } = await signToken({
      sub: 'env-admin',
      username,
      role: 'admin',
      orgId: null,
    });
    return c.json({
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: 'env-admin', username, role: 'admin', orgId: null },
    });
  }

  return c.json({ error: 'Invalid credentials' }, 401);
});

authRoutes.get('/me', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const payload = token ? await verifyToken(token) : null;
  if (!payload) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({
    user: {
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      orgId: (payload as { orgId?: string | null }).orgId ?? null,
    },
  });
});

authRoutes.post('/change-password', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const payload = token ? await verifyToken(token) : null;
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { currentPassword, newPassword } = parsed.data;

  if (payload.sub === 'env-admin') {
    if (currentPassword !== envAdminPass) {
      return c.json({ error: 'Current password is incorrect' }, 403);
    }
    envAdminPass = newPassword;
    return c.json({ ok: true });
  }

  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, String(payload.sub)))
    .get();
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return c.json({ error: 'Current password is incorrect' }, 403);
  }
  db.update(schema.users)
    .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() })
    .where(eq(schema.users.id, user.id))
    .run();
  return c.json({ ok: true });
});
