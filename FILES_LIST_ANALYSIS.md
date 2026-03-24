# Files List and File Browser Analysis - Prompt Widget Admin UI

## Overview
The prompt-widget admin UI has TWO separate file browsing/viewing systems:

1. **File Viewer Panels** - Floating fixed-position panels that appear on top of the UI (z-index: 8000)
2. **File Companion Tabs** - Integrated tabs in the pane tree system (z-index: 950 when in split mode)

---

## SYSTEM 1: FILE VIEWER PANELS (Floating Panels)

### Where Files Are Listed
- **Component**: `/packages/admin/src/components/FileTree.tsx`
- **Container**: `/packages/admin/src/pages/FileBrowserPage.tsx`
- **Related View**: `/packages/admin/src/components/FilesView.tsx` (sidebar integration)
- **Drawer Version**: `/packages/admin/src/components/SidebarFilesDrawer.tsx`

### What Happens When File is Clicked

```
FileTree.tsx:98-101:
function handleFileClick(filePath: string) {
  const absPath = `${projectDir}/${filePath}`;
  openFileViewer(absPath);  // From file-viewer.ts
}
```

The `openFileViewer()` function:
- **Source**: `/packages/admin/src/lib/file-viewer.ts`
- Creates floating fixed-position panel that displays file content
- Adds file to `fileViewerPanels` signal (state management)
- Triggers load of file content (images, code with syntax highlighting, markdown)

### Panel Management

**File Viewer State**:
```typescript
// packages/admin/src/lib/file-viewer.ts
export interface FileViewerState {
  path: string;
  content?: string;
  imageUrl?: string;
  loading: boolean;
  error?: string;
}
export const fileViewerPanels = signal<FileViewerState[]>([]);

export function openFileViewer(path: string) {
  const existing = fileViewerPanels.value.find(p => p.path === path);
  if (existing) return;  // No duplicates
  fileViewerPanels.value = [...fileViewerPanels.value, { path, loading: true }];
}

export function closeFileViewer(path: string) {
  fileViewerPanels.value = fileViewerPanels.value.filter(p => p.path !== path);
}
```

**Panel Rendering**:
- **Component**: `/packages/admin/src/components/FileViewerPanel.tsx`
- Each panel is a `SingleFileViewer` component that renders:
  - `FileViewerOverlay()` - Container for all file viewer panels
  - Multiple `SingleFileViewer` components (one per open file)
  - Each offset by `offset * 30` pixels for cascading effect

### Panel Features

**Dragging**:
```typescript
// FileViewerPanel.tsx:39-67
const onHeaderMouseDown = useCallback((e: MouseEvent) => {
  // Drag logic with position tracking
  // Updates posRef.current with new x, y position
});
```

**Content Types Supported**:
- **Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`
- **Markdown**: `.md` (rendered via `marked` library)
- **Code**: All others (syntax highlighted via `highlight.js`)
- **Line Numbers**: Code includes line numbering

**CSS Styling**:
```css
.file-viewer-panel {
  position: fixed;
  z-index: 8000;  ← FIXED Z-INDEX (no dynamic management)
  width: 700px;
  height: 500px;
  resize: both;
  /* ... */
}

.fv-header {
  cursor: grab;
  z-index: 951;  ← Header stays on top
}
```

### Key Finding: Z-Index Issue
**Problem**: File viewer panels have STATIC z-index of 8000. There's NO logic to:
- Bring a panel to front on click
- Manage z-order when multiple panels are open
- Distinguish focused vs unfocused panels

---

## SYSTEM 2: FILE COMPANION TABS (Integrated)

### Where Files Are Listed
Same sources as above, but clicking files triggers different flow:
- **FileTree** or **SidebarFileTree** → `openFileCompanion(filePath)`

### What Happens When File is Clicked

```
FileTree.tsx:98-101:
function handleFileClick(filePath: string) {
  const absPath = `${projectDir}/${filePath}`;
  openFileCompanion(absPath);  // Alternative to openFileViewer
}
```

The `openFileCompanion()` function:
- **Source**: `/packages/admin/src/lib/sessions.ts:2320-2330`
- Creates tab with ID format: `file:${filePath}`
- Integrates into pane tree system (sidebar, sessions list)
- Opens in dedicated leaf pane

```typescript
export function openFileCompanion(filePath: string) {
  const tabId = `file:${filePath}`;
  if (!openTabs.value.includes(tabId)) {
    openTabs.value = [...openTabs.value, tabId];
  }
  batchTreeOps(() => {
    const leafId = ensureSessionsLeaf();
    addTabToLeaf(leafId, tabId, true);  // true = focus tab
    showSessionsLeaf();
  });
}
```

### Panel/Tab Rendering

**Companion Type Definition**:
```typescript
// sessions.ts:2129
export type CompanionType = 'jsonl' | 'feedback' | 'iframe' | 'terminal' | 'isolate' | 'url' | 'file';
```

**Tab Content Rendering**:
- **File**: `/packages/admin/src/components/PaneContent.tsx:108-109`
```typescript
if (sid.startsWith('file:')) {
  const filePath = sid.slice(5);
  return <FileCompanionView filePath={filePath} />;
}
```

**Component**: `/packages/admin/src/components/FileCompanionView.tsx`
- Full featured file viewer integrated into pane layout
- Shows file path in toolbar
- Supports line selection with copy functions
- Syntax highlighting with line numbers

---

## PANEL FOCUS & Z-INDEX MANAGEMENT

### Z-Index System

**Popout Panels**:
```typescript
// sessions.ts:263-306
export const focusedPanelId = signal<string | null>(null);
export const panelZOrders = signal<Map<string, number>>(new Map());

