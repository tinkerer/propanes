/**
 * One-time migration:
 *  1. Move "screenshot-only" feedback items (no description, has screenshots attached)
 *     into the standalone `screenshots` table, then delete those feedback items.
 *  2. Relabel existing FAFO worker feedback items from `type: 'manual'` to `type: 'fafo_worker'`.
 *
 * Idempotent: running again finds no matching rows.
 *
 * Run: `npx tsx src/scripts/migrate-screenshots-and-fafo.ts`
 */

import { db, schema, sqlite } from '../db/index.js';
import { eq } from 'drizzle-orm';

function migrateScreenshotOnlyFeedback() {
  // Find feedback items with empty description + no audio + no tags + has screenshots
  const rows = sqlite.prepare(`
    SELECT fi.id, fi.app_id, fi.session_id, fi.user_id, fi.source_url, fi.created_at
    FROM feedback_items fi
    WHERE (fi.description = '' OR fi.description IS NULL)
      AND NOT EXISTS (SELECT 1 FROM feedback_audio fa WHERE fa.feedback_id = fi.id)
      AND NOT EXISTS (SELECT 1 FROM feedback_tags ft WHERE ft.feedback_id = fi.id)
      AND EXISTS (SELECT 1 FROM feedback_screenshots fs WHERE fs.feedback_id = fi.id)
      AND (fi.data IS NULL OR fi.data = '' OR fi.data = '{}')
      AND fi.type = 'manual'
  `).all() as Array<{
    id: string;
    app_id: string | null;
    session_id: string | null;
    user_id: string | null;
    source_url: string | null;
    created_at: string;
  }>;

  console.log(`[migrate] Found ${rows.length} screenshot-only feedback items`);

  let migrated = 0;
  const insertShot = sqlite.prepare(`
    INSERT INTO screenshots (id, app_id, session_id, user_id, source_url, filename, mime_type, size, width, height, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `);
  const selectShots = sqlite.prepare(`SELECT id, filename, mime_type, size, created_at FROM feedback_screenshots WHERE feedback_id = ?`);
  const deleteFeedback = sqlite.prepare(`DELETE FROM feedback_items WHERE id = ?`); // cascades to feedback_screenshots

  const tx = sqlite.transaction((items: typeof rows) => {
    for (const fi of items) {
      const shots = selectShots.all(fi.id) as Array<{
        id: string; filename: string; mime_type: string; size: number; created_at: string;
      }>;
      for (const s of shots) {
        insertShot.run(
          s.id, // reuse the same ID so existing /files/... links still work at the filename level
          fi.app_id,
          fi.session_id,
          fi.user_id,
          fi.source_url,
          s.filename,
          s.mime_type,
          s.size,
          s.created_at,
        );
      }
      deleteFeedback.run(fi.id);
      migrated++;
    }
  });
  tx(rows);

  console.log(`[migrate] Migrated ${migrated} feedback items → screenshots table`);
}

function relabelFafoFeedback() {
  const result = sqlite.prepare(`
    UPDATE feedback_items
    SET type = 'fafo_worker', updated_at = ?
    WHERE type = 'manual'
      AND (
        title LIKE 'FAFO Gen %'
        OR title LIKE 'FAFO Meta-Manager %'
        OR title LIKE 'FAFO Decomposition%'
      )
  `).run(new Date().toISOString());

  console.log(`[migrate] Relabeled ${result.changes} FAFO feedback items to type=fafo_worker`);
}

console.log('[migrate] Starting migration…');
migrateScreenshotOnlyFeedback();
relabelFafoFeedback();
console.log('[migrate] Done.');
