# Style Guide — Propanes Admin

The durable visual rules. Read this before adding any element that floats over other content, picks colors from `--pw-*` tokens, or renders inside a popout/companion drawer. Most recurring UI bugs in this app are not layout bugs — they are **opacity bugs** and **containing-block bugs**. The rules below exist because each one mapped to an operator complaint at least once.

> Cross-references: `CLAUDE.md` "UI Conventions", [[spec-backbone]] §2.4 + §3, [[feedback_floating_overlay_opaque]].

---

## 1. Background tokens and where they may be used

The admin SPA uses CSS custom properties prefixed `--pw-*` (defined in `app.css`). The two axes you must keep straight:

- **Scope:** the *root scope* (global page) vs *dark scopes* (`.cos-popout`, `.cos-thread-side`, `.cos-learnings-side`, popped-out windows). Inside the dark scope, several tokens are redefined to **translucent tints** so inline regions blend into the dark drawer backdrop.
- **Use site:** *inline regions inside a parent* (a card, a row, a section header) vs *elements that float on top of other content* (popups, dropdowns, menus, modals, lightboxes, tooltips with text).

| Token | Root value | Dark-scope override | When it is OK to use |
|---|---|---|---|
| `--pw-bg-body` | opaque page bg | `transparent` | Page-level backgrounds only. Never on a popup. |
| `--pw-bg-surface` | opaque card bg | `rgba(255,255,255,0.04)` | Inline panels/cards that sit on top of a known parent paint. **Never on something that floats.** |
| `--pw-bg-raised` | slightly raised | `rgba(255,255,255,0.06)` | Hovered rows, raised inline chips. |
| `--pw-bg-sunken` | inset darker | `rgba(0,0,0,0.25)` | Inset wells inside a card (input wrappers, code blocks). |
| `--pw-bg-inset` | inset | `rgba(0,0,0,0.2)` | Same family as `sunken`. |
| `--pw-bg-hover` | hover state | `rgba(255,255,255,0.06)` | `:hover` states only. |
| `--pw-border` / `--pw-border-light` | borders | dark borders | Borders are fine on floating elements. |

**The trap:** CSS variables cascade through the DOM tree regardless of `position: fixed`. A popup rendered as a child of `.cos-popout` inherits the translucent `--pw-bg-surface` and shows whatever is behind it. `position: fixed` does not save you from variable inheritance.

---

## 2. The opacity rule (floating overlays)

> **If the element renders on top of *other* content (not just a sibling block in the same column), it needs solid paint.**

Required paint for any floating overlay in the dark theme:

- **Background:** hardcoded opaque hex — `#1e293b` for popups/menus/dropdowns; `#0b1220` for full-viewport modal/lightbox backdrops.
- **Never** `var(--pw-bg-surface)` or any `rgba(…, alpha < 1)` value when the element floats.
- **Backdrop-filter is decoration, not opacity.** A blurred background still reveals text underneath at >0.7 alpha. Use blur *with* an opaque base color, never as a substitute.
- **Borders + shadow** belong on the floating element so it has a visible edge against the page.

Classes that fall under this rule (non-exhaustive — anything matching the rule above must comply):

```
.pty-ctx-menu              .status-dot-menu          .cos-thread-rail-popup
.cos-popout-popup          .quick-dispatch-popup     .popup-menu             (PopupMenu primitive)
.terminal-picker           .sm-lightbox              .spotlight-overlay
context menus, dropdowns, tooltips with body text, action popups
```

`PopupMenu` (`packages/admin/src/components/pickers/PopupMenu.tsx`) is the reference implementation: portaled to `document.body`, hardcoded background, viewport-clamped. New floating UI should reuse it rather than re-implementing the pattern.

---

## 3. Containing-block rule (portal floating overlays to `document.body`)

`position: fixed` is relative to the viewport **unless** an ancestor has any of:

- `transform: …` (anything non-`none`)
- `filter: …` / `backdrop-filter: …`
- `perspective: …`
- `will-change: transform` / `will-change: filter`
- `contain: layout` / `contain: paint` / `contain: strict`

Inside the admin SPA, several common ancestors hit at least one of these (popout drawers, CoS bubble animations, pane resize transforms). The result: a `position: fixed; inset: 0` lightbox or popup gets **clipped to the ancestor's box** instead of covering the viewport.

**Rule:** any overlay that should cover the whole viewport — modals, lightboxes, full-screen pickers, the spotlight — **must** be rendered to `document.body` via `createPortal` from `preact/compat`. Local-jsx rendering inside the component tree is a bug.

