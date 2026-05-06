import { useCallback, useRef } from 'preact/hooks';
import { LearningsPanel } from '../learnings/LearningsDrawer.js';
import { ThreadPanel } from './CosThreadPanel.js';
import { ArtifactCompanionView } from '../files/ArtifactCompanionView.js';
import { DEFAULT_VERBOSITY, type ChiefOfStaffVerbosity } from '../../lib/chief-of-staff.js';
import { cosActiveThread } from '../../lib/cos-popout-tree.js';
import { DrawerPullHandle, type DrawerEdge } from './DrawerPullHandle.js';

/**
 * Fixed-position side drawers that hover over the CoS pane in `mode='pane'`.
 *
 * Layout knobs (per drawer): `side` left/right, `mode` outside/overlay/split,
 * width (drag-resizable), and top/height (drag-resizable). Mode meanings:
 *   - outside: drawer sits adjacent to the pane in the viewport gap.
 *   - overlay: drawer overlays the pane bounds; cos content sits *under* it.
 *   - split:   drawer overlays the pane bounds; cos content gets padding so
 *              it renders alongside the drawer rather than under it.
 *
 * Each drawer has a popout-grab-tab–styled handle on its inner edge with
 * three buttons (mode-cycle, side-flip, close) plus N/S resize strips for
 * vertical resize. Tab + handles are rendered as fixed-position siblings of
 * the drawer (the drawer wraps content in `overflow: hidden`).
 */
export type DrawerMode = 'outside' | 'overlay' | 'split';

export type CosDrawerStyle = {
  position: 'fixed';
  top: number;
  height: number;
  left: number;
  width: number;
  zIndex: number;
  side: 'left' | 'right';
  mode: DrawerMode;
};

export const MIN_DRAWER_WIDTH = 220;
export const MAX_DRAWER_WIDTH = 1400;
export const MIN_DRAWER_HEIGHT = 200;
export const TAB_WIDTH = 22;
const TAB_HEIGHT = 110;

function modeIcon(mode: DrawerMode): string {
  switch (mode) {
    case 'outside': return '◰';
    case 'overlay': return '▣';
    case 'split':   return '⫿';
  }
}
function nextModeLabel(mode: DrawerMode): string {
  switch (mode) {
    case 'outside': return 'overlay companion (mode 2 of 3)';
    case 'overlay': return 'split parent panel (mode 3 of 3)';
    case 'split':   return 'outside companion (mode 1 of 3)';
  }
}

/**
 * Tab placement rules:
 *   - outside mode: tab on the *outer* edge (away from cos pane). Drag the
 *     tab to extend the drawer into free viewport space.
 *   - overlay mode: tab on the *inner* edge sticking *out* of the drawer
 *     toward cos content. Drag pulls the inner edge toward the pane center.
 *   - split  mode: tab on the *inner* edge sitting *inside* the drawer body
 *     (no overhang). The drawer reserves TAB_WIDTH of left/right padding so
 *     content isn't covered. This eliminates the gap between cos content
 *     and the drawer that an overhanging tab would leave.
 *
 * `tabEdge` is the side of the drawer where the tab is anchored. Drag math:
 * `tabEdge='right'` → drag right grows the drawer (extends right edge);
 * `tabEdge='left'`  → drag left grows the drawer (extends left edge).
 */
function tabPlacement(drawer: CosDrawerStyle): { tabEdge: 'left' | 'right'; tabLeft: number; inside: boolean } {
  if (drawer.mode === 'outside') {
    // Tab on the outer edge of the drawer (the edge away from the pane).
    if (drawer.side === 'right') {
      return { tabEdge: 'right', tabLeft: drawer.left + drawer.width, inside: false };
    }
    return { tabEdge: 'left', tabLeft: drawer.left - TAB_WIDTH, inside: false };
  }
  if (drawer.mode === 'split') {
    // Tab inside the drawer on the inner edge — no overhang, no gap.
    if (drawer.side === 'right') {
      return { tabEdge: 'left', tabLeft: drawer.left, inside: true };
    }
    return { tabEdge: 'right', tabLeft: drawer.left + drawer.width - TAB_WIDTH, inside: true };
  }
  // overlay: tab on inner edge sticking out toward cos content.
  if (drawer.side === 'right') {
    return { tabEdge: 'left', tabLeft: drawer.left - TAB_WIDTH, inside: false };
  }
  return { tabEdge: 'right', tabLeft: drawer.left + drawer.width, inside: false };
}

