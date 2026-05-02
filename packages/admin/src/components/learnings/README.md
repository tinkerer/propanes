# `components/learnings/`

Wiggum learnings knowledge base — AI-generated insights extracted from agent sessions
(pitfalls, suggestions, tool gaps), stored as a queryable graph with typed links.

| File | Role | Key export | Mounted by |
|------|------|------------|------------|
| `LearningsDrawer.tsx:25` | List + small force-directed graph view; lazy loads graph on demand | `LearningsPanel` | settings page, Wiggum panel |
| `LearningDetail.tsx:21` | Detail view: inline edit, tags, and typed links (related / caused_by / resolved_by / duplicate_of) with a candidate picker | `LearningDetailView` | `LearningsPanel` via `setDetailId` |

## Notes

- Learnings are grouped by `type` (`pitfall`, `suggestion`, `tool_gap`) and ranked by severity.
- Graph layout caps at 80 nodes for performance; the full graph is paginated/filtered.
- Learnings are produced by background jobs after CoS sessions close. The drawer mostly reads;
  the detail view is the only place edits happen.
- Related to `cos/CosBubbleDrawers.tsx` (`CosLearningsDrawer`) which is a CoS-side drawer; the two
  share API but are separate components.
