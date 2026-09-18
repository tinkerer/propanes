# Onboarding review · 18 September 2026

## Review deployment

This branch starts from remote master `16bd0a17`. The original checkout's master had diverged after a remote force update, so it was preserved and the work was done in the sibling `propanes-onboarding` worktree on `ui/onboarding-review`.

- Admin/API: http://localhost:3101/admin/#/settings/getting-started
- Session service: http://localhost:3102
- STEP viewer experiment: http://localhost:5178
- Unmodified Hello World starter for comparison: http://localhost:5180
- Starter source: `/Users/amir/work/github.com/propanes-hello-world` (separate local Git repository)
- Viewer source: `/Users/amir/work/github.com/propanes-step-viewer` (separate local Git repository, final commit `c0ed0d0`)
- Database: `packages/server/onboarding.db` (local, ignored by Git)

The isolated instance uses the default local admin login, `admin / admin`. The existing deployment on ports 3001/3002 and its database were not changed.

## What the walkthrough found and fixed

1. **Create did not produce a working development loop.** The starter used a static server, had no editable JavaScript entry point, and generated a nonexistent widget URL with obsolete attributes. It now generates a Vite app, correct widget embed, README, strict preview port, registered preview URL, and a Start dev server control.
2. **Creation ended at the wrong next step.** The success screen told users to install a widget already included in the starter. It now explains starting the app, checking terminal output, opening the preview, and making a first prompt.
3. **The first screen was a reference document or an empty tickets table.** The welcome page now gives three concrete actions, keeps technical documentation in an expandable reference, and includes four copyable prompts with acceptance checks. Empty tickets point to the app and guide.
4. **Setup assistant failures disappeared.** Failed requests now retain the modal and typed request, display the error, and let the user retry. Busy actions cannot be submitted repeatedly.
5. **New apps crashed App Settings.** Scaffold and clone stored `hooks: {}` while the public schema and UI require an array. New rows use `[]`; API serialization normalizes old rows.
6. **The guide appeared in a small terminal pane.** Getting Started now opens in the main pane. Settings tabs no longer show a terminal session ID and Kill button.
7. **Light-theme pages inherited a dark terminal background.** Page surfaces now use theme tokens; navigation and terminal surfaces retain their existing treatment.
8. **A fresh preview could not explain the missing agents.** The widget now distinguishes loading, signed-out, empty-agent, and unavailable-server states. Its sign-in action opens the existing embedded login, which hands authentication back to the host widget. Submit only remains available without agent access.
9. **Keyboard and small-screen behavior needed attention.** Setup has associated labels, focus containment and Escape dismissal; tutorial tabs support arrow/Home/End navigation. The guide stacks on narrow screens.
10. **The technical reference omitted authentication.** Admin API examples now include the bearer header and login instructions, and the headless example specifies its actual permission profile.

## Validation

- Production builds: shared, widget, admin, server.
- Admin TypeScript check and existing admin unit suite (38 tests).
- Starter tests cover the widget contract, Vite/port configuration and HTML escaping.
- Playwright walkthrough creates an actual starter through the UI, exercises an assistant failure, rejects invalid/duplicate requests, runs the Start dev server control, opens App Settings, checks tutorial switching, and captures light/dark/mobile screenshots.
- A source edit updated an already-open browser page through Vite without manual navigation or reload; the temporary verification edit was then removed.
- The real widget sign-in flow was exercised from a fresh preview browser session through the embedded login and token handoff.
- Keyboard checks cover tutorial arrow navigation, modal initial focus, Tab/Shift+Tab containment, and Escape. The global capture-phase shortcut handler previously swallowed modal Escape; it now leaves modal-owned keys to the dialog.
- Both admin and widget pass TypeScript checks.
- A route sweep covered Getting Started, Agents, Infrastructure, Users, Preferences, User Guide, App Settings, Sessions, Live Connections, and Tickets. App Settings exposed the hooks issue described above; the corrected route passed the subsequent walkthrough.

## Real prompt experiment

The app-scoped “Onboarding Claude” endpoint received all four requests through the actual prompt widget. The Hello World app became a Three.js scene, then a real STEP importer using locally served `occt-import-js` JavaScript/WASM in a worker, then a viewer with parts visibility, bounds in millimetres, fit/reset, drag-and-drop, file validation and mobile controls. The sample includes its upstream source and license notices.

The first prompt implemented the greeting/counter, but its verification overlapped the second request; it was stopped once superseded. The counter was retained, and subsequent stages were allowed to finish before continuing. This reinforces the guide's instruction to inspect each completed change before sending the next prompt. Scene, importer and final viewer commits are `9f1b212`, `c25becd`, and `c0ed0d0` in the separate demo repository; no remote commits or PRs were created.

After moving the demo out of `/tmp`, its production build and STEP parser test passed. `node packages/e2e/scripts/step-viewer-review.mjs` verified actual sample loading, part visibility, fit/reset, invalid/oversized file rejection without losing the current model, loading a second STEP file, and the mobile prompt widget, with no browser page errors. Desktop/mobile captures are `/tmp/propanes-step-viewer-desktop.png` and `/tmp/propanes-step-viewer-mobile.png`. The demo's roughly 7.6 MB parser WASM and 505 KB JavaScript chunk are appropriate review follow-ups before production deployment.

Both the untouched starter and evolved viewer are registered in the isolated admin with their durable project paths and running development terminals. Their dev servers can also be started with `npm run dev` from their respective source directories when the ports are free.

## Reproducing locally

Use Node 22 (the native SQLite/PTY dependencies must match the Node runtime used to install them). Install with `pnpm install --frozen-lockfile`, then build shared, widget, and admin.

Run these from `packages/server`, in separate terminals:

```sh
PORT=3101 DB_PATH=onboarding.db SESSION_SERVICE_URL=http://localhost:3102 \
PW_PUBLIC_BASE_URL=http://localhost:3101 \
node --conditions=@propanes/source --import tsx src/index.ts

SESSION_SERVICE_PORT=3102 DB_PATH=onboarding.db \
PROPANES_API_URL=http://localhost:3101 \
node --conditions=@propanes/source --import tsx src/session-service.ts
```

Run `node packages/e2e/scripts/onboarding-review.mjs` from the repo root against this dedicated instance. It creates a new project under `/tmp/propanes-onboarding-projects` and starts its preview on 5180; set `PROPANES_REVIEW_PORT` to another free port when repeating. It deliberately leaves the app and its terminal available for inspection.

The separate `onboarding-prompt.mjs` script sends a real agent request, so it is opt-in. Configure an app-scoped agent named “Onboarding Claude”, then run one numbered step (1–4), wait for the session to finish, inspect the result, and only then send the next step. It uses the actual widget UI, not a simulated agent response.

## Remaining product work

- Expose actual dev-server readiness and Stop/Restart controls. The current Start control opens a terminal; its existence is not a health check.
- Stopping the review starter's plain terminal left its Vite child process listening. The child was explicitly stopped before relocating/restarting the demo; process-tree cleanup deserves a focused follow-up.
- Agent configuration still assumes users know how to install and authenticate their chosen CLI. A connection test and focused first-agent wizard would make the next setup step clearer.
- Keep advanced orchestration (infrastructure, Wiggum, Flatter, multiple pane layouts) available, but consider a simpler first-run navigation preset in a separate change.
- The creation form assumes the browser and server are on the same machine for localhost previews. Remote preview URLs and port forwarding need an explicit deployment-aware flow.
- The tutorial is a guided experiment, not a deterministic generator. Agent output must be checked after each prompt, especially STEP parsing, file-size limits, and units.
