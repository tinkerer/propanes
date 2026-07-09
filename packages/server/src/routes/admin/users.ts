import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { hashPassword, verifyAdminToken } from '../../auth.js';
import { db, schema } from '../../db/index.js';
import {
  isProvisioningAvailable,
  provisionUserPod,
  deprovisionUserPod,
  getUserPodStatus,
  launcherIdFor,
} from '../../k8s-provision.js';

export const userRoutes = new Hono();

async function requireAdmin(c: Context): Promise<boolean> {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  return !!token && (await verifyAdminToken(token));
}

function publicUser(u: typeof schema.users.$inferSelect) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    orgId: u.orgId ?? null,
    launcherId: u.launcherId ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

userRoutes.get('/users', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const rows = db.select().from(schema.users).all();
  return c.json({ users: rows.map(publicUser) });
});

userRoutes.post('/users', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const role = body.role === 'admin' ? 'admin' : 'member';
  const orgId = typeof body.orgId === 'string' ? body.orgId : null;
  const launcherId = typeof body.launcherId === 'string' ? body.launcherId : null;
  if (!username || password.length < 6) {
    return c.json({ error: 'username required and password must be at least 6 characters' }, 400);
  }
  const existing = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .get();
  if (existing) return c.json({ error: 'Username already exists' }, 409);
  const now = new Date().toISOString();
  const row = {
    id: ulid(),
    orgId,
    username,
    passwordHash: hashPassword(password),
    role,
    status: 'active',
    launcherId,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.users).values(row).run();
  return c.json({ user: publicUser(row as typeof schema.users.$inferSelect) }, 201);
});

userRoutes.post('/users/:id/reset-password', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (newPassword.length < 6) {
    return c.json({ error: 'newPassword must be at least 6 characters' }, 400);
  }
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);
  db.update(schema.users)
    .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() })
    .where(eq(schema.users.id, id))
    .run();
  return c.json({ ok: true });
});

userRoutes.patch('/users/:id', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.role === 'admin' || body.role === 'member') patch.role = body.role;
  if (body.status === 'active' || body.status === 'disabled') patch.status = body.status;
  if (typeof body.launcherId === 'string' || body.launcherId === null) {
    patch.launcherId = body.launcherId;
  }
  if (typeof body.orgId === 'string' || body.orgId === null) patch.orgId = body.orgId;
  db.update(schema.users).set(patch).where(eq(schema.users.id, id)).run();
  const updated = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
  return c.json({ user: publicUser(updated) });
});

userRoutes.delete('/users/:id', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  db.delete(schema.users).where(eq(schema.users.id, id)).run();
  return c.json({ ok: true });
});

// --- Phase 4: self-service per-user pod provisioning (Kubernetes) ---

function orgLabelFor(orgId: string | null): string | null {
  if (!orgId) return null;
  const org = db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId)).get();
  return org?.name ?? null;
}

userRoutes.post('/users/:id/provision', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  if (!isProvisioningAvailable()) {
    return c.json(
      { error: 'Kubernetes provisioning unavailable (server is not running in-cluster with a ServiceAccount)' },
      501,
    );
  }
  const id = c.req.param('id');
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const result = await provisionUserPod(user.username, { org: orgLabelFor(user.orgId) });
  if (result.ok) {
    // Route this user's sessions to their own launcher.
    db.update(schema.users)
      .set({ launcherId: result.launcherId, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, id))
      .run();
  }
  return c.json(result, result.ok ? 200 : 502);
});

userRoutes.post('/users/:id/deprovision', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  if (!isProvisioningAvailable()) {
    return c.json({ error: 'Kubernetes provisioning unavailable' }, 501);
  }
  const id = c.req.param('id');
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const result = await deprovisionUserPod(user.username, { deletePvc: body.deletePvc === true });
  if (result.ok && user.launcherId === launcherIdFor(user.username)) {
    db.update(schema.users)
      .set({ launcherId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, id))
      .run();
  }
  return c.json(result, result.ok ? 200 : 502);
});

userRoutes.get('/users/:id/pod-status', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);
  if (!isProvisioningAvailable()) {
    return c.json({ available: false, exists: false, replicas: 0, readyReplicas: 0, launcherId: launcherIdFor(user.username) });
  }
  const status = await getUserPodStatus(user.username);
  return c.json(status);
});

userRoutes.get('/orgs', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const rows = db.select().from(schema.orgs).all();
  return c.json({ orgs: rows });
});

userRoutes.post('/orgs', async (c) => {
  if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name required' }, 400);
  const row = {
    id: ulid(),
    name,
    nfsShare: typeof body.nfsShare === 'string' ? body.nfsShare : null,
    createdAt: new Date().toISOString(),
  };
  db.insert(schema.orgs).values(row).run();
  return c.json({ org: row }, 201);
});
