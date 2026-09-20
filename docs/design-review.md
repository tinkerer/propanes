# Workspace design refresh · 19 September 2026

Review at http://localhost:3101/admin/#/settings/getting-started on the existing
isolated deployment. Original checkout and ports 3001/3002 remain untouched.

The initial blue/slate direction was rejected during review as “vibe coded.”
The revised direction is neutral charcoal and warm white, with orange limited
to branding/navigation. Hierarchy comes from typography, space and thin rules,
not colored cards or glowing buttons. DESIGN_SPEC.md records this decision.

## Implemented

- Shared light/dark tokens, including paired foregrounds for filled controls.
- More readable toolbar, quiet pane tabs/dividers, consistent button/dialog treatment.
- A reusable stroke-icon set in desktop and mobile navigation and toolbar.
- Prominent Getting Started entry, flat tutorial cards and underlined lesson tabs.
- Neutral prompt-widget launcher without blue glow or hover scaling.
- Focus-visible outlines and reduced-motion treatment for refreshed controls.

Presentation changes do not alter pane trees, tab mounting, terminal behavior,
API requests or application data. The defaults and existing layout stay intact.

## Validation and remaining work

`node packages/e2e/scripts/design-review.mjs` checks light/dark screenshots,
primary-button contrast (at least 4.5:1), dialogs and Escape, tutorial navigation,
settings/tickets/sessions routes, mobile overflow and modal bounds. Screenshots
are saved as `/tmp/propanes-design-*.png`. Admin production build, TypeScript
and its 38-test unit suite are also checked; the widget bundle is rebuilt.

This is the shared workspace design pass, not a claim that every legacy surface
has been redesigned. Component-local terminal/transcript colors, the expanded
widget, and dense advanced configuration screens still need a focused pass.
The four-pane sidebar remains available; simplifying that default layout is a
separate information-architecture decision. No remote push or deployment.

## Screenshot follow-ups

- Light mode now includes the navigation, sessions, terminals list, file tree and pane chrome instead of retaining a dark sidebar.
- Open Session's standalone toolbar no longer uses undefined `--pw-bg`/`--pw-text` variables. It has explicit dark PTY surface and readable paired text in both workspace themes.
- Preferences → Terminal appearance now provides Very dark grey (`#171717`, default), Black and Graphite. The choice persists locally and updates mounted xterm instances and other same-origin tabs/frames without recreating terminals or restarting sessions.
- `session-toolbar-review.mjs` checks desktop/mobile toolbar contrast, keyboard actions, actual xterm backgrounds, cross-tab preference updates and persistence. It sends no terminal input and does not accept the CLI's workspace-trust prompt.
