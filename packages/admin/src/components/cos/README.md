# Chief of Staff (CoS) Components

The `/src/components/cos/` directory contains the UI layer for the **Chief of Staff** — a draggable floating chat overlay for orchestrating agent sessions. This system supports multi-agent workflows, per-thread conversations, draft persistence, attachments, voice input, and popout/inline pane modes.

## Purpose

The Chief of Staff bubble is a draggable, always-available chat interface that allows operators to:
- Manage multiple agent instances with per-agent system prompts, verbosity, and tone settings
- Compose and send messages with screenshots, element references, browser context (console/network/perf), and voice input
- Organize conversations into threads with automatic grouping or Slack-mode side panels
- Save drafts at multiple scopes (global, per-thread, per-app) and queue follow-up messages
- Search messages, toggle tool visibility, collapse/expand threads, and filter by thread status
- Pop out conversations into external windows/tabs or dock into the main pane tree

The bubble ships in two layouts:
- **Popout mode** (`mode='popout'`): Floating, draggable, resizable panel with its own local pane-tree for artifacts, learnings, and thread panels
- **Pane mode** (`mode='pane'`): Docked into the main `layoutTree` as a splittable pane (shift-click the toggle)

## Entry Points

The public API is minimal. From outside this directory:

| Entry Point | Export | Use Case |
|---|---|---|
| `ChiefOfStaffToggle()` | ChiefOfStaffBubble.tsx:153 | Button to open/close the bubble (shown in control bar) |
| `ChiefOfStaffBubble()` | ChiefOfStaffBubble.tsx:234 | Renders the full bubble UI (root mount point) |

Everything else is internal to CoS:
- `CosComposer`, `CosMessage`, `CosThread` — message flow and composition
- `CosBubbleDrawers`, `CosThreadPanel`, `CosThreadRail` — thread UI and navigation  
- `CosAgentSettings`, `CosTabList` — agent switching and settings
- `CosPopoutTreeView`, `CosResizeHandles` — popout-mode pane layout and window chrome
- Helper lists: `CosSavedDraftsList`, `CosEnqueuedList`, `CosScrollToolbar`

## Component Map

