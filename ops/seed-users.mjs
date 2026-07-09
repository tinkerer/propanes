// Idempotent multi-user migration + seed.
// Env: DB_PATH, ADMIN_USER, ADMIN_PASS, MAKSYM_PASSWORD
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('/app/packages/server/');
const Database = require('better-sqlite3');
const ulid = () => randomUUID();

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const DB_PATH = process.env.DB_PATH || '/data/propanes.db';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const MAKSYM_PASSWORD = process.env.MAKSYM_PASSWORD || randomBytes(9).toString('base64url');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    nfs_share TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    launcher_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const now = new Date().toISOString();

let org = db.prepare('SELECT * FROM orgs WHERE name = ?').get('default');
if (!org) {
  const id = ulid();
  db.prepare('INSERT INTO orgs (id, name, nfs_share, created_at) VALUES (?,?,?,?)').run(
    id,
    'default',
    '/mnt/stage-nfs-src',
    now
  );
  org = { id, name: 'default' };
  console.log(`[org] created default org ${id}`);
} else {
  console.log(`[org] default org exists ${org.id}`);
}

function upsertUser({ username, password, role, launcherId }) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`[user] ${username} exists (${existing.role}) - left unchanged`);
    return existing;
  }
  const row = {
    id: ulid(),
    org_id: org.id,
    username,
    password_hash: hashPassword(password),
    role,
    status: 'active',
    launcher_id: launcherId || null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`INSERT INTO users
    (id, org_id, username, password_hash, role, status, launcher_id, created_at, updated_at)
    VALUES (@id, @org_id, @username, @password_hash, @role, @status, @launcher_id, @created_at, @updated_at)`)
    .run(row);
  console.log(`[user] created ${username} (${role})`);
  return row;
}

upsertUser({ username: ADMIN_USER, password: ADMIN_PASS, role: 'admin' });
upsertUser({ username: 'maksym', password: MAKSYM_PASSWORD, role: 'member', launcherId: 'agent-maksym' });

console.log('---');
console.log(`MAKSYM_PASSWORD=${MAKSYM_PASSWORD}`);
db.close();
