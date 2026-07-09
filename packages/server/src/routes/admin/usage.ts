import { Hono } from 'hono';
import { summarizeUsage } from '../../metering.js';
import { getAdminUser } from '../../admin-auth.js';

export const usageRoutes = new Hono();

// Phase 5 — admin usage view. Aggregates the session_usage ledger by user,
// org, and isolation class. Admin-only; members don't see the fleet-wide meter.
usageRoutes.get('/usage', (c) => {
  const user = getAdminUser(c);
  if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  const sinceDays = Math.min(365, Math.max(1, Number(c.req.query('sinceDays')) || 30));
  return c.json(summarizeUsage(sinceDays));
});
