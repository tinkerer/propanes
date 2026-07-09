# Dispatch Components

Surfaces for creating new agent sessions against feedback. Entry points range from full dialog (DispatchDialog) to quick inline popup (QuickDispatchPopup) to setup wizard (SetupAssistantDialog).

## Purpose

These components enable dispatching feedback (tickets, screenshots, notes) to agent endpoints with optional custom instructions. Three main surfaces:

1. **DispatchDialog** — modal with 7+ action modes (Cook It, YOLO, Wiggum, FAFO, Structured, Powwow, Setup Assistant); target selector (local/remote/harness/sprite); fine-tune agent picker
2. **QuickDispatchPopup** — lightweight floating panel for creating feedback + dispatch inline; draft persistence; image paste; dispatch type selector (agent/yolo/wiggum/fafo/structured/powwow)
3. **SetupAssistantDialog** — Q&A wizard for setup tasks (plan first, test strategy, branch strategy, run mode); collects answers, builds instructions, dispatches

## Component Map

| File | Role | Exports | Mounted |
|------|------|---------|---------|
| **DispatchDialog.tsx:23** | Modal dispatch UI with 7 action buttons; target picker; agent override; inline feedback form | `DispatchDialog()` (via signal dispatchDialogOpen) | Overlay; triggered by sidebar feedback context menu |
| **DispatchPicker.tsx:25** | Modal searchable picker for dispatch targets (local, remote machines, harnesses, sprites); setup shortcuts | `DispatchPicker()` | Child of DispatchTargetButton; also internal to DispatchDialog |
| **DispatchTargetSelect.tsx:58** | Simple HTML select for dispatch target (no modal; for smaller contexts) | `DispatchTargetSelect()` | Setup Assist dialog + others |
| **QuickDispatchPopup.tsx:83** | Floating panel for draft feedback + dispatch; draggable, dismissible, auto-save draft; image paste | `QuickDispatchPopup()` | Rendered via portal; shown/hidden by SessionsListView (+) button |
| **SetupAssistButton.tsx:55** | Small icon button (wrench icon) for opening SetupAssistPopover; contextual presets for entity (machine/harness/agent/sprite) | `SetupAssistButton()` | `/settings/*` pages (machines, harnesses, agents, sprites) |
| **SetupAssistantDialog.tsx:58** | Large modal wizard with 4 choice groups (plan first, test strategy, branch strategy, run mode) + optional instructions + target selector | `SetupAssistantDialog()` (via signal setupAssistantOpen) | Overlay; triggered by DispatchDialog "Setup Assistant" button or standalone |

## DispatchDialog vs DispatchPicker vs QuickDispatchPopup

**DispatchDialog** (`src/components/dispatch/DispatchDialog.tsx:23`):
- Full modal experience; 7 large action buttons (Cook It, YOLO, Wiggum, FAFO, Structured, Powwow, Setup Assistant)
- Shows instructions textarea + target selector chip
- Fine-tune section: agent override dropdown
- Batch dispatch: multiple feedbackIds
- Opens via signal from sidebar feedback row context menu

**DispatchPicker** (`src/components/dispatch/DispatchPicker.tsx:25`):
- Searchable spotlight modal (similar to IDE command palette)
- Targets only (local, machines, harnesses, sprites, setup shortcuts)
- No dispatch modes; picker just selects target then calls onSelect(launcherId)
- Used by DispatchTargetButton (small button UI) and inside DispatchDialog topbar

**QuickDispatchPopup** (`src/components/dispatch/QuickDispatchPopup.tsx:83`):
- Floating panel (not modal overlay); draggable by header; closes on Escape or click-away
- **Draft persistence**: saves to localStorage per appKey on every keystroke (text, dispatchType, agentId)
- **Image paste**: Ctrl+V pastes images from clipboard; each image → blob → uploaded after feedback creation
- Dispatch types: agent, yolo, wiggum, fafo, structured, powwow (6 buttons in footer)
- Agent select dropdown (YOLO can use Auto via pickYoloAgent or an explicit endpoint override)
- For app sessions sidebar (+) button; one popup instance per app

## SetupAssist* — Admin Setup Wizard

**SetupAssistButton** (`src/components/dispatch/SetupAssistButton.tsx:55`):
- Wrench icon button; hovers near entity name on `/settings/machines`, `/settings/harnesses`, etc.
- Opens SetupAssistPopover with contextual presets (e.g., for a machine: full provisioning, launcher deploy, hardware investigation + tag)
- Click a preset → calls `api.setupAssist({ request, entityType, entityId })` → opens session
- For new entity (entityId undefined), shows different presets (e.g., "Add & setup remote machine" vs "Verify this machine")

