import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { loginSchema } from '@prompt-widget/shared';
import { JWT_SECRET } from '../auth.js';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

export const authRoutes = new Hono();

authRoutes.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { username, password } = parsed.data;
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
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
