import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getAdminUser, isGlobalAdmin, visibleToMember } from '../../admin-auth.js';
import { createDevRoute, deleteDevRoute, devRouteConfig, portListening, type DevRoute } from '../../dev-routes.js';

// Public URLs for users' dev servers. Anyone may reserve one for themselves
// (agents do it with their session's PROPANES_TOKEN); the global admin sees all.
export const devRouteRoutes = new Hono();

async function view(r: DevRoute) {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    appId: r.appId,
    name: r.name,
    host: r.host,
    url: `https://${r.host}`,
    port: r.port,
    status: r.status,
    error: r.error,
    listening: await portListening(r.port),
    createdAt: r.createdAt,
  };
}

devRouteRoutes.get('/dev-routes', async (c) => {
  const user = getAdminUser(c);
  const appId = c.req.query('appId');
  const rows = db.select().from(schema.devRoutes).all()
    .filter((r) => isGlobalAdmin(user) || r.ownerUserId === user.id)
    .filter((r) => !appId || r.appId === appId);
  return c.json({ enabled: !!devRouteConfig().domain, routes: await Promise.all(rows.map(view)) });
});

// Reserve (or return the existing) dev URL named `name` for the caller. With an
// appId and no name, the app's name is used, so one call per app is idempotent.
devRouteRoutes.post('/dev-routes', async (c) => {
  const user = getAdminUser(c);
  const body = await c.req.json().catch(() => ({})) as { appId?: string; name?: string };
  let appName: string | undefined;
  if (body.appId) {
    const app = db.select().from(schema.applications).where(eq(schema.applications.id, body.appId)).get();
    if (!app || !visibleToMember(app, user)) return c.json({ error: 'Application not found' }, 404);
    appName = app.name;
  }
  const name = (body.name || appName || '').trim();
  if (!name) return c.json({ error: 'Give a name or an appId' }, 400);
  try {
    const { route, created } = await createDevRoute(devRouteConfig(), {
      ownerUserId: user.id, username: user.username || user.id, name, appId: body.appId ?? null,
    });
    return c.json({ route: await view(route), created }, created ? 201 : 200);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not create the dev URL' }, 400);
  }
});

devRouteRoutes.delete('/dev-routes/:id', async (c) => {
  const user = getAdminUser(c);
  const route = db.select().from(schema.devRoutes).where(eq(schema.devRoutes.id, c.req.param('id'))).get();
  if (!route || !(isGlobalAdmin(user) || route.ownerUserId === user.id)) return c.json({ error: 'Not found' }, 404);
  await deleteDevRoute(devRouteConfig(), route);
  return c.json({ ok: true });
});
