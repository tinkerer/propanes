# ProPanes Native — Implementation Plan

## Goal
Replace the embeddable JS widget with a native desktop app that overlays *any* application (web or native) and exposes a unified DOM-or-a11y tree to agents. Same backend (`server`, SQLite, agent sessions) — new client + new traversal layer.

---

## 1. Tech stack

**Shell: Tauri 2.x (Rust core + per-OS webview).**
Why over Electron:
- 10–30× smaller bundles, lower idle RAM — matters for a passive overlay.
- Rust is the right language for the per-OS a11y FFI. Electron would force a Node ↔ native-module boundary that's painful for a11y where you want low-latency tree polling.
- Tauri 2 has first-class mobile-style permissions + signed updaters across Win/Mac/Linux.

**UI:** keep Preact + the current widget styling, repackaged as a Tauri webview. 90% of `packages/widget` ports as-is.

**Native bridge:** a Rust crate `propanes-a11y` exposing one trait, three backends.

```rust
trait AccessibilityBackend {
    fn root(&self) -> Node;
    fn snapshot(&self, root: NodeId, depth: usize) -> Tree;
    fn focused(&self) -> Option<Node>;
    fn at_point(&self, x: i32, y: i32) -> Option<Node>;
    fn observe(&self, root: NodeId, sink: EventSink) -> Subscription;
    fn invoke(&self, n: NodeId, action: Action) -> Result<()>;
}
```

---

## 2. Per-OS backends

| OS | API | Crate / FFI |
|---|---|---|
| Windows | UI Automation (UIA) | `windows` crate → `IUIAutomation`, `IUIAutomationElement`, cache requests for batched property reads |
| macOS | AXUIElement / NSAccessibility | `accessibility-sys` + `core-foundation`; needs Accessibility permission prompt via TCC |
| Linux | AT-SPI2 over D-Bus | `atspi` crate; requires `org.a11y.Bus` running and `accessibility=true` in GTK/Qt apps |

Each backend translates its native node into a common `Node`:

```rust
struct Node {
  id: NodeId,           // stable per-process handle
  role: Role,           // normalized enum (Button, TextField, Menu, ...)
  name: String,         // accessible name
  value: Option<Value>, // text/number/range
  bounds: Rect,         // screen coords
  state: StateFlags,    // focused, expanded, selected, offscreen, ...
  attrs: AttrMap,       // platform-specific extras, namespaced
  children: Vec<NodeId>,
}
```

Role normalization is the hard part — UIA `ControlType.Button` ≈ AX `AXButton` ≈ AT-SPI `push button`. Build the mapping from W3C ARIA role taxonomy as the lingua franca; that also gives you free alignment with web DOM ARIA.

---

## 3. Unified DOM + a11y traversal

The point of the "unified" tree: an agent shouldn't care whether a node came from a Chromium webview or a native Win32 button.

**Strategy: route everything through the OS a11y tree.**

All three OSes already publish web content into their a11y tree (Chromium/WebKit/Gecko maintain a "browser accessibility tree" mirrored to UIA/AX/AT-SPI). So:
- Native windows → backend → unified `Node`.
- Webview content → same backend, same unified `Node`, role-mapped via ARIA which the browser already emits.
- DOM-only details we lose (CSS selectors, raw HTML) → second optional channel via CDP for embedded webviews and via injected content scripts for external browsers we control.

**Two channels, joined by a `domHandle`:**
1. `propanes-a11y` (mandatory, always-on, OS-level).
2. `propanes-dom` (optional, richer): Chrome DevTools Protocol for our own Tauri webview + a browser extension for external Chrome/Edge/Firefox/Safari. Each DOM node carries an `axId` so the trees can be cross-referenced.

This means the agent's traversal API is:
```ts
ax.snapshot({root: 'focused-window', depth: 6}) // a11y everywhere
dom.snapshot(axNode)                            // optional DOM enrichment if available
```

---

## 4. Overlay rendering

- Tauri window with `decorations: false`, `transparent: true`, `alwaysOnTop: true`, click-through toggleable per-region.
- One borderless overlay per monitor; positioned via OS display enumeration (Rust `display-info` crate).
- Keep the current widget UI (camera button, feedback composer, agent picker) inside the overlay webview.
- Hotkey via `tauri-plugin-global-shortcut` (default: ⌘⇧F / Ctrl+Shift+F).

---

## 5. Capture

| Capability | Win | Mac | Linux |
|---|---|---|---|
| Screen capture | Windows.Graphics.Capture | ScreenCaptureKit (≥12.3) | PipeWire portal (XDG desktop portal) |
| Region screenshot | same APIs, cropped | same | same |
| Active window | UIA + DWM | AX + CGWindow | AT-SPI + wmctrl/Wayland-compositor APIs |

