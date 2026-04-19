# @propanes/e2e

Playwright cross-viewport E2E suite for the ProPanes admin + widget.

## What this covers

- **Auth flow** — login form, error path, post-login landing
- **Feedback list** — seeded rows render, search filter narrows, "+ New" form opens
- **Feedback detail** — title/description render, navigation deep-links work
- **Dispatch dialog** — opens via row action, closes on Escape, dispatch POST is intercepted
- **Sessions page** — mounts without crashing on empty state
- **Widget round-trip** — programmatic `POST /api/v1/feedback/programmatic` shows up in the admin list
- **MessageRenderer visual baselines** — Bash, Edit (diff), AskUserQuestion, long-output (collapsed/expanded)
- **Mobile structural assertions** — viewport meta, no horizontal scroll, tap-target sizes

Each test runs in **two projects**:
- `desktop-chromium` — 1440x900
- `mobile-iphone-14` — Playwright's iPhone 14 device descriptor (390x844 + touch + UA)

## Running

From repo root:

```bash
npm run test:e2e                 # run all specs against a fresh tmp DB
npm run test:e2e:update          # update visual snapshots after intentional changes
```

From this package:

```bash
pnpm test                         # same as the root command
pnpm test:headed                  # show the browser
pnpm test:ui                      # Playwright UI mode (interactive)
pnpm test:report                  # open last HTML report
```

The orchestrator (`scripts/run-e2e.mjs`) does the following per invocation:

1. Picks a free TCP port via `net.createServer().listen(0)`.
2. Creates a temp directory with a fresh SQLite file (`DB_PATH=...`) and
   uploads dir (`UPLOAD_DIR=...`).
3. Spawns `pnpm --filter @propanes/server dev:server` with those env vars
   plus `ADMIN_PASS=e2e-admin-pass` and a deterministic `JWT_SECRET`.
4. Waits up to 30s for `/api/v1/health` to return 200.
5. Seeds via the real REST API:
   - one `application` (the test app)
   - one default `agent_endpoint` (interactive profile)
   - three `feedback_items` (titled `Baseline: ...`)
6. Exports the IDs/keys via `E2E_*` env vars and runs `playwright test`.
7. Tears the server down and removes the temp directory on exit.

**No mocking of the server, DB, or filesystem.** Per `CLAUDE.md` and the
project test policy, integration tests hit real infra against an isolated
SQLite file. The single intentional mock is the `POST /admin/dispatch`
network route in `04-dispatch-dialog.spec.ts`, which prevents the dispatch
test from spawning a real Claude Code session.

## Visual regression

Snapshots live under `tests/__snapshots__/` and are organized by spec file
and project:

```
tests/__snapshots__/
  01-auth.spec.ts/
    login-page-desktop-chromium.png
    login-page-mobile-iphone-14.png
  02-feedback-list.spec.ts/
    feedback-list-table-desktop-chromium.png
    ...
  07-message-renderer-visual.spec.ts/
    message-bash-desktop-chromium.png
    message-edit-mobile-iphone-14.png
    ...
```

Update intentionally:

```bash
npm run test:e2e:update
```

Review the diff in `git diff packages/e2e/tests/__snapshots__/` before
committing — the four sibling agents (mobile site, voice mode, structured
view interaction, code cleanup) should diff their PR baselines against the
ones recorded in this branch.

## Adding a fixture

The MessageRenderer fixtures are defined in
`packages/admin/src/components/MessageFixturesIsolate.tsx` and surfaced via
the admin's `isolate` query param:

```
http://localhost:3001/admin/?isolate=msg-fixture&fixture=<name>
```

To add a new tool render baseline (e.g. `Read`, `Glob`, `WebFetch`):

1. Add a new entry to the `FIXTURES` map in `MessageFixturesIsolate.tsx`
   with a fully-formed `ParsedMessage[]`.
2. Rebuild admin: `cd packages/admin && npm run build`.
3. Append the fixture name to the `FIXTURES` array in
   `tests/07-message-renderer-visual.spec.ts`.
4. Run `npm run test:e2e:update` to generate the baseline.

## Soft assertions on mobile

The current admin is **not** responsive — that's the sibling mobile agent's
work. To avoid blocking the harness on missing UI, mobile-only checks
(horizontal overflow, tap-target size) are recorded as test annotations
rather than hard failures on the `mobile-iphone-14` project. They remain
hard assertions on `desktop-chromium`.

When the mobile redesign lands, flip the `if (isMobile)` branches in
`08-mobile-assertions.spec.ts` to hard `expect()` calls.

## Environment variables

| Var | Set by | Purpose |
| --- | --- | --- |
| `E2E_BASE_URL` | orchestrator | Server URL the suite hits |
| `E2E_APP_ID` | orchestrator | Seeded application ID |
| `E2E_API_KEY` | orchestrator | Seeded application API key |
| `E2E_ADMIN_USER` | orchestrator | Admin username (default `admin`) |
| `E2E_ADMIN_PASS` | orchestrator | Admin password (default `e2e-admin-pass`) |
| `E2E_FEEDBACK_IDS` | orchestrator | Comma-separated seeded feedback IDs |

Override `E2E_BASE_URL` to point at an already-running server if you want
to iterate on tests without restarting the server each run.