| File | Role | Key Exports | Parent(s) |
|---|---|---|---|
| **ChiefOfStaffBubble.tsx** | Root container; owns active-agent state, thread grouping, search, draft scope, side drawers. Renders either pane or popout layout. | `ChiefOfStaffToggle()` (l:153), `ChiefOfStaffBubble()` (l:234), `CosMode` (l:232) | Mounted from root app; `ChiefOfStaffToggle` in control bar |
| **CosAgentSettings.tsx** | Settings pane (name, system prompt, verbosity, tone, history clear, agent reset). All state local; mutations dispatch through `lib/chief-of-staff.js`. | `CosAgentSettings()` (l:25) | ChiefOfStaffBubble (l:950+) |
| **CosAssistantContent.tsx** | Assistant message body: markdown → HTML, prose + artifact cards, session/URL click handlers, search highlighting. | `AssistantContent()` (l:101) | CosMessage (l:13) |
| **CosAttachmentEditor.tsx** | Modal for cropping/highlighting screenshots before sending. Wraps `@propanes/widget/image-editor`. | `AttachmentEditorModal()` (l:4) | ChiefOfStaffBubble (l:850+) |
| **CosBubbleDrawers.tsx** | Fixed-position side drawers (learnings, thread panel) in pane mode. Popout mode skips these. | `CosLearningsDrawer()` (l:28), `CosThreadDrawer()` (l:65) | ChiefOfStaffBubble (l:860+) |
| **CosBubbleHeader.tsx** | Drag-to-popout hamburger + window menu + close button for popout-mode tab bar. | `CosBubbleWindowControls()` (l:18) | ChiefOfStaffBubble (l:800+) |
| **CosComposer.tsx** | Textarea + pending attachments/element refs + voice/screenshot/element-picker hooks + input toolbar. Supports controlled text via draft binding. | `CosComposer` (l:139, forwardRef), `CosComposerDraftBinding` (l:55), `CosComposerHandle` (l:64), `CosComposerProps` (l:77) | ChiefOfStaffBubble (l:650+), ThreadPanel (l:30) |
| **CosEnqueuedList.tsx** | Queued-message list (queued + editing + sending states). Editable inline. Appears below drafts when follow-ups exist. | `CosEnqueuedList()` (l:16), `CosEnqueuedRow()` (l:40, internal) | ChiefOfStaffBubble (l:780+), ThreadPanel (l:16) |
| **CosInputToolbar.tsx** | Toolbar below textarea: camera (screenshot options), element picker, console/network/perf capture, mic (brainstorm mode), send/stop buttons. | `CosInputToolbar()` (l:26) | CosComposer (l:14) |
| **CosMessage.tsx** | Message row rendering: author avatar, timestamp, text + attachment preview, tool-call fallback. Exports helpers for highlight, timestamps, day dividers, agent avatars. | `MessageAvatar()`, `MessageBubble()` (main), `Timestamp()`, `HighlightedText()`, `dayKeyOf()`, `DayDivider()`, `getAgentAvatarSrc()` (l:23+) | ChiefOfStaffBubble, ThreadPanel |
| **CosMessageAttachments.tsx** | Image thumbnails (with lightbox) and DOM element-reference chips (with expand detail pane). Rendered inside MessageBubble. | `MessageImageThumb()`, `MessageElementChip()`, `MessageAttachments()` (l:143, public) | CosMessage.tsx re-exports it; ThreadPanel (l:29) |
| **CosPopoutTreeView.tsx** | Popout-local pane-tree layout: chat tab (non-closable) + learnings/artifact/thread tabs (closable, draggable). Renders via SplitPane. | `CosPopoutTreeView()` (l:45), `renderNode()`, `isFloatingSplit()` (internal) | ChiefOfStaffBubble (l:750+) |
| **CosResizeHandles.tsx** | Eight-direction resize handles (or subset for docked edges). Calls `onResizeStart(edge, event)`. | `CosResizeHandles()` (l:7) | ChiefOfStaffBubble (l:800+) |
| **CosSavedDraftsList.tsx** | Draft list (italic, dashed border). Click loads into composer; delete removes. Appears at thread/root level. | `CosSavedDraftsList()` (l:10) | ChiefOfStaffBubble (l:775+), ThreadPanel (l:38) |
| **CosScrollToolbar.tsx** | Top-of-chat toolbar: Tools toggle, collapse/expand, search, learnings button, options menu (Slack mode, resolved/archived filters, thread filters). | `CosScrollToolbar()` (l:28) | ChiefOfStaffBubble (l:700+) |
| **CosTabList.tsx** | Tab bar across bubble top: one tab per agent, "+" for new agent, Settings. Shows draft badge when agent has unsent text. | `CosTabList()` (l:11) | ChiefOfStaffBubble (l:600+) |
| **CosThread.tsx** | Thread grouping logic: `groupIntoThreads()` routes messages into Tree[] by threadId or replyToTs. `ThreadBlock` renders collapsed/expanded thread + replies. | `groupIntoThreads()` (l:53), `Thread` (l:35), `threadKeyOf()`, `ThreadBlock()` | ChiefOfStaffBubble (l:131, l:131, grouping logic), ThreadPanel (l:28) |
| **CosThreadPanel.tsx** | Slack-mode side panel for one thread. Streams JSONL transcript, groups into messages via `groupIntoThreads`, renders as slack-style rows. Shared composer wired to `sendChiefOfStaffMessage(replyToTs=...)`. | `ThreadPanel()` (l:56) | ChiefOfStaffBubble (l:132), CosBubbleDrawers (l:2) |
| **CosThreadRail.tsx** | Left-edge numbered nav rail with status dots + thread numbers + unread badges. Resolve/archive popup on double-click or status-pip click. | `CosThreadRail()` (l:53), `RailStatus` (l:13) | ChiefOfStaffBubble (l:136) |

## Data Flow

### State Architecture

State lives in three layers:

1. **Signals** (reactive store, survives page reload):
   - `lib/chief-of-staff.js`: `chiefOfStaffAgents` (agent list + messages), `chiefOfStaffActiveId`, `chiefOfStaffOpen`, `chiefOfStaffError`
   - `lib/cos-drafts.js`: `cosDrafts` (per-agent-app-thread text state)
   - `lib/cos-saved-drafts.js`: `cosSavedDrafts` (saved-draft metadata + contents)
   - `lib/cos-followups.js`: `cosFollowups` (queued follow-up messages)
   - `lib/cos-popout-tree.js`: `cosPopoutTree` (pane-tree layout for artifacts/threads in popout mode), `cosActiveThread` (currently viewing thread), `cosSlackMode`, `cosShowResolved`, `cosShowArchived`, `cosThreadFilter`
   - `lib/cos-artifacts.js`: `cosArtifacts` (code/table/markdown artifact registry for popout tabs)
   - `lib/cos-learnings.js`: `cosLearnings` (agent reflection learnings)

2. **Component State** (local to ChiefOfStaffBubble):
   - `composerText` — live copy of textarea for draft-save affordance (l:254)
   - `replyTo` — active "reply to thread" scope (l:256)
   - `showSettings` — settings tab active (l:257)
   - `collapsedThreads` — Set of userIdx keys for collapsed threads (l:260)
   - `showTools`, `showLearnings` — UI toggles (l:261, l:265)
   - `editingAttachment` — screenshot editor modal state (l:279)

3. **Component Props** (passed down through render tree):
   - Thread list, unread counts, rail status — derived from `chiefOfStaffAgents` + thread metadata
   - Composer text, attachments, element refs — owned by `CosComposer` and passed to `onSend` callback
   - Search filters, visibility filters — bubble state, applied during render

### Message and Draft Scopes

**Messages** live in `chiefOfStaffAgents[i].messages[]` — flat array grouped by `threadId` at render time via `groupIntoThreads()`.

**Drafts** have three scopes, all persisted via `cosDrafts` signal:
1. **Agent + App (global)** — new-thread compose (scope key: `agent.id` + `app.id` + `''`)
2. **Agent + App + Thread** — reply-in-thread compose (scope key: `agent.id` + `app.id` + `threadId`)
3. **Per-thread (ThreadPanel only)** — ephemeral to panel session (scope key: `agentId` + `threadKey`)

CosComposer drives all reads/writes through a `draft` binding object that encapsulates the scope logic; the caller doesn't see localStorage keys (e.g., ChiefOfStaffBubble l:326 sets up binding keyed by `draftScopeThreadId = replyTo?.threadServerId ?? ''`).

### Popout vs. Inline Pane Mode

**Popout mode** (`mode='popout'`):
- ChiefOfStaffBubble renders `<CosPopoutTreeView>` (l:750) with its own pane-tree layout signal
- Chat is always in the center; learnings, artifacts, thread panels float as draggable tabs
- Resize handles on all edges (or subset for docked orientation)
- Drag-to-popout hamburger header (CosBubbleWindowControls)

**Pane mode** (`mode='pane'`):
- ChiefOfStaffBubble renders the chat + tab list directly into a layout-tree leaf
- Learnings + thread panels render as fixed-position side drawers via CosBubbleDrawers (l:860)
- No resize handles or popout header; resize via main pane splitters
- Shift-click toggle docks CoS into the main tree or closes the docked pane

## Key Interactions

### Composer → Message Stream

1. Operator types in textarea, draft is auto-saved via `draft.write()` on input (CosComposer l:155+)
2. On Enter or click Send, `onSend()` is called with (text, attachments, elementRefs)
3. Bubble dispatches `sendChiefOfStaffMessage(text, attachments, ...)` (l:650+)
4. Composer is frozen (text intact, input disabled) until the message lands in the agent's transcript
5. On resolve, composer clears and draft is cleared

**Race condition gotcha** (l:650): if the user sends, then immediately clicks Send again before the first POST /chat lands, both payloads queue at the server. The second click unfreezes the composer too early. Guard: don't enable Send until `submitting` flag flips off (CosInputToolbar l:412).

### Draft Autosave & Reply Scope

- Main compose draft is scoped to `(agent, app, '')` and persists across browser reload
- When operator clicks "Reply to thread" (l:660), `replyTo` state flips and `draftScopeThreadId` becomes the thread's server ID
- The *same* CosComposer instance re-binds to a different draft scope (useMemo dependency l:332 includes `draftScopeThreadId`)
- Escape key with empty input (onEscapeWhenEmpty) drops reply scope and clears the reply-scoped draft