Wrap behind a `Capture` trait with `screenshot(rect)`, `window_image(window_id)`. Replaces `html-to-image` for non-web targets; keeps `html-to-image` path for embedded webviews where DOM-accurate render matters more than pixels.

---

## 6. Server/backend reuse

No server changes for v1. Native client speaks the same REST/WebSocket API as the widget today:
- `POST /api/v1/feedback` / `/feedback/programmatic`
- `WS /ws/agent` for live session bridging
- New optional payload: `axTree` (compact JSON of the unified node graph) attached to feedback so agents inherit the structural context the user saw.

Server-side additions, kept small:
- New column `feedback.ax_tree_id` → blob store.
- Agent dispatch optionally passes `axTreeId` so the spawned Claude/Codex sees the tree as a tool input.
- New tool exposed to agents: `ax_query(selector)` — selector grammar like `role=Button[name~="Save"]` over the unified schema.

---

## 7. Agent integration

Two new agent-facing tools surfaced through the existing session bridge:
1. `ax.snapshot(rootSelector, depth)` — returns subtree.
2. `ax.invoke(nodeId, action)` — Click / Focus / SetValue / Expand, mapped per backend.

Plus optional `dom.*` mirrors when a DOM channel is connected. Both flow through the launcher → server → admin pipeline already in place; the launcher daemon gets a thin `propanes-a11y` client built into the binary.

---

## 8. Permissions / packaging

- **macOS:** Accessibility + Screen Recording entitlements; notarized + hardened-runtime build; code-sign with Developer ID; auto-prompt on first launch via `AXIsProcessTrustedWithOptions`.
- **Windows:** UIA needs no special perms; capture works with normal user. MSIX for Store, signed MSI for direct.
- **Linux:** ship as Flatpak (with `org.freedesktop.portal.ScreenCast` + `org.a11y.Bus` access) and AppImage. Document the GNOME `org.gnome.desktop.interface toolkit-accessibility=true` requirement.

---

## 9. Roadmap

| Milestone | Scope | Est. |
|---|---|---|
| M0: spike | Tauri shell + UIA snapshot of focused window on Windows | 1 wk |
| M1: 3 backends | AX (mac) + AT-SPI (linux) backends behind same trait, role-normalized | 3 wks |
| M2: overlay UX | Port widget UI into Tauri overlay, hotkey, screenshot capture | 2 wks |
| M3: server wiring | `axTree` upload, agent tools `ax.snapshot`/`ax.invoke`, end-to-end dispatch | 2 wks |
| M4: DOM channel | CDP for embedded webview, browser extension stub for external Chrome | 2 wks |
| M5: hardening | Permission flows, signing, auto-update, telemetry, crash reporting | 2 wks |
| M6: GA | Beta → public; retire widget for users who have native installed | 2 wks |

Total ~14 weeks for one engineer; ~8 weeks with two (one Rust/native, one frontend/server).

---

## 10. Risks

- **Wayland a11y is uneven** — GNOME ok, KDE ok, Sway/wlroots needs work. Mitigation: detect at startup, fall back to "DOM-only against our own webview" mode.
- **macOS TCC re-prompts on every code-signing identity change** — stick to a single Developer ID across builds.
- **Role normalization debt** — every release will hit a role we don't map cleanly. Mitigation: keep the raw platform role in `attrs` so agents can fall back even when the normalized enum is wrong.
- **Performance on huge a11y trees** (Slack, IDEs) — UIA without `CacheRequest` is 10–100× slower than with one; mandate batched property fetches in every backend.

---

## 11. What stays / what dies

| Stays | Dies |
|---|---|
| `packages/server` API | `packages/widget` (deprecated after M6) |
| Agent session bridge / launcher protocol | `html-to-image` as the primary capture path |
| Admin SPA | Embed-script install flow |
| SQLite schema (additive only) | — |

The widget can stay shipped indefinitely as a fallback for unowned web pages; native is the first-class experience.

---

## 12. Mobile companion (iOS + Android)

The desktop native app is the *capture/overlay* surface (a11y tree, screen, DOM). The mobile app is the *control* surface — chat with agents, watch sessions, dispatch and steer work from a phone. They connect to the same `packages/server` and share the same chat threads.

### Scope

A mobile client can do everything the admin SPA's CoS bubble + sessions page do today:
- Browse feedback, dispatch agents, read/post in CoS threads.
- Watch a live session's structured output.
- Approve permission prompts from `headless-stream-require` sessions.
- Voice-to-text input (reuse `packages/widget/src/voice-recorder.ts` patterns).
- Receive push notifications for: session completed, bail-out detected, permission prompt awaiting answer, new feedback matching a watch.

