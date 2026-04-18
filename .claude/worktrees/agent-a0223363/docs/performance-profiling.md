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

## localStorage keys

| Key | Default | Controls |
|-----|---------|----------|
| `pw-perf-logs` | `false` | Console `[perf]` logging |
| `pw-perf-overlay` | `false` | On-screen timing badge |
| `pw-perf-server` | `false` | POST metrics to server |