**Gotcha**: if the operator has a reply scope active and the thread gets deleted server-side, `cosActiveThread` clears and the reply scope is orphaned. Re-binding uses the now-null server ID. Guard: check `replyTo?.threadServerId` before reading draft (though CosComposer l:47 will just read empty string and treat it as main scope).

### Follow-up Queue

1. Operator composes a message while an agent turn is streaming
2. Click Send → message enqueued via `enqueueCosFollowup()` instead of sent immediately (CosInputToolbar l:413 checks `streaming` flag)
3. CosEnqueuedList renders queued messages with edit UI
4. When the current turn finishes (streaming flag clears), a background dispatcher auto-sends queued messages in order
5. While a row is in "editing" status, the whole group pauses

**Coordination**: `cosFollowups` signal is subscribed by the bubble (l:277) so the enqueued list re-renders on status changes. ThreadPanel has its own queue-send logic via `enqueueCosFollowup()` (l:14).

### Popout/Tree Mode Toggle

In popout mode, clicking "Learnings" or a thread reply button opens a tab in the popout-local pane-tree via `cosOpenThreadTab()` / `cosToggleLearningsTab()` (lib/cos-popout-tree.js).

In pane mode, the same actions toggle the side-drawer visibility (`showLearnings`, `showThreadPanel`) and compute drawer geometry (l:297).

The popout tree re-mounts when the bubble splits for a thread panel, which can cause scroll position to reset. Guard: `lastScrollTopRef` preserves scroll position across remounts (l:516).

### Drag/Drop Tabs In/Out

- `startCosTabDrag()` (lib/cos-tab-drag.js) intercepts drag on popout-tree tabs
- If drag crosses screen edge, `openCosExternally('new-window')` pops out a new browser window with `?embed=cos` (CosBubbleHeader l:60)
- Drop in non-edge zone opens a new tab in the same window
- Tabs can be dragged between leaves in the popout tree via the pane-tree split/merge logic

**Gotcha** (CosBubbleHeader l:40): 40px drag threshold before escalation. If the user clicks the hamburger to open the menu, then hovers, the menu stays open only if the drag hasn't triggered yet.

### Voice & Screenshot Attachments

- Screenshot: `useCosScreenshot()` (lib/use-cos-screenshot.js) handles capture via Display Media API or html-to-image
  - Timed capture (3s delay) via CosInputToolbar
  - Multi-screenshot mode (continuous capture until Stop)
  - Editor modal (`AttachmentEditorModal`) lets operator crop/highlight before sending
- Voice: `useCosVoice()` (lib/use-cos-voice.js) transcribes microphone input
  - Brainstorm mode: continuous transcription, chunks append to textarea as ~30s windows finalize
  - Normal mode: full recording on release
- Element picker: `useCosElementPicker()` (lib/use-cos-element-picker.js) captures DOM element metadata (selector, bounding rect, classes, text, attributes) on Escape key
- All three populate `CosComposer`'s internal `attachments` / `elementRefs` arrays, which flush on send

CosInputToolbar owns the dropdown menus for each tool's options (exclude widget, exclude cursor, method, etc.) and passes state down as props (l:26+).

## Gotchas

1. **cosMessages dropped when stream-json wraps at 120 cols** (CosThread.tsx, CosMessage.tsx):
   - When assistant messages arrive via streaming JSON chunks, the parser collects them in a `cosMessages` array
   - If a message's `text` field wraps at column 120, it can be split across chunks and a single-item array can become an empty stub
   - Guard: in `jsonlToCosMessages()` (lib/jsonl-to-cos.js), filter out empty messages and re-join chunked text

2. **Opaque background required for floating popups inside `.cos-popout` scope** (CSS):
   - CosBubbleWindowControls and CosInputToolbar menus use `position: fixed` + `z-index` to float above the chat scroll area
   - If a .cos-popout element has `background: transparent` or is nested inside a semi-transparent overlay, the menu gets clipped or hidden
   - Guard: ensure the popout bubble and chat scroll area both have explicit `background: var(--cos-bg, #1a1a2e)` or opaque color

