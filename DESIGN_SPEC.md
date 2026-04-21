# Propanes Design Spec

Authoritative rules for visual design in this repo. Agents and contributors
MUST read this before introducing or changing any color, and MUST NOT add
colors outside the allowed palette without an explicit amendment to this file.

## 1. The Flame Palette

The propanes brand is "flame on slate": a dark/light slate-grey base with
a narrow set of warm accents, plus a green reserved for the running/active
indicator. No purples, no pinks, no teals, no cyans.

### 1.1 Allowed color families

| Family       | Role                                    | Hex anchors                            |
| ------------ | --------------------------------------- | -------------------------------------- |
| Black        | Pure black, overlays                    | `#000000`, `rgba(0,0,0,*)`             |
| Grey (slate) | Surfaces, text, borders, code blocks    | `#020617` `#0f172a` `#1e293b` `#334155` `#475569` `#64748b` `#94a3b8` `#cbd5e1` `#e2e8f0` `#f1f5f9` `#f8fafc` `#ffffff` |
| White        | Surfaces on light, text on dark         | `#ffffff`                              |
| Blue (flame) | Primary brand accent, info, links, "done" | `#1d9bf0` `#0f7ac7` `#38bdf8` `#60a5fa` `#93c5fd` `#bae6fd` `#e0f2fe` `#075985` `#0c4a6e` |
| Red (flame)  | Danger, destructive, errors             | `#dc2626` `#ef4444` `#fecaca` `#fef2f2` `#7f1d1d` `#450a0a` |
| Orange (flame) | Warning, active/ignite, "Cook It"      | `#f59e0b` `#fb923c` `#ffb347` `#fde68a` `#fef3c7` `#92400e` `#78350f` `#451a03` |
| Yellow (flame) | Highlight, attention, waiting-for-input | `#eab308` `#facc15` `#fcd34d` `#fef08a` `#fde047` `#a16207` |
| Green        | Running / active / healthy / success    | `#22c55e` `#16a34a` `#86efac` `#bbf7d0` `#dcfce7` `#14532d` |

These lists are anchors, not exhaustive. Any `slate-*`, `blue-*`, `red-*`,
`orange-*`, `amber/yellow-*`, or `green-*` step from the Tailwind scale is
acceptable. Any color that is clearly in a different hue family (purple,
pink, teal, cyan, magenta, indigo-leaning-purple) is NOT.

### 1.2 Disallowed families

The following hue families are **prohibited**:

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
| `--pw-primary*`       | Brand blue — links, primary buttons, focus rings |
| `--pw-danger*`        | Red — destructive actions, errors                |
| `--pw-warning*`       | Orange — warnings, pending, in-flight            |
| `--pw-success*`       | Positive/running state — green (`#22c55e`). Historical note: briefly flame-yellow, reverted to green. |
| `--pw-text-*`         | Greys for body/secondary/muted/faint text        |
| `--pw-bg-*`           | Slate surfaces at various elevations             |
| `--pw-sidebar-*`      | Dark slate chrome; `--pw-sidebar-title` is orange (`#ffb347`) — this is the flame brand mark |

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

Amending this spec requires:

- A clear written reason in the PR description.
- Updates to both the allowed and disallowed lists so they stay
  consistent.
- Re-tokenization of any new hex values into `app.css`.

Do not add a color to the "allowed" list to retroactively justify a PR
you have already written.
