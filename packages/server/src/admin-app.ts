import { resolve as resolvePath } from 'node:path';
import { db, schema } from './db/index.js';

// The application row that represents this ProPanes deployment itself. The
// admin shell's feedback widget must file into it, so the match has to be
// tolerant: the row is created by hand (or seeded) with a name whose casing
// drifts ("ProPanes Admin" vs "Propanes Admin"), and in a container the server
// runs from a baked image dir (`/app`) while the row points at the checkout
// the agents work in (`/data/workspaces/propanes`).
const SELF_PROJECT_DIR = resolvePath(process.cwd(), '..', '..');
const ADMIN_NAME_RE = /^\s*pro\s*panes(\s+admin)?\s*$/i;
const ADMIN_DIR_RE = /\/propanes\/?$/i;

export type AdminAppCandidate = { name: string; projectDir: string };

export function isAdminApp(app: AdminAppCandidate): boolean {
  if (ADMIN_NAME_RE.test(app.name)) return true;
  const dir = app.projectDir.replace(/\/+$/, '');
  if (dir === SELF_PROJECT_DIR) return true;
  return ADMIN_DIR_RE.test(dir);
}

// Picks the admin application from `apps`. With no positive match the only
// safe fallback is the sole application of a single-app install; guessing
// among several silently files admin feedback into the wrong app.
export function pickAdminApp<T extends AdminAppCandidate>(apps: T[]): T | null {
  const byDir = apps.find((a) => a.projectDir.replace(/\/+$/, '') === SELF_PROJECT_DIR);
  if (byDir) return byDir;
  const match = apps.find(isAdminApp);
  if (match) return match;
  return apps.length === 1 ? apps[0] : null;
}

export function resolveAdminApp(): { id: string; apiKey: string } | null {
  const apps = db
    .select({
      id: schema.applications.id,
      name: schema.applications.name,
      apiKey: schema.applications.apiKey,
      projectDir: schema.applications.projectDir,
    })
    .from(schema.applications)
    .all();
  const app = pickAdminApp(apps);
  return app ? { id: app.id, apiKey: app.apiKey } : null;
}
