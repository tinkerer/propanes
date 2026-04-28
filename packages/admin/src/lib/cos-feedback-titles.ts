// Tiny in-memory cache of feedback titles for the dispatch status-line
// expansion. Without this, the status-line rerenders fire one GET per render
// for any feedback id it surfaces — and a deleted feedback turns into an
// infinite 404 loop. We cache hits, dedupe in-flight lookups, and back off
// on misses.

import { signal } from '@preact/signals';

const feedbackTitleCache = new Map<string, string>();
const feedbackTitleInFlight = new Map<string, Promise<string | null>>();
// Tracks failed lookups (404 for deleted feedback, network errors, etc.) so
// we don't refetch on every re-render. Value = { failedAt, attempts } drives
// an exponential backoff capped at FEEDBACK_TITLE_MISS_MAX_DELAY_MS.
const feedbackTitleMisses = new Map<string, { failedAt: number; attempts: number }>();
const FEEDBACK_TITLE_MISS_BASE_DELAY_MS = 30_000;
const FEEDBACK_TITLE_MISS_MAX_DELAY_MS = 30 * 60_000;
const FEEDBACK_TITLE_MISS_MAX_ATTEMPTS = 5;

/**
 * Bumps when a fetch lands so dependent UI (DispatchStatusLine) re-renders
 * after async resolution. Reads of `getCachedFeedbackTitle` are synchronous
 * and don't subscribe by themselves.
 */
export const feedbackTitlesVersion = signal(0);

function feedbackTitleMissBackoffMs(attempts: number): number {
  // 30s, 1m, 2m, 4m, 8m, ... capped.
  const ms = FEEDBACK_TITLE_MISS_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(ms, FEEDBACK_TITLE_MISS_MAX_DELAY_MS);
}

export function getCachedFeedbackTitle(id: string): string | null {
  return feedbackTitleCache.get(id) ?? null;
}

export async function fetchFeedbackTitle(id: string): Promise<string | null> {
  const cached = feedbackTitleCache.get(id);
  if (cached) return cached;
  const miss = feedbackTitleMisses.get(id);
  if (miss) {
    if (miss.attempts >= FEEDBACK_TITLE_MISS_MAX_ATTEMPTS) return null;
    if (Date.now() - miss.failedAt < feedbackTitleMissBackoffMs(miss.attempts)) return null;
  }
  const inFlight = feedbackTitleInFlight.get(id);
  if (inFlight) return inFlight;
  const p = (async () => {
    const recordMiss = () => {
      const prev = feedbackTitleMisses.get(id);
      feedbackTitleMisses.set(id, {
        failedAt: Date.now(),
        attempts: (prev?.attempts ?? 0) + 1,
      });
    };
    try {
      const token = localStorage.getItem('pw-admin-token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/v1/admin/feedback/${encodeURIComponent(id)}`, { headers });
      if (!res.ok) {
        recordMiss();
        return null;
      }
      const data = await res.json();
      const title = typeof data?.title === 'string' ? data.title : null;
      if (title) {
        feedbackTitleCache.set(id, title);
        feedbackTitleMisses.delete(id);
        feedbackTitlesVersion.value = feedbackTitlesVersion.value + 1;
      } else {
        recordMiss();
      }
      return title;
    } catch {
      recordMiss();
      return null;
    } finally {
      feedbackTitleInFlight.delete(id);
    }
  })();
  feedbackTitleInFlight.set(id, p);
  return p;
}