```ts
import { createPortal } from 'preact/compat';

return (
  <>
    <button onClick={() => setOpen(true)}>Open</button>
    {open && createPortal(
      <div class="sm-lightbox" onClick={() => setOpen(false)}>
        {/* … */}
      </div>,
      document.body,
    )}
  </>
);
```

Reference call sites: `PopupMenu`, `QuickDispatchPopup`, `SpecUpdateComposer`, `CosPopoutTreeView` overlay rect, `UnifiedComposer` expand menu, `CosMessageAttachments` lightbox, `MessageRenderer` image lightbox, `FeedbackDetailPage` screenshot lightbox.

---

## 4. Lightboxes / full-viewport modals (`.sm-lightbox`)

Specific to image lightboxes and the screenshot viewer:

- Backdrop: hardcoded **`#0b1220`** (opaque). Older `rgba(0,0,0,0.85)` caused text bleed-through when the lightbox was rendered inside `.cos-popout`.
- Must be **portaled to `document.body`** — not rendered as a sibling of the thumbnail.
- Close on backdrop click + `Esc` key (with `capture: true` so it beats inner handlers).
- Close button sits at top-right of the content, hardcoded surface color.
- Three current call sites and the canonical CSS class live together — when fixing one, audit all three:
  - `packages/admin/src/components/cos/CosMessageAttachments.tsx`
  - `packages/admin/src/components/terminal/MessageRenderer.tsx`
  - `packages/admin/src/pages/FeedbackDetailPage.tsx`
  - CSS: `packages/admin/src/app.css` (`.sm-lightbox`, `.sm-lightbox-content`, `.sm-lightbox-close`, `.sm-lightbox-toolbar`)

---

## 5. Color palette (dark theme, default)

The admin defaults to a dark theme. Hardcoded paints (not tokens) when you need solid color for a floating element:

| Use | Hex |
|---|---|
| Popup / menu / dropdown surface | `#1e293b` |
| Modal / lightbox backdrop (full viewport) | `#0b1220` |
| Card / panel surface in dark scope | `#0f172a` (or `var(--pw-bg-surface)` only if inline) |
| Border (subtle) | `#1e293b` |
| Border (visible) | `#334155` |
| Text primary | `#e2e8f0` |
| Text secondary | `#94a3b8` |
| Text muted | `#64748b` |
| Accent (links, focus, active pill) | `#1d9bf0` |
| Draft / warning highlight | `#fbbf24` (text), `rgba(245, 158, 11, 0.65)` (underline) |
| Drop-target hover | `rgba(74, 144, 226, 0.55)` w/ glow shadow |

These are not aesthetic preferences — they're the values already in `app.css` that floating overlays must match so they read as part of the same surface family.

---

## 6. Other UI conventions (cross-listed)

- **No `window.prompt` / `alert` / `confirm`.** Use modals (portaled, opaque) or the `TerminalPicker` spotlight (`packages/admin/src/components/TerminalPicker.tsx`). [[CLAUDE.md UI Conventions]]
- **Strict lazy tab rendering** in `LeafPane` / `GlobalTerminalPanel` / `PopoutPanel` — only mount the active tab. Never `display: none` siblings. [[CLAUDE.md UI Conventions]]
- **Tree commits go through `commitTree()`** (RAF-debounced in `pane-tree.ts`). Never set `layoutTree.value` directly outside `commitTree` or `batch`. [[CLAUDE.md UI Conventions]]
- **URL input** → `TerminalPicker` in `{ kind: 'url' }` mode via `termPickerOpen.value`.
- **Companion / new terminal selection** → `TerminalPicker` in `{ kind: 'companion', sessionId }` or `{ kind: 'new' }`.
- **Screenshot ground truth** → `pw screenshot` / `pw-vnc screenshot`, never the widget's html-to-image. [[feedback_use_playwright_screenshots]]

---

## 7. Checklist for any new floating UI

Before merging a PR that adds a popup, menu, dropdown, modal, lightbox, tooltip with body text, or overlay:

- [ ] Background is a hardcoded opaque hex (no `--pw-bg-*`, no `rgba(…, <1)`).
- [ ] Rendered via `createPortal(…, document.body)` if it should cover beyond its parent's box.
- [ ] Has a visible border or shadow against the page.
- [ ] Closes on `Esc` and outside-click.
- [ ] Reuses `PopupMenu` / `TerminalPicker` if the shape matches.
- [ ] Verified visually with `pw screenshot` (or `pw-vnc`) inside `.cos-popout` — that's the scope that reveals bleed-through.
- [ ] No regression in mobile viewport — check `.mobile-page-view` styles.

Skipping the last two is the single biggest source of recurring opacity tickets. The bug is almost never "the color is wrong"; it's "the color works at root but not when the component renders inside a CoS popout."
