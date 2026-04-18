import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../db/index.js';
import { createSprite, getSprite, deleteSprite } from '../sprite-client.js';
import { countActiveSpriteSessions } from '../sprite-sessions.js';
import { dispatchDirectSpriteSession } from '../dispatch.js';
import type { PermissionProfile } from '@propanes/shared';

const app = new Hono();

app.get('/', (c) => {
  const appId = c.req.query('appId');
  let rows;
  if (appId) {
    rows = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.appId, appId)).all();
  } else {
    rows = db.select().from(schema.spriteConfigs).all();
  }
  return c.json(rows.map(r => ({
    ...r,
    activeSessions: countActiveSpriteSessions(r.id),
  })));
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = ulid();

  const provisionNow = body.provisionNow !== false;

  db.insert(schema.spriteConfigs)
    .values({
      id,
      name: body.name || 'Unnamed Sprite',
      spriteName: body.spriteName || body.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || `sprite-${id.slice(-6).toLowerCase()}`,
      token: body.token || null,
      status: 'unknown',
      maxSessions: body.maxSessions || 3,
      defaultCwd: body.defaultCwd || null,
      appId: body.appId || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const row = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get()!;

  if (provisionNow) {
    try {
      const info = await createSprite(row.spriteName, row.token);
      db.update(schema.spriteConfigs)
        .set({
          status: info.status || 'cold',
          spriteId: info.id,
          spriteUrl: info.url || null,
          lastCheckedAt: now,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.spriteConfigs.id, id))
        .run();
    } catch (err: any) {
      db.update(schema.spriteConfigs)
        .set({ status: 'error', errorMessage: err.message, updatedAt: now })
        .where(eq(schema.spriteConfigs.id, id))
        .run();
    }
  }

  const final = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get()!;
  return c.json({ ...final, activeSessions: 0 }, 201);
});

app.get('/:id', (c) => {
  const row = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, c.req.param('id'))).get();
  if (!row) return c.json({ error: 'Sprite config not found' }, 404);
  return c.json({ ...row, activeSessions: countActiveSpriteSessions(row.id) });
});

app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Sprite config not found' }, 404);

  const body = await c.req.json();
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };

  if (body.name !== undefined) updates.name = body.name;
  if (body.spriteName !== undefined) updates.spriteName = body.spriteName;
  if (body.token !== undefined) updates.token = body.token || null;
  if (body.maxSessions !== undefined) updates.maxSessions = body.maxSessions;
  if (body.defaultCwd !== undefined) updates.defaultCwd = body.defaultCwd || null;
  if (body.appId !== undefined) updates.appId = body.appId || null;

  db.update(schema.spriteConfigs).set(updates).where(eq(schema.spriteConfigs.id, id)).run();
  const row = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get()!;
  return c.json({ ...row, activeSessions: countActiveSpriteSessions(row.id) });
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const existing = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get();
  if (!existing) return c.json({ error: 'Sprite config not found' }, 404);

  db.delete(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).run();
  return c.json({ ok: true, id });
});

app.post('/:id/provision', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Sprite config not found' }, 404);

  const now = new Date().toISOString();
  try {
    const info = await createSprite(config.spriteName, config.token);
    db.update(schema.spriteConfigs)
      .set({
        status: info.status || 'cold',
        spriteId: info.id,
        spriteUrl: info.url || null,
        lastCheckedAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.spriteConfigs.id, id))
      .run();
    return c.json({ ok: true, status: info.status, spriteId: info.id });
  } catch (err: any) {
    db.update(schema.spriteConfigs)
      .set({ status: 'error', errorMessage: err.message, updatedAt: now })
      .where(eq(schema.spriteConfigs.id, id))
      .run();
    return c.json({ error: err.message }, 500);
  }
});

app.post('/:id/destroy', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Sprite config not found' }, 404);

  const now = new Date().toISOString();
  try {
    await deleteSprite(config.spriteName, config.token);
    db.update(schema.spriteConfigs)
      .set({
        status: 'destroyed',
        spriteId: null,
        spriteUrl: null,
        lastCheckedAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.spriteConfigs.id, id))
      .run();
    return c.json({ ok: true, status: 'destroyed' });
  } catch (err: any) {
    db.update(schema.spriteConfigs)
      .set({ errorMessage: err.message, updatedAt: now })
      .where(eq(schema.spriteConfigs.id, id))
      .run();
    return c.json({ error: err.message }, 500);
  }
});

app.post('/:id/status', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Sprite config not found' }, 404);

  const now = new Date().toISOString();
  try {
    const info = await getSprite(config.spriteName, config.token);
    db.update(schema.spriteConfigs)
      .set({
        status: info.status || 'unknown',
        spriteId: info.id || config.spriteId,
        spriteUrl: info.url || config.spriteUrl,
        lastCheckedAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.spriteConfigs.id, id))
      .run();
    return c.json({ ok: true, status: info.status, spriteId: info.id });
  } catch (err: any) {
    db.update(schema.spriteConfigs)
      .set({ status: 'error', errorMessage: err.message, lastCheckedAt: now, updatedAt: now })
      .where(eq(schema.spriteConfigs.id, id))
      .run();
    return c.json({ error: err.message }, 500);
  }
});

app.post('/:id/session', async (c) => {
  const id = c.req.param('id');
  const config = db.select().from(schema.spriteConfigs).where(eq(schema.spriteConfigs.id, id)).get();
  if (!config) return c.json({ error: 'Sprite config not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const prompt = body.prompt || 'You are running inside a Fly.io Sprite. Await instructions.';
  const permissionProfile = (body.permissionProfile || 'interactive') as PermissionProfile;

  try {
    const { sessionId } = await dispatchDirectSpriteSession({
      spriteConfigId: id,
      prompt,
      permissionProfile,
    });
    return c.json({ ok: true, sessionId });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
