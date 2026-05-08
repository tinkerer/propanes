import { useCallback, useRef, useState } from 'preact/hooks';
import { LearningsPanel } from '../learnings/LearningsDrawer.js';
import { ThreadPanel } from './CosThreadPanel.js';
import { ArtifactCompanionView } from '../files/ArtifactCompanionView.js';
import { DEFAULT_VERBOSITY, type ChiefOfStaffVerbosity } from '../../lib/chief-of-staff.js';
import { cosActiveThread } from '../../lib/cos-popout-tree.js';
import { PopupMenu } from '../pickers/PopupMenu.js';
import { DrawerPullHandle, type DrawerEdge } from './DrawerPullHandle.js';

/**
 * Fixed-position side drawers that hover over the CoS pane in `mode='pane'`.
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

function pullEdge(side: 'left' | 'right', mode: DrawerMode): DrawerEdge {
  if (mode === 'outside') return side === 'right' ? 'right' : 'left';
  return side === 'right' ? 'left' : 'right';
}

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
 * North/South resize strips.
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
        if (edge === 'n') setBounds(startTop + dy, startH - dy);
        else setBounds(startTop, startH + dy);
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
  hamburgerPos,
  setWidth,
  setBounds,
  cycleMode,
  onFlipSide,
  onClose,
}: {
  drawer: CosDrawerStyle;
  hamburgerPos: number;
  setWidth: (px: number) => void;
  setBounds: (top: number, height: number) => void;
  cycleMode: () => void;
  onFlipSide?: () => void;
  onClose: () => void;
}) {
  const modeLabel = `${modeIcon(drawer.mode)} ${nextModeLabel(drawer.mode)}`;
  const edge: DrawerEdge = pullEdge(drawer.side, drawer.mode);
  const [menuOpen, setMenuOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const startWidthRef = useRef(drawer.width);

  return (
    <>
      <DrawerPullHandle
        edge={edge}
        drawerRect={{ top: drawer.top, left: drawer.left, width: drawer.width, height: drawer.height }}
        handlePos={hamburgerPos}
        zIndex={drawer.zIndex + 2}
        // Tab (┃): click → close, drag → resize width
        onClickCollapse={onClose}
        onResizeStart={() => { startWidthRef.current = drawer.width; }}
        onResize={(deltaPx) => setWidth(startWidthRef.current + deltaPx)}
        // Hamburger (☰): click → menu
        hamburgerRef={hamburgerRef}
        onHamburgerMouseDown={(e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        {menuOpen && (
          <PopupMenu anchorRef={hamburgerRef} onClose={() => setMenuOpen(false)}>
            <button
              type="button"
              class="popup-menu-item"
              onClick={() => { cycleMode(); setMenuOpen(false); }}
            >{modeLabel}</button>
            {onFlipSide && (
              <button
                type="button"
                class="popup-menu-item"
                onClick={() => { onFlipSide(); setMenuOpen(false); }}
              >{`${drawer.side === 'left' ? '▸ Move to right' : '◂ Move to left'} side`}</button>
            )}
            <div class="popup-menu-separator" />
            <button
              type="button"
              class="popup-menu-item popup-menu-item-danger"
              onClick={() => { onClose(); setMenuOpen(false); }}
            >× Close drawer</button>
          </PopupMenu>
        )}
      </DrawerPullHandle>
      <CosDrawerVResize drawer={drawer} edge="n" setBounds={setBounds} />
      <CosDrawerVResize drawer={drawer} edge="s" setBounds={setBounds} />
    </>
  );
}

function drawerWrapperClass(prefix: string, mode: DrawerMode, side: 'left' | 'right'): string {
  const base = `${prefix} ${prefix}-${side}`;
  return mode === 'outside' ? base : `${base} cos-drawer-inside`;
}

export function CosLearningsDrawer({
  style,
  hamburgerPos,
  setLearningsSide,
  setLearningsMode,
  cycleLearningsMode,
  setLearningsWidthClamped,
  setLearningsBounds,
  onClose,
}: {
  style: CosDrawerStyle;
  hamburgerPos: number;
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
        }}
      >
        <LearningsPanel onClose={onClose} />
      </div>
      <DrawerChrome
        drawer={style}
        hamburgerPos={hamburgerPos}
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
  hamburgerPos,
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
  hamburgerPos: number;
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
        hamburgerPos={hamburgerPos}
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
  hamburgerPos,
  setArtifactSide,
  cycleArtifactMode,
  setArtifactWidthClamped,
  setArtifactBounds,
  onClose,
}: {
  style: CosDrawerStyle;
  artifactId: string;
  hamburgerPos: number;
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
        hamburgerPos={hamburgerPos}
        setWidth={setArtifactWidthClamped}
        setBounds={setArtifactBounds}
        cycleMode={cycleArtifactMode}
        onFlipSide={() => setArtifactSide(style.side === 'left' ? 'right' : 'left')}
        onClose={onClose}
      />
    </>
  );
}
