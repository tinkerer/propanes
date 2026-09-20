# Propanes Design Spec

Authoritative rules for visual design in this repo. Agents and contributors
MUST read this before introducing or changing any color, and MUST NOT add
colors outside the allowed palette without an explicit amendment to this file.

## 1. The Flame Palette

The ProPanes workspace uses neutral charcoal and warm-white surfaces, with
orange reserved for the small brand mark and navigation indicator. Avoid
blue-tinted surfaces, glowing controls and decorative accent-colored cards.
Blue remains available for meaningful information, not as a default wash.
No greens, purples, pinks, teals or cyans.

### 1.1 Allowed color families

| Family       | Role                                    | Hex anchors                            |
| ------------ | --------------------------------------- | -------------------------------------- |
| Black        | Pure black, overlays                    | `#000000`, `rgba(0,0,0,*)`             |
| Grey / neutral | Surfaces, text, borders, code blocks | `#111111` `#171717` `#202020` `#292929` `#353535` `#555555` `#737373` `#aaaaaa` `#d4d4d4` `#e5e5e5` `#efeeeb` `#f1f0ed` `#faf9f6` `#ffffff` |
| White        | Surfaces on light, text on dark         | `#ffffff`                              |
| Blue (flame) | Primary brand accent, info, links, "done" | `#1d9bf0` `#0f7ac7` `#38bdf8` `#60a5fa` `#93c5fd` `#bae6fd` `#e0f2fe` `#075985` `#0c4a6e` |
| Red (flame)  | Danger, destructive, errors             | `#dc2626` `#ef4444` `#fecaca` `#fef2f2` `#7f1d1d` `#450a0a` |
| Orange (flame) | Warning, active/ignite, "Cook It"      | `#f59e0b` `#fb923c` `#ffb347` `#fde68a` `#fef3c7` `#92400e` `#78350f` `#451a03` |
| Yellow (flame) | Highlight, attention, waiting-for-input | `#eab308` `#facc15` `#fcd34d` `#fef08a` `#fde047` `#a16207` |

These lists are anchors, not exhaustive. Neutral grey and warm-white shades,
`blue-*`, `red-*`, `orange-*`, or `amber/yellow-*` are acceptable. Existing
slate tokens may remain in terminal-specific surfaces during migration.
Any color that is clearly in a different hue family (green, purple,
pink, teal, cyan, magenta, indigo-leaning-purple) is NOT.

### 1.2 Disallowed families

The following hue families are **prohibited**:

- **Green**: running and successful states use labels, neutral indicators and shape.
- **Purple / Violet**: `#8b5cf6`, `#a78bfa`, `#5b21b6`, `#c4b5fd`, `#7e22ce`
- **Pink / Magenta / Rose**: `#f472b6`, `#9d174d`, `#ec4899`, `#fce7f3`
- **Teal / Cyan**: `#22d3ee`, `#2dd4bf`, `#5eead4`
- **Indigo** (the purple-leaning side): `#3730a3`, `#312e81`, `#4f46e5`
  — indigo that reads as blue (e.g., `#6366f1`) is a judgment call; prefer
  true blues like `#1d9bf0` or `#60a5fa` instead.

If you feel you need a color outside the allowed families to communicate
something (e.g., a new status), **do not add it**. Instead:

1. Re-use an existing semantic slot (danger, warning, info).
2. Distinguish by shape, icon, or weight — not hue.
3. If none of that works, open a design change and amend this file.

## 2. How to apply colors

### 2.1 Use the tokens, not raw hex

Admin UI colors live as CSS custom properties in
`packages/admin/src/app.css` under `:root` and
`html[data-theme="dark"]`. Components MUST reference these tokens:

```css
/* Good */
color: var(--pw-text-primary);
background: var(--pw-primary);

/* Bad */
color: #1a1a2e;
background: #1d9bf0;
```

Raw hex is only acceptable:

- Inside `:root` / `[data-theme="dark"]` token definitions.
- In the widget (`packages/widget/src/styles.ts`), which does not share
  the admin token system. Widget code still MUST stay within the flame
  palette above.
- In screenshots, SVGs, or emoji content.

### 2.2 Semantic slots

The token system has fixed semantic meanings. Do not repurpose them:

| Token family          | Meaning                                          |
| --------------------- | ------------------------------------------------ |
| `--pw-primary*`       | High-contrast neutral — primary buttons and focus rings; `--pw-primary-on` is the paired foreground |
| `--pw-danger*`        | Red — destructive actions, errors                |
| `--pw-warning*`       | Orange — warnings, pending, in-flight            |
| `--pw-success*`       | Positive/running state — neutral, distinguished by labels, icons and motion |
| `--pw-text-*`         | Greys for body/secondary/muted/faint text        |
| `--pw-bg-*`           | Neutral surfaces at various elevations          |
| `--pw-sidebar-*`      | Theme-aware workspace chrome: warm light grey or charcoal; restrained orange brand mark |
| `--pw-pty-*`, `--pw-terminal-*` | Independent dark PTY surfaces and paired light foreground; default `#171717`, selectable in Preferences |

### 2.3 Adding a new token

If a new surface, border, or accent is needed:

1. Add the variable to BOTH `:root` and `html[data-theme="dark"]`
   (and the `prefers-color-scheme: dark` fallback block) in
   `packages/admin/src/app.css`.
2. Pick a hex from section 1.1.
3. Reference the token, not the hex, from components.
4. Add a row to section 2.2 if it is a new semantic slot.

### 2.4 Activity / category badges

Many badges in the admin UI (activity badges, tool kind accents, widget
timeline badges) used to vary hue per category. Under this spec, category
differentiation MUST come from:

- **Label / icon** (primary differentiator)
- **Shape or border treatment**
- **Shade within the allowed palette** (e.g., different greys, different
  blue steps) — not hue jumps into green/purple/pink/teal.

## 3. Enforcement

- Before merging a change that touches CSS, `.tsx` `style=` props, or
  widget `styles.ts`, grep the diff for hex colors and verify each one is
  in an allowed family or is an existing token.
- `AGENTS.md` at the repo root points agents at this file. Do not remove
  that pointer.
- When an existing violation is discovered (green/purple/pink/teal in the
  codebase), prefer to fix it in the same PR touching that area rather
  than opening a sprawling refactor.

## 4. Amendments

### 19 September 2026: neutral workspace direction

Requested by the owner after review of the blue/slate design: the saturated
scheme felt generic and “vibe coded.” Use typography, spacing and borders for
hierarchy instead. Primary actions are charcoal on light backgrounds and
off-white on dark backgrounds; always pair them with `--pw-primary-on`.
Cards are flat, not glowing; tutorial steps use plain numbers rather than
colored tiles. Navigation uses a consistent stroke-icon family. This update
also resolves the older green exception in this document against AGENTS.md.
Legacy component-local colors should migrate as those components are edited;
do not mistake this workspace pass for a completed terminal/widget re-theme.

Amending this spec requires:

- A clear written reason in the PR description.
- Updates to both the allowed and disallowed lists so they stay
  consistent.
- Re-tokenization of any new hex values into `app.css`.

Do not add a color to the "allowed" list to retroactively justify a PR
you have already written.