Out of scope for v1: native a11y traversal *of the phone itself*. Mobile a11y tree (UIAccessibility / AccessibilityService) is interesting later but not the priority — the phone's job is remote control of desktop sessions.

### Stack

**Tauri 2 mobile** for both platforms. Same Rust core, same Preact UI as desktop, same protocol to server. One codebase, three targets (Win/Mac/Linux desktop + iOS + Android).

Why not React Native / Flutter / native:
- We already have a working Preact admin SPA. Tauri mobile lets us reuse it almost verbatim, then layer mobile-specific UX (bottom sheet, pull-to-refresh, push) on top.
- The Rust core gives us one place to put network, auth, secrets, and the WebSocket reconnection logic — instead of three.

Where Tauri mobile is weak:
- Background execution + push notifications need per-OS plugins. Use `tauri-plugin-notification` + APNs/FCM via a small native sidecar.
- Audio capture for voice input → `tauri-plugin-audio` or thin native shims.

### Server changes

Mostly additive; the existing API already covers the read/write flows.

- **Auth + pairing:** today the server is unauth'd on localhost. For mobile we need:
  - Account model (email + magic link, or OAuth) — new tables `users`, `sessions`, `device_tokens`.
  - Pairing flow: desktop shows QR code → phone scans → exchanges device key. Stored as `device_tokens.pairing_id`.
  - All `/api/v1/admin/*` routes gated on a session cookie or bearer token; localhost gets an auto-issued token for backwards compat.
- **Push:** new table `push_subscriptions` (apns_token / fcm_token + user_id). New service module `packages/server/src/push.ts` with hooks on session state changes, permission prompts, and chief-of-staff message inserts.
- **Reverse tunnel for self-hosted:** users who run the server on their LAN need a way to reach it from cellular. Options:
  - Cloudflare Tunnel docs + a `propanes tunnel` CLI wrapper.
  - Optional `tailscale` integration — detect at runtime, prefer Tailscale IP when present.
  - Hosted relay (later) — propanes.cloud or similar, end-to-end encrypted between desktop and phone with the server as a dumb transport.

### Mobile UX surfaces

| Screen | Source today | Mobile adaptation |
|---|---|---|
| Thread list | `ChiefOfStaffBubble` thread tree | Inbox-style list, swipe to archive |
| Thread view | CoS chat | Full-screen chat with voice input, image attach |
| Sessions | `/admin/#/sessions` | Tab with live status dots; tap to drill in |
| Session detail | `StructuredView` + terminal | Structured-only by default; "raw" toggle |
| Feedback inbox | `FeedbackListPage` | Filter chips (new/dispatched/resolved) |
| Approvals | (none yet — admin UI eats prompts) | Banner notif → modal Yes/No/Edit |

### Voice / hands-free

Mobile is the natural place for voice-first interaction:
- Tap-and-hold mic → Whisper or platform STT → send as CoS message.
- Reverse: TTS-read the latest assistant message when the screen is off.
- Hot-route: the mic button in the desktop overlay can also push audio to the *paired phone's* speakers, so the phone is a remote interface to the desktop session.

### Permission-prompt remote answer

Today `headless-stream-require` surfaces approval prompts as JSON events to the admin UI. Phones get the same channel:
- New WS topic `permission-prompts:user_id`.
- Push notification fires with the prompt summary; deep-link opens the modal.
- Tap Allow/Deny → server forwards over the existing stream-json input back-channel.

### Roadmap addendum

| Milestone | Scope | Est. |
|---|---|---|
| M7: auth + pairing | User model, magic link, QR pairing, token-gated API | 2 wks |
| M8: mobile shell | Tauri mobile build of admin SPA, navigation, offline cache | 2 wks |
| M9: push + approvals | APNs/FCM wiring, permission-prompt remote answer | 2 wks |
| M10: voice + tunnels | Voice input/output, Cloudflare/Tailscale tunnel docs + CLI | 2 wks |
| M11: GA | TestFlight / Play internal → public | 2 wks |

~10 weeks after desktop M6 lands, runs in parallel with desktop hardening if a second engineer picks it up.

### Mobile-specific risks

- **iOS background WS** — APNs is the only reliable wakeup; do *not* try to keep a WebSocket alive in background. Treat push as the truth source and reconnect WS on resume.
- **Pairing UX** — QR flow needs to work even when desktop has no public IP. Design the pairing token to encode a relay URL fallback.
- **App Store review** — "remote terminal/agent control" can spook reviewers. Frame it as a productivity/notifications client, not a remote shell. Avoid surfacing raw shell output by default in the App Store build.
