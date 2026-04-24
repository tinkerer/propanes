import { watch, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Watches packages/admin/src and rebuilds the admin bundle when files change,
// so the server (which serves from packages/admin/dist) never gets stuck on a
// stale bundle after agents edit source files. Opt-in via ADMIN_WATCH=1 —
// off in production by default.

const ADMIN_DIR = resolve(process.cwd(), '../admin');
const ADMIN_SRC = resolve(ADMIN_DIR, 'src');
const DEBOUNCE_MS = 800;

let debounceTimer: NodeJS.Timeout | null = null;
let building = false;
let dirty = false;

function runBuild() {
  if (building) {
    dirty = true;
    return;
  }
  building = true;
  const start = Date.now();
  console.log('[admin-watch] Rebuilding admin bundle…');
  const child = spawn('npx', ['vite', 'build'], {
    cwd: ADMIN_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stderr = '';
  child.stdout?.on('data', () => { /* discard: keep log quiet on success */ });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    const ms = Date.now() - start;
    building = false;
    if (code === 0) {
      console.log(`[admin-watch] Rebuild done in ${ms}ms`);
    } else {
      console.error(`[admin-watch] Build failed (exit ${code}) after ${ms}ms`);
      if (stderr) console.error(stderr.slice(-2000));
    }
    if (dirty) {
      dirty = false;
      scheduleBuild();
    }
  });
  child.on('error', (err) => {
    building = false;
    console.error('[admin-watch] Failed to spawn vite build:', err);
  });
}

function scheduleBuild() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runBuild, DEBOUNCE_MS);
}

export function startAdminWatcher(): void {
  if (!existsSync(ADMIN_SRC)) {
    console.warn(`[admin-watch] ${ADMIN_SRC} not found — watcher disabled`);
    return;
  }
  try {
    watch(ADMIN_SRC, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return;
      // Skip dotfiles, editor swap files, and transient vite artifacts
      const name = filename.toString();
      if (name.startsWith('.') || name.includes('/.') || name.endsWith('~')) return;
      scheduleBuild();
    });
    console.log(`[admin-watch] Watching ${ADMIN_SRC} — rebuilds on change`);
  } catch (err) {
    console.error('[admin-watch] Failed to start watcher:', err);
  }
}