let panelZCounter = 0;
export function bringToFront(panelId: string) {
  panelZCounter++;
  const map = new Map(panelZOrders.value);
  map.set(panelId, panelZCounter);
  panelZOrders.value = map;
  pushPaneMru({ type: 'panel', panelId });
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

export function getPanelZIndex(panelOrId: PopoutPanelState | string): number {
  const id = typeof panelOrId === 'string' ? panelOrId : panelOrId.id;
  const order = panelZOrders.value.get(id) || 0;
  const alwaysOnTop = typeof panelOrId === 'string' ? false : !!panelOrId.alwaysOnTop;
  // order*2 ensures most-recently-focused panel always wins;
  // alwaysOnTop adds +1 so it stays above same-age unfocused panels
  return 950 + order * 2 + (alwaysOnTop ? 1 : 0);  // Range: 950-∞
}

export function toggleAlwaysOnTop(panelId: string) {
  const panel = popoutPanels.value.find((p) => p.id === panelId);
  if (!panel) return;
  updatePanel(panelId, { alwaysOnTop: !panel.alwaysOnTop });
  bringToFront(panelId);
  persistPopoutState();
}
```

**Z-Index Ranges**:
| Component | Z-Index | Notes |
|-----------|---------|-------|
| PopoutPanels (dynamic) | 950-∞ | `getPanelZIndex()` computes dynamically |
| File Viewer Panels | 8000 | **STATIC - NO FOCUS MANAGEMENT** |
| File Viewer Header | 951 | Stays above body |
| Modals | 9999 | Always on top |
| UI Overlays | 10000+ | System UI |

### Bring-to-Front Logic

**Popout Panel System** (`PopoutPanel.tsx`):
- Click on panel header → calls `bringToFront(panelId)`
- Increments global counter `panelZCounter`
- Updates `panelZOrders` signal
- Re-renders with new z-index via `getPanelZIndex()`

**File Viewer Panels**:
- ❌ NO bring-to-front logic
- ❌ NO header click handlers that bring to front
- ❌ Panels stay at fixed z-index 8000 regardless of interaction

---

## FOCUS MANAGEMENT

### Focused Panel Tracking
```typescript
// sessions.ts:265-267
export function setFocusedPanel(panelId: string | null) {
  focusedPanelId.value = panelId;
}
```

**Used by PopoutPanel**:
- Tracks which popout panel has keyboard focus
- NOT used by FileViewerPanel

### Most Recently Used (MRU) History
```typescript
// sessions.ts:271-283
export const paneMruHistory = signal<PaneMruEntry[]>(loadJson('pw-pane-mru', []));

export function pushPaneMru(entry: PaneMruEntry) {
  const key = entry.type === 'tab' ? `tab:${entry.sessionId}` : `panel:${entry.panelId}`;
  const prev = paneMruHistory.value;
  const next = [entry, ...prev.filter((e) => {
    const k = e.type === 'tab' ? `tab:${e.sessionId}` : `panel:${e.panelId}`;
    return k !== key;
  })].slice(0, 30);
  paneMruHistory.value = next;
  localStorage.setItem('pw-pane-mru', JSON.stringify(next));
}
```

**Called by**:
- `bringToFront()` → Records panel as most recent
- `setActiveTab()` → Records tab as most recent

---

## FILE TREE STRUCTURE

### FileTree Component Structure
- **Location**: `/packages/admin/src/components/FileTree.tsx`
- **Type**: Hierarchical file browser with expand/collapse
- **Features**:
  - Breadcrumb navigation at top
  - Directory expand/collapse with chevron
  - File icons by extension
  - File size display
  - Caching of directory listings
  - Loading states for async operations

### File Icons
```typescript
const FILE_ICONS: Record<string, string> = {
  ts: '🇹', tsx: '🇹', js: '🇯', jsx: '🇯',
  py: '🐍', rs: '🦀', go: '🐹',
  json: '{}', yaml: '⚙', yml: '⚙', toml: '⚙',
  md: '📝', txt: '📄',
  css: '🎨', scss: '🎨', html: '🌐',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
  sh: '💻', bash: '💻',
};
```

---

## KEY FILES TO MODIFY FOR Z-INDEX FIXING

If implementing bring-to-front for FileViewerPanel:

1. **FileViewerPanel.tsx**:
   - Add click handler on `.fv-header`
   - Call `bringToFront()` or equivalent
   - Need to modify file-viewer state structure

2. **file-viewer.ts**:
   - Add `z-order` tracking to `FileViewerState`
   - Implement `bringFileToFront(path: string)` function
   - Change static z-index to dynamic calculation

3. **app.css**:
   - Change `.file-viewer-panel z-index: 8000` to use `var()` or computed
   - Or: Keep base z-index, add dynamic offset via inline styles

4. **Alternative**: Remove FileViewerPanel system entirely and use FileCompanionTab system

---

## SUMMARY

| Feature | File Viewer Panels | File Companion Tabs |
|---------|-------------------|-------------------|
| **Location** | Floating (fixed positioning) | Integrated in pane tree |
| **Z-Index** | Static 8000 | Dynamic (via PopoutPanel) |
| **Focus Management** | ❌ None | ✅ Full (bringToFront, MRU) |
| **Multiple Windows** | Cascading offset | Tabs in leaf panes |
| **Click-to-Focus** | ❌ Not implemented | ✅ Via bringToFront |
| **Always-on-Top** | ❌ Not supported | ✅ Via toggleAlwaysOnTop |
| **Persistence** | ❌ Not saved | ✅ Via persistPopoutState |

**Recommendation**: If file viewers need proper focus management and z-index handling, either:
1. Migrate to File Companion Tab system (more integrated)
2. OR: Implement full z-index management for FileViewerPanel similar to PopoutPanel system
