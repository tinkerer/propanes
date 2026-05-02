# `components/ui/`

Small primitives, toasts, isolated views, and editor helpers. Most are stateless or hold only
local state.

## Primitives

| File | Role | Key export |
|------|------|------------|
| `Tooltip.tsx:12` | Hover-delay tooltip; `position` prop = top/bottom/left/right | `Tooltip` |
| `Expandable.tsx:11` | Collapse/expand wrapper with "show more"; `ExpandableLines` truncates by line count | `Expandable`, `ExpandableLines` |
| `CopyCommand.tsx:10` | Button that copies text to clipboard with "Copied" feedback | `CopyCommand` |

## Notifications & overlays

| File | Role | Key export |
|------|------|------------|
| `NotificationCenter.tsx:22` | Modal center for plan reviews, Q&A, approvals, voice dispatch | `NotificationCenter` |
| `PerfOverlay.tsx:9` | Dev overlay showing perf entries, color-coded by duration | `PerfOverlay` |

> Other toasts live in `components/ai-assist/` (`HintToast`, `AutoFixToast`).

## Isolates & editor surfaces

| File | Role | Key export |
|------|------|------------|
| `MessageFixturesIsolate.tsx:75` | Test fixtures for the message renderer (bash, edit, ask-user-question, long output) | `MessageFixturesIsolate` |
| `SpecView.tsx:57` | Tokenizes feedback specs (`{{element:0}}`, `{{screenshot:id}}`) and renders inline or side-by-side | `SpecView`, `SpecToolbar` |
| `ElementCard.tsx:39` | Expandable element inspector (tag, id, classes, selector, attributes, styles) — used by `SpecView` | `ElementCard` |
| `CropEditor.tsx:13` | Image crop/highlight editor (widget capture pipeline) | `CropEditor` |
| `Guide.tsx` | User guide content blocks | `Guide` |

## State helpers

| File | Role | Key export |
|------|------|------------|
| `DeletedItemsPanel.tsx:30` | Tracks deleted items per-type via Preact signals; supports `purgeOne`/`purgeAll` | `DeletedItemsPanel`, `trackDeletion` |
| `RequestPanel.tsx:9` | App-request submission popover with suggestions/preferences | `RequestPanel` |

## Notes

- `NotificationCenter` supports 4 interactive payload kinds — see the discriminated union it imports.
- `ElementCard` exposes a "live tree traversal" mode when an active widget session is connected.
- `MessageFixturesIsolate` is reachable via `isolate:MessageFixtures` companion tab — useful when
  iterating on `terminal/MessageRenderer.tsx` without spinning up a real session.