/**
 * Popout-style tab. Fixed-position sibling of the drawer (the drawer wraps
 * content with overflow:hidden so a child tab would be clipped — except in
 * split mode, where the tab is positioned *inside* the drawer's bounds and
 * the drawer body has reserved padding for it).
 *
 * Resize math: capture startW + startX on mousedown, then on each mousemove
 * compute newW = startW ± dx absolutely (no cumulative drift). The polarity
 * comes from `tabEdge`: tab on 'right' → drag right grows; tab on 'left' →
 * drag left grows. Parent clamps.
 *
 * Buttons fire reliably because we *don't* preventDefault or start a drag
 * when mousedown originated inside a button — the button's native click is
 * left untouched.
 */
function CosDrawerTab({
  drawer,
  setWidth,
  cycleMode,
  onFlipSide,
}: {
  drawer: CosDrawerStyle;
  setWidth: (newWidthPx: number) => void;
  cycleMode: () => void;
  onFlipSide?: () => void;
}) {
  const { tabEdge, tabLeft, inside } = tabPlacement(drawer);
  const tabTop = drawer.top + Math.max(0, (drawer.height - TAB_HEIGHT) / 2);

  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      // If the press began inside a button let the native click go through —
      // we don't want to swallow the event or start a drag.
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = drawer.width;
      const startEdge = tabEdge;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        // Drawer grows when its tab edge moves outward:
        //   tabEdge='right' (tab on drawer's right): drag right → +width
        //   tabEdge='left'  (tab on drawer's left):  drag left  → +width
        const newW = startEdge === 'right' ? startW + dx : startW - dx;
        setWidth(newW);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [drawer.width, tabEdge, setWidth],
  );

  return (
    <div
      class={`cos-drawer-tab cos-drawer-tab-${tabEdge} cos-drawer-tab-${drawer.mode}${inside ? ' cos-drawer-tab-embedded' : ''}`}
      style={{
        position: 'fixed',
        top: tabTop,
        left: tabLeft,
        width: TAB_WIDTH,
        height: TAB_HEIGHT,
        zIndex: drawer.zIndex + 1,
      }}
      onMouseDown={onMouseDown}
      title="Drag to resize"
      role="separator"
      aria-orientation="vertical"
    >
      <button
        type="button"
        class="cos-drawer-tab-btn"
        onClick={cycleMode}
        title={`Cycle layout — next: ${nextModeLabel(drawer.mode)}`}
        aria-label={`Cycle layout, next ${nextModeLabel(drawer.mode)}`}
      >
        {modeIcon(drawer.mode)}
      </button>
      <span class="cos-drawer-tab-grip" aria-hidden="true">┃</span>
      {onFlipSide && (
        <button
          type="button"
          class="cos-drawer-tab-btn"
          onClick={onFlipSide}
          title={`Move to ${drawer.side === 'left' ? 'right' : 'left'}`}
          aria-label="Flip drawer side"
        >
          {drawer.side === 'left' ? '→' : '←'}
        </button>
      )}
    </div>
  );
}

/**
 * North/South resize strips — mirrors popout-resize-n / popout-resize-s.
 * Fixed-position sibling of the drawer; mousedown captures absolute startTop
 * + startHeight, mousemove computes newTop / newHeight, parent clamps.
 */