**SetupAssistantDialog** (`src/components/dispatch/SetupAssistantDialog.tsx:58`):
- 4 choice groups (radio-button-style options):
  1. **Plan first?** — plan_first (write PLAN.md, wait approval) or just_code (start implementing)
  2. **Test strategy** — user_tests (manual), playwright (e2e), isolated_harness (Docker)
  3. **Branch strategy** — current_branch (commit), new_branch_pr (fresh branch + gh pr), new_worktree_pr (isolated worktree)
  4. **Run mode** — interactive (prompt for perms) or yolo (skip perms)
- Optional extra instructions textarea
- Target selector chip (local/machine/harness/sprite)
- Hint: if tests=isolated_harness but target=Local, shows "pick a Harness target" hint
- Dispatch: calls `api.dispatch()` with full instructions built from answers + template + user instructions

## Key Dispatch Modes

All dispatch actions call `api.dispatch({ feedbackId, agentEndpointId, instructions, launcherId?, harnessConfigId? })`:

- **Cook It** (interactive) — requires interactive-require agent; user approves each tool
- **YOLO** (interactive-yolo) — skips permission prompts; Auto picks via pickYoloAgent, explicit agent selection overrides the endpoint
- **Wiggum** — meta-wiggum template; creates iterative refinement via feedback/screenshot
- **FAFO** — FAFO_ASSISTANT_TEMPLATE; evolutionary search with multi-path support
- **Structured** — STRUCTURED_MODE_TEMPLATE; output structured JSON/XML
- **Powwow** — multi-agent compare; requires 2+ agents; picks moderator + participants
- **Setup Assistant** — Q&A wizard (plan/test/branch/run) that builds comprehensive instructions

## Gotchas

1. **YOLO auto-picks profile** (`QuickDispatchPopup.tsx`, `DispatchDialog.tsx`):
   - YOLO Auto calls `pickYoloAgent(agents, appId)`; explicit agent selections are honored
   - pickYoloAgent cycles through profiles: interactive-yolo → headless-yolo → headless-stream-yolo
   - Per CLAUDE.md PERMISSION_PROFILES section: yolo profiles skip permission prompts
   - Useful for unattended runs but dangerous if agent is not vetted

2. **Draft persistence in QuickDispatchPopup** (`src/components/dispatch/QuickDispatchPopup.tsx:173`):
   - Draft auto-saved to localStorage on every change (text, dispatchType, agentId)
   - Draft cleared only on successful submit or via "Clear" button
   - Dismissing the popup (Escape, click-away) does NOT clear; draft persists
   - User can see leftover draft when reopening popup for same appKey

3. **Image uploads in QuickDispatchPopup** (`src/components/dispatch/QuickDispatchPopup.tsx:255`):
   - Creates feedback first (title/desc/appId) → gets feedbackId
   - Then uploads images in parallel via `api.saveImageAsNew(fb.id, blob)`
   - If image upload fails, dispatch continues but images are missing
   - Each blob gets Object URL; cleanup in useEffect return

4. **SetupAssistantDialog target hint** (`src/components/dispatch/SetupAssistantDialog.tsx:112`):
   - If tests=isolated_harness but target is Local, shows warning: "Tip: pick a Harness target..."
   - This is a UX hint only; dispatch still works with Local target (just not isolated)

5. **Batch dispatch in DispatchDialog** (`src/components/dispatch/DispatchDialog.tsx:214`):
   - Loop over req.feedbackIds; dispatch each with same instructions/agent/target
   - Only opens first session if !isBatch (single feedback opens session, batch is silent)
   - Powwow mode runs loop too (one powwow per feedbackId)

6. **Agent filtering** (`src/components/dispatch/DispatchDialog.tsx:45`):
   - `isAgentUsable(a)`: excludes webhook agents with no URL (mode=webhook && !url)
   - Prevents silent failures from misconfigured endpoints

7. **DispatchTargetSelect vs DispatchPicker**:
   - DispatchTargetSelect is a plain `<select>` element; used where modal is not desired
   - DispatchPicker is a searchable spotlight modal with setup shortcuts; richer UX
   - Internal toggle: DispatchDialog uses DispatchPicker in chip; SetupAssistantDialog uses plain select in popover

8. **SetupAssistPopover positioning** (`src/components/dispatch/SetupAssistButton.tsx:84`):
   - Tries to center on trigger button horizontally, above vertically
   - Falls back to below if no room above
   - Clamped to viewport with 8px padding to avoid overflow
   - Draggable by header (onMouseDown handler)
