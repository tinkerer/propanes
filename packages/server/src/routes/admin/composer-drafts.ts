// Generic key-based composer drafts. Used by UnifiedComposer to autosave
// textarea state across reloads. Reuses the existing cos_drafts table by
// stashing the draft key in the agentId column (with sentinel appId='' and
// threadId='') so the per-(agent,app,thread) CoS draft semantics from
// cos-thread-routes.ts are unaffected — those rows always carry a real
// ULID-shaped agentId, never a draft-key string.
//
// Body shape: { text: string, attachmentsJson?: string }. Empty `text`
// (and no attachmentsJson) deletes the row. The attachmentsJson column
// piggy-backs on `text` since the schema only has one payload column —
// callers serialize { text, attachmentsJson } into the row text and parse
// it back on GET. This keeps the migration story zero-cost; if we ever
// want a structured column we can add one without changing the route.

import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { ulid } from 'ulidx';
import { db, schema } from '../../db/index.js';

export const composerDraftsRoutes = new Hono();

const SENTINEL_APP_ID = '';
const SENTINEL_THREAD_ID = '';

type DraftPayload = { text: string; attachmentsJson?: string };

function encodePayload(p: DraftPayload): string {
  // Wrap so we can roundtrip attachmentsJson through the single text column
  // without colliding with raw text drafts. The marker prefix lets us detect
  // legacy plain-text rows (none today, but harmless future-proofing).
  return JSON.stringify({ v: 1, ...p });
}

function decodePayload(stored: string): DraftPayload {
  if (!stored) return { text: '' };
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object' && parsed.v === 1) {
      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        attachmentsJson:
          typeof parsed.attachmentsJson === 'string' ? parsed.attachmentsJson : undefined,
      };
    }
  } catch {
    /* not JSON — fall through to legacy plain-text handling */
  }
  return { text: stored };
}

function scopeFor(key: string) {
  return and(
    eq(schema.cosDrafts.agentId, key),
    eq(schema.cosDrafts.appId, SENTINEL_APP_ID),
    eq(schema.cosDrafts.threadId, SENTINEL_THREAD_ID),
  );
}

composerDraftsRoutes.get('/drafts/:key', async (c) => {
  const key = c.req.param('key');
  if (!key) return c.json({ error: 'key is required' }, 400);
  const rows = await db.select().from(schema.cosDrafts).where(scopeFor(key)).limit(1);
  if (rows.length === 0) return c.json({ key, text: '', attachmentsJson: null, exists: false });
  const payload = decodePayload(rows[0].text);
  return c.json({
    key,
    text: payload.text,
    attachmentsJson: payload.attachmentsJson ?? null,
    exists: true,
    updatedAt: rows[0].updatedAt,
  });
});

composerDraftsRoutes.put('/drafts/:key', async (c) => {
  const key = c.req.param('key');
  if (!key) return c.json({ error: 'key is required' }, 400);
  let body: DraftPayload;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const attachmentsJson =
    typeof body.attachmentsJson === 'string' ? body.attachmentsJson : undefined;
  const isEmpty = text.length === 0 && !attachmentsJson;
  const now = Date.now();
  const scope = scopeFor(key);

  if (isEmpty) {
    await db.delete(schema.cosDrafts).where(scope);
    return c.json({ ok: true, cleared: true });
  }

  const stored = encodePayload({ text, attachmentsJson });
  const existing = await db.select().from(schema.cosDrafts).where(scope).limit(1);
  if (existing.length > 0) {
    await db.update(schema.cosDrafts).set({ text: stored, updatedAt: now }).where(scope);
  } else {
    await db.insert(schema.cosDrafts).values({
      id: ulid(),
      agentId: key,
      appId: SENTINEL_APP_ID,
      threadId: SENTINEL_THREAD_ID,
      text: stored,
      updatedAt: now,
    });
  }
  return c.json({ ok: true, key, text, attachmentsJson: attachmentsJson ?? null, updatedAt: now });
});

composerDraftsRoutes.delete('/drafts/:key', async (c) => {
  const key = c.req.param('key');
  if (!key) return c.json({ error: 'key is required' }, 400);
  await db.delete(schema.cosDrafts).where(scopeFor(key));
  return c.json({ ok: true, cleared: true });
});
