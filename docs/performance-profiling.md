# Performance Profiling

The admin dashboard has built-in performance instrumentation that measures API call durations on every page. Three independent features let you observe and collect this data.

## Console logging

Perf logs are **off by default**. Toggle from the browser console:

```js
pwPerf()        // toggle on/off
pwPerf(true)    // enable
pwPerf(false)   // disable
```

When enabled, every measured call prints a line like:

```
[perf] sessions:list: 708ms
```

The setting persists in `localStorage` (`pw-perf-logs`).

## Browser freeze diagnostics

The admin app also records browser main-thread stalls:

- `browser:long-task` comes from the browser Long Task API.
- `browser:event-loop-stall` means the event loop was delayed by at least
  200ms.
- `terminal:write:NKB` means xterm.js took at least 80ms to process one output
  batch.

To inspect the last entries from the browser console:

```js
pwPerf(true)       // also log entries as they happen
pwPerfReport()     // print a table and return the raw report object
```

For visible debugging, enable the overlay:

```js
localStorage.setItem('pw-perf-overlay', 'true')
location.reload()
```

When the page freezes, wait for it to recover and run `pwPerfReport()`. If the
largest rows are `terminal:write:*`, the PTY output/xterm path is the current
bottleneck. If they are `browser:long-task` or `browser:event-loop-stall`
without terminal writes nearby, capture a Chrome performance trace around the
freeze and inspect the long task stack.

## On-screen overlay

A floating badge in the corner of the page shows total duration and per-call breakdowns, color-coded:

| Color  | Threshold |
|--------|-----------|
| Green  | < 200ms   |
| Orange | 200–500ms |
| Red    | > 500ms   |

Enable via **Settings > Developer > Performance overlay**, or set `pw-perf-overlay` to `true` in localStorage.

## Server-side persistence

When enabled, timing data is POSTed to the server on every route change so you can query it later.

Enable via **Settings > Developer > Persist performance data**, or set `pw-perf-server` to `true` in localStorage.

### Querying stored metrics

```bash
# Recent metrics (default limit 50)
curl -s 'http://localhost:3001/api/v1/admin/perf-metrics' | python3 -m json.tool

# Filter by route
curl -s 'http://localhost:3001/api/v1/admin/perf-metrics?route=/app/APP_ID/feedback' | python3 -m json.tool

# Custom limit
curl -s 'http://localhost:3001/api/v1/admin/perf-metrics?limit=100' | python3 -m json.tool
```

Each record contains `{ id, route, timestamp, durations }` where `durations` is a map of label to milliseconds.

## What gets measured

The `timed(label, fn)` wrapper is used around these calls:

| Label | Description |
|-------|-------------|
| `apps:list` | Fetch all registered applications |
| `apps:feedbackCounts` | Fetch per-app feedback counts |
| `sessions:list` | Fetch agent sessions |
| `liveConnections` | Poll active WebSocket connections |
| `browser:long-task` | Main-thread task exceeding 80ms |
| `browser:event-loop-stall` | Event loop drift exceeding 200ms |
| `terminal:write:*` | Slow xterm.js output batch |

## localStorage keys

| Key | Default | Controls |
|-----|---------|----------|
| `pw-perf-logs` | `false` | Console `[perf]` logging |
| `pw-perf-overlay` | `false` | On-screen timing badge |
| `pw-perf-server` | `false` | POST metrics to server |
