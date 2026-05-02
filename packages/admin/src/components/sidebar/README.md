# `components/sidebar/`

Navigation sidebar and global Cmd+K spotlight search.

| File | Role | Key export | Mounted by |
|------|------|------------|------------|
| `SidebarNavView.tsx:182` | App nav list, channels, settings sections, live-connections section | `SidebarNavView` | `shell/Layout` |
| `SpotlightSearch.tsx:46` | Cmd+K global search across apps, feedback, sessions, CoS messages | `SpotlightSearch` | global keyboard handler in `shell/App` |

## Notes

- `SidebarNavView` polls approval counts every 30s, manages app/channel selection, and includes the
  settings/admin tree.
- `SpotlightSearch` has an "advanced" mode that searches JSONL transcripts and error logs, and can
  hand off matched errors to the AI assist for analysis (see `components/ai-assist/`).
- Both rely on Preact signals from `lib/state.ts` and `lib/settings.ts`. Recent search results are
  persisted in `settings.recentResults`.
