import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { loginSchema, changePasswordSchema } from '@propanes/shared';
import { JWT_SECRET, verifyAdminToken } from '../auth.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
let adminPass = process.env.ADMIN_PASS || 'admin';

export const authRoutes = new Hono();

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { username, password } = parsed.data;
  if (username !== ADMIN_USER || password !== adminPass) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const token = await new SignJWT({ sub: username, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(JWT_SECRET);

  return c.json({ token, expiresAt: expiresAt.toISOString() });
});

authRoutes.post('/change-password', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token || !(await verifyAdminToken(token))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { currentPassword, newPassword } = parsed.data;
  if (currentPassword !== adminPass) {
    return c.json({ error: 'Current password is incorrect' }, 403);
  }

  adminPass = newPassword;
  return c.json({ ok: true });
});
