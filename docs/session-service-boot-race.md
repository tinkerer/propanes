# Session service: boot race leaves it alive but not listening

## Incident 2026-08-09

`azstaging.myworkbench.ai` (`workbench-shared-vm`) filled its OS disk and wedged.
After the recovery power-cycle, every propanes session failed instantly in the UI
with `--- Session exited (code: unknown) ---`.

## Symptom

`propanes.service` was healthy on `:3001`, but every spawn failed:

```
SessionServiceError: Session service unreachable at http://localhost:3002: fetch failed
    at spawnSessionRemote (packages/server/dist/session-service-client.js:17:15)
    at async spawnAgentSession (packages/server/dist/agent-sessions.js:83:5)
```

Meanwhile `systemctl status propanes-sessions` reported **`active (running)`** and
`systemctl --failed` was empty — nothing looked broken. But nothing was bound to
`:3002`.

## Root cause

`propanes.service` and `propanes-sessions.service` both declared only
`After=network.target`, so at boot they start concurrently and race for the same
SQLite DB. The session service lost:

```
[session-service] uncaughtException (continuing): SqliteError: database is locked
  code: 'SQLITE_BUSY'
    at appendSessionAuditMarker (session-service.js:392)
    at recoverSessions (session-service.js:1027)
    at session-service.js:1260          <- top-level module evaluation
```

In `packages/server/src/session-service.ts` the startup sequence is:

```ts
// ---------- Start ----------

recoverSessions();                       // line ~1395, top-level, NOT guarded

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[session-service] Running on http://localhost:${PORT}`);
});
```

`recoverSessions()` throwing aborts module evaluation, so `serve()` never runs and
the port is never bound. The process does **not** exit, because of the deliberate
last-resort guard added for node-pty handler errors:

```ts
process.on('uncaughtException', (err) => {
  console.error('[session-service] uncaughtException (continuing):', err);
});
```

That guard is correct for its intended purpose (a throw in an `onData` handler
shouldn't drop every live terminal), but during *startup* it converts a fatal
error into a silent half-dead process. `Restart=always` never fires, because
nothing ever exits.

## Mitigation applied (host-side, not in this repo)

`/etc/systemd/system/propanes-sessions.service.d/20-boot-order.conf`:

```ini
[Unit]
After=propanes.service

[Service]
ExecStartPost=/bin/bash -c 'for i in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/3002) 2>/dev/null && exit 0; sleep 1; done; echo "session-service never bound :3002" >&2; exit 1'
```

This orders the two services so they no longer race, and makes "started but not
listening" a real unit failure so the existing `Restart=always` retries it
instead of reporting success.

## Code fix (applied)

The systemd guard is a safety net, not a fix. Three changes in
`packages/server/src/session-service.ts`:

1. **`recoverSessions()` is wrapped in try/catch.** Recovery is best-effort —
   failing it must never stop the service from serving.
2. **`appendSessionAuditMarker` swallows its own errors.** It is called from
   inside recovery, and `packages/server/src/message-buffer.ts` already notes
   that concurrent writers "return SQLITE_BUSY even with busy_timeout=5000".
   An audit line is not worth aborting the caller.
3. **A throw before the port is bound is now fatal.** The `uncaughtException` /
   `unhandledRejection` guards check a `listening` flag (set in the `serve()`
   callback) and `process.exit(1)` if it is not set yet. "Continuing" is the
   right behaviour for a bug in a live PTY handler and the wrong one during
   startup, where it produces a process that is `active (running)` and bound to
   nothing. `Restart=always` can only retry something that actually exits.

Point 3 matters beyond `recoverSessions()`: the same failure reproduces from
`new MessageBuffer()` on line ~38 (`no such table: pending_messages` against an
un-migrated DB), which is upstream of any guard around recovery. Verified by
booting the service against a fresh un-migrated DB — before the change it sat
alive with nothing on its port, after it exits 1 in about a second.
