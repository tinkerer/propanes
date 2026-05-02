# Files Components

File tree explorer, git diff viewer, file preview overlays, and companion views for embedded file/terminal/artifact/iframe content.

## Purpose

The files subsystem provides:
- **FileTree** (`FileTree.tsx:34`) — interactive file browser for browsing project directory structure
- **GitChangesView** (`GitChangesView.tsx:36`) — git status display with inline diff viewing
- **FileViewerPanel** (`FileViewerPanel.tsx:126`) — draggable floating file preview windows
- **Companion Views** — tab renderers for files, terminals, artifacts, and iframes shown in split/docked panels

The system integrates with the pane tree via `CompanionType` enum and registered renderers.

## Component Map

| Component | Responsibility |
|-----------|-----------------|
| **FileTree** (`FileTree.tsx:34`) | Interactive file browser. Fetches directory listings via `api.browseFiles()` (line:49), manages expanded/collapsed state, caches results. Breadcrumbs allow navigation up the tree (line:137-150). Click file to open in companion via `openFileCompanion()` (line:100). Shows file icons and sizes. |
| **FileCompanionView** (`FileCompanionView.tsx:11`) | Tab renderer for viewing a single file in a companion pane. Fetches file via `api.readFile()` (line:39) or `api.readFileImage()` (line:36). Renders syntax-highlighted code (hljs, line:54-61) or markdown (marked, line:121), or images. Line selection with Shift+click range support (line:66-75). Copy buttons for path, lines, code. |
| **GitChangesView** (`GitChangesView.tsx:36`) | Standalone git status/diff viewer. Polls `api.gitStatus()` every 10s (line:60), shows changed files with status badges (M/A/D/R colors, line:12-28). Click file to view diff inline. Splits into file list and diff panel side-by-side. |
| **SidebarFilesDrawer** (`SidebarFilesDrawer.tsx:30`) | Sidebar panel combining FileTree tab and git changes tab. Manages tab switching and "Expand All" / "Collapse All" control. Wraps SidebarFileTree and SidebarGitChanges sub-components. |
| **FileViewerPanel** (`FileViewerPanel.tsx:8`) | Draggable floating window overlay. Manages multiple file viewers stacked with z-order. Each window is draggable by header (line:39-67), shows syntax-highlighted code or images, can be closed. Renders via `SingleFileViewer` loop (line:132-135). |
| **ArtifactCompanionView** (`ArtifactCompanionView.tsx:17`) | Tab renderer for viewing CoS-generated artifacts. Fetches from `cosArtifacts` signal (line:18). Renders code with hljs syntax highlight (line:26) or markdown. Has a copy button (line:69). Handles stale artifacts with grace period (line:42-50). |
| **IframeCompanion** (`IframeCompanion.tsx:4`) | Tab renderer for embedding external URLs. Renders `<iframe>` with sandbox (line:36-43). Has reload button (line:15-21) and "Open in new tab" link (line:26-34). Shows URL in toolbar. |
| **TerminalCompanionView** (`TerminalCompanionView.tsx:7`) | Tab renderer wrapping AgentTerminal component for a session. Minimal wrapper; delegates rendering to terminal module (line:9). |
| **FilesView** (`FilesView.tsx:4`) | Entry point for Files page. Renders SidebarFilesDrawer with app-specific browsing (line:15). |

## Companion Type System

Defined in `lib/companion-state.ts` (line:36):
```typescript
export type CompanionType = 'jsonl' | 'summary' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url' | 'file' | 'wiggum-runs' | 'artifact';
```

Companion tabs are created via `companionTabId(sessionId, type)` → `'type:sessionId'` (line:104 in companion-state.ts). The pane system extracts type via `extractCompanionType(tabId)` (line:114-120).

Registered renderers (in pane system, typically in PaneTree.tsx or similar) match companion types to components:
- `'file:...'` → FileCompanionView
- `'artifact:...'` → ArtifactCompanionView
- `'iframe:...'` → IframeCompanion
- `'terminal:...'` → TerminalCompanionView
- `'jsonl:...'` → JSONL stream viewer
- `'feedback:...'` → FeedbackCompanionView
- Others handled similarly in pane rendering

**Opening Companions**:
- `openFileCompanion(filePath)` (imported from sessions.js) opens a file tab
- `toggleCompanion(sessionId, type)` (from companion-state.ts) adds/removes a companion tab
- `companionTabId(sessionId, type)` constructs the tab ID for routing

## File Utilities

`lib/file-utils.ts` exports helpers:
- `getExt(path)` — extracts extension
- `getLanguage(ext)` — maps ext to hljs language
- `IMAGE_EXTS` / `MARKDOWN_EXTS` — Set<string> of recognized extensions
- `shortenPath(path)` — truncates path for display

## Gotchas

- **File Picker Cache**: FileTree maintains a cache in `useRef` (line:41) to avoid re-fetching expanded directories on re-render. Cache persists across component lifecycle.
- **Git Polling**: GitChangesView polls every 10s but respects `document.hidden` (line:60) to avoid unnecessary API calls when tab is backgrounded.
- **Stale Artifacts**: ArtifactCompanionView checks if artifact is in registry and waits 1.5s before closing a stale tab (line:42-50). This handles the case where JSONL parsing is slow.
- **Portal Z-Stacking**: FileViewerPanel uses separate z-order tracking (line:104-105) via `fileViewerZOrders` signal. Each new panel gets a higher z-index.
- **Dragging UX**: FileViewerPanel's drag handler prevents movement if the mouse is over a button, ensuring buttons don't trigger drag (line:40).
- **Breadcrumb Navigation**: FileTree's breadcrumb click calls `navigateTo()` which is async, but UI updates synchronously via state (line:55-75).
- **SidebarFileTree Expand-All**: The expand-all operation is batched in 10-file chunks to avoid overwhelming the network (line:144-158 in SidebarFilesDrawer).

## File Viewer Overlay State

FileViewerPanel uses global state from `lib/file-viewer.js`:
- `fileViewerPanels.value` — array of panel objects (path, content, imageUrl, loading, error, etc.)
- `closeFileViewer(path)` — removes a panel
- `updateFileViewer(path, updates)` — updates panel state
- `bringFileViewerToFront(path)` — raises z-index
- `getFileViewerZIndex(path)` — reads current z-index

This allows independent file viewers to be opened and managed without coupling to the pane tree.

