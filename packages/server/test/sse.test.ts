import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tempDir = mkdtempSync(join(tmpdir(), 'propanes-sse-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { sseResponse, sseMaxLifetimeMs, DEFAULT_SSE_MAX_LIFETIME_MS } = await import('../src/sse.ts');
const { runMigrations, sqlite } = await import('../src/db/index.ts');
const { app } = await import('../src/app.ts');
const { mintUserToken } = await import('../src/auth.ts');
const { feedbackEvents } = await import('../src/events.ts');

runMigrations();

test.after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

test('sseResponse sends a retry hint, events, keepalives, then ends cleanly at maxLifetimeMs', async () => {
  let cleanups = 0;
  const h = new Hono();
  h.get('/s', (c) => sseResponse(c, (sink) => {
    sink.send('hello', { n: 1 });
    return () => { cleanups += 1; };
  }, { maxLifetimeMs: 120, keepaliveMs: 40, retryMs: 7 }));

  const started = Date.now();
  const res = await h.request('/s');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');

  const body = await drain(res);
  const elapsed = Date.now() - started;
  assert.ok(body.startsWith('retry: 7\n\n'), body);
  assert.ok(body.includes('event: hello\ndata: {"n":1}\n\n'), body);
  assert.ok(body.includes(': keepalive\n\n'), body);
  assert.ok(elapsed >= 100 && elapsed < 2000, `ended after ${elapsed}ms`);
  assert.equal(cleanups, 1);
});

test('sseResponse with maxLifetimeMs=0 never recycles; closing the sink ends the stream once', async () => {
  let cleanups = 0;
  let sinkRef: { close(): void; closed: boolean } | null = null;
  const h = new Hono();
  h.get('/s', (c) => sseResponse(c, (sink) => {
    sinkRef = sink;
    return () => { cleanups += 1; };
  }, { maxLifetimeMs: 0, keepaliveMs: 0 }));

  const res = await h.request('/s');
  const done = drain(res);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sinkRef && !sinkRef.closed);
  sinkRef!.close();
  sinkRef!.close();
  assert.ok(sinkRef!.closed);
  await done;
  assert.equal(cleanups, 1);
});

test('sseResponse tears down when the request is aborted and drops later sends', async () => {
  let cleanups = 0;
  let sinkRef: { send(e: string, d: unknown): void; closed: boolean } | null = null;
  const h = new Hono();
  h.get('/s', (c) => sseResponse(c, (sink) => {
    sinkRef = sink;
    return () => { cleanups += 1; };
  }, { maxLifetimeMs: 0, keepaliveMs: 0 }));

  const ac = new AbortController();
  const res = await h.request('/s', { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read(); // retry frame
  ac.abort();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sinkRef!.closed);
  assert.equal(cleanups, 1);
  assert.doesNotThrow(() => sinkRef!.send('late', {}));
  assert.equal(cleanups, 1);
});

test('sseMaxLifetimeMs reads SSE_MAX_LIFETIME_MS and falls back on junk', () => {
  const prev = process.env.SSE_MAX_LIFETIME_MS;
  try {
    delete process.env.SSE_MAX_LIFETIME_MS;
    assert.equal(sseMaxLifetimeMs(), DEFAULT_SSE_MAX_LIFETIME_MS);
    process.env.SSE_MAX_LIFETIME_MS = '0';
    assert.equal(sseMaxLifetimeMs(), 0);
    process.env.SSE_MAX_LIFETIME_MS = '45000';
    assert.equal(sseMaxLifetimeMs(), 45_000);
    process.env.SSE_MAX_LIFETIME_MS = 'soon';
    assert.equal(sseMaxLifetimeMs(), DEFAULT_SSE_MAX_LIFETIME_MS);
    process.env.SSE_MAX_LIFETIME_MS = '-5';
    assert.equal(sseMaxLifetimeMs(), DEFAULT_SSE_MAX_LIFETIME_MS);
  } finally {
    if (prev === undefined) delete process.env.SSE_MAX_LIFETIME_MS;
    else process.env.SSE_MAX_LIFETIME_MS = prev;
  }
});

test('GET /api/v1/admin/feedback/events is recycled under SSE_MAX_LIFETIME_MS and unsubscribes', async () => {
  const prev = process.env.SSE_MAX_LIFETIME_MS;
  process.env.SSE_MAX_LIFETIME_MS = '150';
  try {
    const token = await mintUserToken({ id: 'env-admin', username: 'admin', role: 'admin' });
    const before = feedbackEvents.listenerCount('new');
    const res = await app.request(`/api/v1/admin/feedback/events?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(feedbackEvents.listenerCount('new'), before + 1);

    const started = Date.now();
    const body = await drain(res);
    assert.ok(Date.now() - started < 2000, 'stream should end on its own');
    assert.ok(body.startsWith('retry: '), body);
    assert.ok(body.includes('event: connected\n'), body);
    assert.equal(feedbackEvents.listenerCount('new'), before);
  } finally {
    if (prev === undefined) delete process.env.SSE_MAX_LIFETIME_MS;
    else process.env.SSE_MAX_LIFETIME_MS = prev;
  }
});
