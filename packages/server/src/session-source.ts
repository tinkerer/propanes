// session-source.ts — where an agent session came from, derived from the tags
// on its feedback row.
//
// Sessions have no "source" column: a session dispatched from the admin
// popup, from the widget, or by the amirobot Slack bridge all look alike on
// agent_sessions. The bridge (packages/slack-bot/src/bridge.ts) tags the
// feedback it creates `slack` + `amirobot`, so the feedback tags are the one
// durable marker. The list/detail routes expose them as `feedbackTags` and the
// admin renders a Slack badge off them (admin/src/lib/session-source.ts).

import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { schema } from './db/index.js';

/** Scalar subquery: the feedback row's tags, comma-joined (NULL when none). */
export function feedbackTagsSubquery(feedbackIdColumn: SQLiteColumn): SQL<string | null> {
  return sql<string | null>`(select group_concat(${schema.feedbackTags.tag}, ',') from ${schema.feedbackTags} where ${schema.feedbackTags.feedbackId} = ${feedbackIdColumn})`;
}

/** group_concat output → sorted, de-duplicated string[]; null when the session
 *  has no feedback row or the row carries no tags. */
export function parseFeedbackTags(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const tags = [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))].sort();
  return tags.length ? tags : null;
}