3. **Hook order changes when isEmpty flips** (CosThreadPanel.tsx, l:86):
   - ThreadPanel has early return if `isEmpty = !agent || !active || !found` (l:86)
   - If that condition flips mid-render (e.g., thread gets unselected), React rules of hooks break
   - Guard: emit the close callback inside a useEffect (l:87) instead of directly in render logic

4. **Double-send race** (CosComposer.tsx, l:83):
   - If textarea isn't frozen immediately on Send, operator can hit Enter twice before `submitting` flag clears
   - Guard: CosInputToolbar disables Send button while `submitting` is true (l:412); CosComposer itself should also set `frozen` state on mount (l:143, covered)

5. **Search highlight drops when cosMessages is empty** (CosMessage.tsx):
   - HighlightedText component accepts `highlight` prop and wraps matches in `<mark>` tags
   - If the message text is empty, highlight is a no-op
   - Guard: check `searchHighlight && text.length > 0` before calling HighlightedText

6. **Thread panel scroll doesn't re-bind on remount** (ChiefOfStaffBubble.tsx, l:503):
   - When the popout tree splits to open a thread panel, Preact unmounts and remounts the chat scroll area
   - Event listeners (scroll position tracking, infinite-scroll loading) were bound to the old `.cos-scroll` DOM node
   - Guard: track `scrollEl` state in addition to ref (l:511), use it in useEffect dependencies (l:503+), and restore `lastScrollTopRef` on remount (l:548+)

7. **cosActiveThread not cleared when thread gets deleted** (CosThread.tsx, l:12):
   - If `cosActiveThread` points to a thread that gets archived/deleted server-side, and the operator is viewing it in a side panel, the thread disappears but `cosActiveThread` remains set
   - Guard: ThreadPanel checks `if (!found) onClose()` (l:88) to close the panel when the thread is no longer visible

8. **isEmpty hook order in ThreadPanel** (CosThreadPanel.tsx):
   - ThreadPanel has `isEmpty = !agent || !active || !found`, then immediately fires `useEffect(() => { if (isEmpty) onClose(); })` (l:87)
   - If the condition is true on mount, the onClose fires before the rest of render — the useEffect lands after JSX return but before React commits
   - Guard: make sure `onClose` is stable (memoized or defined outside render) so it doesn't re-trigger unnecessarily

9. **Draft scope confusion when switching agents mid-reply** (ChiefOfStaffBubble.tsx, l:320):
   - If operator starts a reply in Agent A, then clicks Agent B tab, `replyTo` scope is still active but `activeId` changed
   - The draft binding's key includes `activeId`, so switching agents clears the old binding
   - Guard: when agent tab is clicked, check if `replyTo` is set and handle scope cleanup (l:334 dependency includes `activeId`)

10. **Floating drawer z-index collision in pane mode** (CosBubbleDrawers.tsx):
    - Learnings and thread drawers are `position: fixed` with manually computed z-index
    - If another floating panel (e.g., a popout) raises above them, clicks pass through
    - Guard: `CosBubbleDrawers` computes zIndex relative to the panel's base z-order (l:46, from parent)

11. **learningsSide localStorage inconsistency** (ChiefOfStaffBubble.tsx, l:280):
    - Learnings drawer side is persisted to localStorage on flip (l:294)
    - If localStorage is disabled or quota exceeded, side defaults to 'left' but the state doesn't match
    - Guard: wrap localStorage reads/writes in try/catch (l:287, l:294)

12. **Element picker includes Playwright internals** (CosMessageAttachments.tsx, l:66):
    - DOM element refs are captured with `classes` array, which may include Playwright-injected classes like `pw-*`
    - These are filtered out in the header display (l:66) but still present in `attributes` expand view
    - Guard: if testing with Playwright, element refs will include extra metadata; filter on the test side if needed

---

## Summary

This directory is a complete, self-contained chat UI for orchestrating multi-agent conversations. The root `ChiefOfStaffBubble` owns high-level state (active agent, thread grouping, search, reply scope), while child components are pure/presentational or own narrow slices of state (composer text, toolbar dropdowns). Data flows from signals (persisted state) → component state → props → mutations that update signals. The system gracefully switches between popout (draggable, local tree) and pane (docked, side drawers) modes without duplicating logic.