function CosDrawerVResize({
  drawer,
  edge,
  setBounds,
}: {
  drawer: CosDrawerStyle;
  edge: 'n' | 's';
  setBounds: (newTopPx: number, newHeightPx: number) => void;
}) {
  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startTop = drawer.top;
      const startH = drawer.height;
      const onMove = (ev: MouseEvent) => {
        const dy = ev.clientY - startY;
        if (edge === 'n') {
          // North handle: drag down → top moves down, height shrinks.
          setBounds(startTop + dy, startH - dy);
        } else {
          // South handle: drag down → height grows, top unchanged.
          setBounds(startTop, startH + dy);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [drawer.top, drawer.height, edge, setBounds],
  );

  // Strip sits 3px outside the drawer's top/bottom edge, full inner width.
  const top = edge === 'n' ? drawer.top - 3 : drawer.top + drawer.height - 3;
  return (
    <div
      class={`cos-drawer-resize-${edge}`}
      style={{
        position: 'fixed',
        top,
        left: drawer.left + 8,
        width: Math.max(0, drawer.width - 16),
        height: 6,
        cursor: 'ns-resize',
        zIndex: drawer.zIndex + 1,
      }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize drawer ${edge === 'n' ? 'top' : 'bottom'}`}
    />
  );
}

function DrawerChrome({
  drawer,
  paneRect,
  hamburgerPos,
  setHamburgerPos,
  setWidth,
  setBounds,
  cycleMode,
  onFlipSide,
  onClose,
}: {
  drawer: CosDrawerStyle;
  /** Cos pane rect — the unified pull handle anchors its line along this
   *  pane's edge regardless of drawer mode. */
  paneRect: { top: number; left: number; width: number; height: number };
  hamburgerPos: number;
  setHamburgerPos: (pos: number) => void;
  setWidth: (px: number) => void;
  setBounds: (top: number, height: number) => void;
  cycleMode: () => void;
  onFlipSide?: () => void;
  onClose: () => void;
}) {
  const modeLabel = `${modeIcon(drawer.mode)} ${nextModeLabel(drawer.mode)}`;
  // The drawer's anchor side (left/right) maps directly to which edge of the
  // cos pane the line runs along.
  const edge: DrawerEdge = drawer.side === 'right' ? 'right' : 'left';
  // Resize: capture starting width on drag start; each delta from the unified
  // handle is applied against that baseline.
  const startWidthRef = useRef(drawer.width);
  return (
    <>
      <DrawerPullHandle
        edge={edge}
        hostRect={paneRect}
        hamburgerPos={hamburgerPos}
        zIndex={drawer.zIndex + 2}
        onClickCollapse={onClose}
        onResizeStart={() => { startWidthRef.current = drawer.width; }}
        onResize={(deltaPx) => setWidth(startWidthRef.current + deltaPx)}
        onPositionChange={setHamburgerPos}
        menuItems={(close) => (
          <>
            <button
              type="button"
              class="popup-menu-item"
              onClick={() => { cycleMode(); close(); }}
            >{modeLabel}</button>
            {onFlipSide && (
              <button
                type="button"
                class="popup-menu-item"
                onClick={() => { onFlipSide(); close(); }}
              >{`${drawer.side === 'left' ? '▸ Move to right' : '◂ Move to left'} side`}</button>
            )}
            <div class="popup-menu-separator" />
            <button
              type="button"
              class="popup-menu-item popup-menu-item-danger"
              onClick={() => { onClose(); close(); }}
            >× Close drawer</button>
          </>
        )}
      />
      <CosDrawerVResize drawer={drawer} edge="n" setBounds={setBounds} />
      <CosDrawerVResize drawer={drawer} edge="s" setBounds={setBounds} />
    </>
  );
}

function drawerWrapperClass(prefix: string, mode: DrawerMode, side: 'left' | 'right'): string {
  // 'outside' keeps the legacy attached-edge look (no border on the side that
  // touches the pane). overlay/split read as standalone floating surfaces, so
  // we restore the full border via cos-drawer-inside.
  const base = `${prefix} ${prefix}-${side}`;
  return mode === 'outside' ? base : `${base} cos-drawer-inside`;
}

/**
 * Padding the drawer body must leave on its inner edge so the tab — which in
 * split mode is positioned *inside* the drawer bounds — doesn't sit on top
 * of content. `null` means no embedded tab; default zero padding.
 */
function drawerEmbeddedTabPad(drawer: CosDrawerStyle): { paddingLeft?: string; paddingRight?: string } {
  if (drawer.mode !== 'split') return {};
  // Inner edge in split mode:
  //   side='right' drawer → tab on the drawer's left edge → padding-left
  //   side='left'  drawer → tab on the drawer's right edge → padding-right
  if (drawer.side === 'right') return { paddingLeft: `${TAB_WIDTH}px` };
  return { paddingRight: `${TAB_WIDTH}px` };
}

export function CosLearningsDrawer({
  style,
  paneRect,
  hamburgerPos,
  setHamburgerPos,
  setLearningsSide,
  setLearningsMode,
  cycleLearningsMode,
  setLearningsWidthClamped,
  setLearningsBounds,
  onClose,
}: {
  style: CosDrawerStyle;
  paneRect: { top: number; left: number; width: number; height: number };
  hamburgerPos: number;
  setHamburgerPos: (pos: number) => void;
  setLearningsSide: (side: 'left' | 'right') => void;
  setLearningsMode: (m: DrawerMode) => void;
  cycleLearningsMode: () => void;
  setLearningsWidthClamped: (px: number) => void;
  setLearningsBounds: (top: number, height: number) => void;
  onClose: () => void;
}) {
  void setLearningsMode;
  return (
    <>
      <div
        class={drawerWrapperClass('cos-learnings-side', style.mode, style.side)}
        style={{
          position: style.position,
          top: style.top,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
          ...drawerEmbeddedTabPad(style),
        }}
      >
        <LearningsPanel onClose={onClose} />
      </div>
      <DrawerChrome
        drawer={style}
        paneRect={paneRect}
        hamburgerPos={hamburgerPos}
        setHamburgerPos={setHamburgerPos}
        setWidth={setLearningsWidthClamped}
        setBounds={setLearningsBounds}
        cycleMode={cycleLearningsMode}
        onFlipSide={() => setLearningsSide(style.side === 'left' ? 'right' : 'left')}
        onClose={onClose}
      />
    </>
  );
}

export function CosThreadDrawer({
  style,
  agentId,
  showTools,
  verbosity,
  paneRect,
  hamburgerPos,
  setHamburgerPos,
  onArtifactPopout,
  onReply,
  onClose,
  setThreadSide,
  setThreadMode,
  cycleThreadMode,
  setThreadWidthClamped,
  setThreadBounds,
}: {
  style: CosDrawerStyle;
  agentId: string;
  showTools: boolean;
  verbosity?: ChiefOfStaffVerbosity;
  paneRect: { top: number; left: number; width: number; height: number };
  hamburgerPos: number;
  setHamburgerPos: (pos: number) => void;
  onArtifactPopout: (artifactId: string) => void;
  onReply: (role: string, text: string, anchorTs?: number, threadServerId?: string | null) => void;
  onClose: () => void;
  setThreadSide: (side: 'left' | 'right') => void;
  setThreadMode: (m: DrawerMode) => void;
  cycleThreadMode: () => void;
  setThreadWidthClamped: (px: number) => void;
  setThreadBounds: (top: number, height: number) => void;
}) {
  void setThreadMode;
  return (
    <>
      <div
        class={drawerWrapperClass('cos-thread-side', style.mode, style.side)}
        style={{
          position: style.position,
          top: style.top,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
          ...drawerEmbeddedTabPad(style),
        }}
      >
        <ThreadPanel
          agentId={agentId}
          showTools={showTools}
          verbosity={verbosity || DEFAULT_VERBOSITY}
          onArtifactPopout={onArtifactPopout}
          onReply={onReply}
          onClose={() => {
            onClose();
            cosActiveThread.value = null;
          }}
        />
      </div>
      <DrawerChrome
        drawer={style}
        paneRect={paneRect}
        hamburgerPos={hamburgerPos}
        setHamburgerPos={setHamburgerPos}
        setWidth={setThreadWidthClamped}
        setBounds={setThreadBounds}
        cycleMode={cycleThreadMode}
        onFlipSide={() => setThreadSide(style.side === 'left' ? 'right' : 'left')}
        onClose={onClose}
      />
    </>
  );
}

export function CosArtifactDrawer({
  style,
  artifactId,
  paneRect,
  hamburgerPos,
  setHamburgerPos,
  setArtifactSide,
  cycleArtifactMode,
  setArtifactWidthClamped,
  setArtifactBounds,
  onClose,
}: {
  style: CosDrawerStyle;
  artifactId: string;
  paneRect: { top: number; left: number; width: number; height: number };
  hamburgerPos: number;
  setHamburgerPos: (pos: number) => void;
  setArtifactSide: (side: 'left' | 'right') => void;
  cycleArtifactMode: () => void;
  setArtifactWidthClamped: (px: number) => void;
  setArtifactBounds: (top: number, height: number) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div
        class={drawerWrapperClass('cos-artifact-side', style.mode, style.side)}
        style={{
          position: style.position,
          top: style.top,
          left: style.left,
          width: style.width,
          height: style.height,
          zIndex: style.zIndex,
          ...drawerEmbeddedTabPad(style),
        }}
      >
        <div class="cos-artifact-drawer-controls">
          <button
            type="button"
            class="cos-link-btn"
            onClick={onClose}
            title="Close artifact drawer"
            aria-label="Close artifact drawer"
          >×</button>
        </div>
        <div class="cos-artifact-drawer-body">
          <ArtifactCompanionView artifactId={artifactId} />
        </div>
      </div>
      <DrawerChrome
        drawer={style}
        paneRect={paneRect}
        hamburgerPos={hamburgerPos}
        setHamburgerPos={setHamburgerPos}
        setWidth={setArtifactWidthClamped}
        setBounds={setArtifactBounds}
        cycleMode={cycleArtifactMode}
        onFlipSide={() => setArtifactSide(style.side === 'left' ? 'right' : 'left')}
        onClose={onClose}
      />
    </>
  );
}
