# Feedback Components

Feedback list/detail rendering, conversation threading, feedback aggregation wizard, and channel organization proposal modal.

## Purpose

The feedback subsystem bridges the ProPanes ticket database with Chief-of-Staff (CoS) threads, showing operator feedback items and enabling clustering/tagging operations. Components render feedback items, their linked CoS thread conversations, and AI-assisted modal UIs for clustering feedback and proposing channel organization.

## Component Map

| Component | Responsibility |
|-----------|-----------------|
| **FeedbackConversation** (`FeedbackConversation.tsx:105`) | Renders the CoS thread linked to a feedback item. Fetches thread + messages via `api.getThreadByFeedbackId()` (line:116), displays message history with markdown rendering (marked + hljs), mints a thread on demand for legacy items (line:126), and allows operators to post notes via `api.postThreadNote()` (line:165). Polls every 5s to surface streamed agent replies (line:155). Shows a "Draft" / "Replied" / "Completed" badge. |
| **FeedbackCompanionView** (`FeedbackCompanionView.tsx:3`) | Iframe that loads the feedback detail page in companion mode. Constructs route like `/app/:appId/tickets/:fbId` or `/tickets/:fbId` and embeds it as `<iframe src="/admin/?companion=true#...">` (line:12). Used by pane system to show feedback in split/floating panels. |
| **UnifiedComposer** (`UnifiedComposer.tsx:102`) | Shared text/attachment composer used by both CoS thread replies and session interrupt prompts. Props include `onSubmit` callback, placeholder, submitTitle, optional draftKey for autosave, and optional error display. Supports: textarea with auto-grow (cap 140px, line:166), paste-image capture (line:272-281), screenshot (html-to-image or display-media), DOM element picker (multi-select, line:302-321), console capture (line:323-327), and voice recording (line:329-361). Attachments render as chips (line:445-532). Menu anchors above submit group using portal (line:579). Draft autosave/restore via `/api/v1/admin/drafts/:key` with 300ms debounce (line:188-201). Returns `UnifiedComposerData` (text, images, imageNames, elements, consoleEntries, voice). |
| **AggregateWizard** (`AggregateWizard.tsx:11`) | Multi-step modal UI for clustering feedback items. Shows checkbox for "skip already-aggregated", runs `api.clusterAndTag()` (line:28), displays results (number of clusters, items tagged, theme tags found). Operator can click theme tags to filter by tag and close wizard (line:80). Two-panel design: config panel before run, results panel after. |
| **ChannelOrgProposalModal** (`ChannelOrgProposalModal.tsx:33`) | Modal showing pending auto-organize proposal from CoS. Fetches proposal via `api.listOrgProposals()` (line:45), displays reasoning and proposed channels (color-coded by kind: prod=#ef4444, staging=#eab308, exploratory=#22c55e). Operator can Apply (calls `api.applyOrgProposal()` + reloads channels, line:157) or Reject (line:138). |

## UnifiedComposer Props & Responsibilities

**Props** (`UnifiedComposerProps`, line:37-54):
- `onSubmit: (data: UnifiedComposerData) => Promise<void>` — caller receives structured attachments and can serialize as needed
- `placeholder: string` — textarea placeholder
- `submitTitle: string` — button title (e.g., "Send reply")
- `submitIcon?: 'send' | 'interrupt'` — currently unused visually (always renders send icon)
- `disabled?: boolean` — disables textarea and buttons
- `draftKey?: string` — optional key for autosave/restore (e.g., `'interrupt:sessionId'`)
- `initialText?: string` — seed textarea text
- `className?: string` — outer container class (e.g., `'interrupt-bar'` for styling reuse)
- `error?: string | null` — external error to display inline
- `onEscapeWhenEmpty?: () => void` — when operator presses Escape on empty textarea (used by thread panel to pop scope)
- `rows?: number` — initial textarea rows (default 1)

**Attachments**:
- **Screenshot**: Captures via `captureScreenshot()` from @propanes/widget, with options for method (html-to-image or display-media), exclude cursor, exclude widget (line:601-626)
- **DOM Element Picker**: Uses `startPicker()` from @propanes/widget to select page elements, with options for multi-select, include children, exclude widget (line:630-670)
- **Console Capture**: Calls `snapshotConsole()` from console-buffer (line:323-327), captures console entries at snapshot time
- **Voice**: Uses `VoiceRecorder` from @propanes/widget, optional screen captures during recording (line:688-714)

**InterruptBar vs. CosComposer**: UnifiedComposer is shared between InterruptBar (terminal suspend/resume, in terminal/ folder) and CosComposer (thread replies in Chief-of-Staff). InterruptBar receives onSubmit and uploads images to `/api/v1/screenshots`, embedding URLs in resume prompt. CosComposer hands attachments to `sendChiefOfStaffMessage` which packs dataUrls into the thread message.

## FeedbackConversation vs. FeedbackCompanionView

- **FeedbackConversation** (line:105): Renders thread inline on FeedbackDetailPage. Direct API calls, markdown rendering, message history. Component props: `feedbackId` and `appId`.
- **FeedbackCompanionView** (line:3): Iframe wrapper that loads the full feedback detail page in companion/split-pane mode. Used by the main pane system to embed feedback in panels. Props: just `feedbackId`.

The distinction: detail pages use FeedbackConversation; pane companions use FeedbackCompanionView to avoid embedding FeedbackDetailPage twice.

## AggregateWizard Multi-Step UI

1. **Before Run** (line:37-65): Config panel shows description ("Cluster tickets by title similarity and tag them with theme labels"), checkbox for "Skip already-aggregated items", error message slot, and two buttons (Cancel, Run)
2. **After Run** (line:66-92): Results panel shows summary ("Found N clusters, tagged M items"), list of theme tags as clickable buttons (line:75-85), and "Done" button. Operator clicks a tag to filter by tag and close wizard.

## Gotchas

- **Thread Minting**: FeedbackConversation has a "Create thread" button for legacy feedback items that predate the CoS bridge (line:185-200). The mint endpoint accepts `?mint=1` (line:132).
- **Draft Autosave**: UnifiedComposer debounces draft saves by 300ms (line:191) and clears the draft on submit (line:404). Empty text deletes the row server-side.
- **Companion Escapes**: UnifiedComposer's onEscapeWhenEmpty callback (line:420-427) allows the calling scope (e.g., thread reply panel) to bounce back up the hierarchy when Escape is pressed.
- **Portal Menu**: The expand menu is rendered via `createPortal()` to document.body (line:579) so it escapes the textarea's overflow hidden. Menu position is computed in useLayoutEffect (line:218-239).
- **Stale Artifacts**: ArtifactCompanionView (in files/) uses a grace period (1.5s timeout, line:44-49) before quietly closing a tab if the artifact isn't in the registry yet, avoiding flash-of-error for slow JSONL parsing.

