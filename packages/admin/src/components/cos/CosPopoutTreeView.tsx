import { type ComponentChildren, type VNode } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SplitPane } from '../panes/SplitPane.js';
import { PopupMenu } from '../pickers/PopupMenu.js';
import {
  type PaneNode,
  type LeafNode,
  type LayoutTree,
} from '../../lib/pane-tree.js';
import {
  cosSetSplitRatio,
  cosSetActiveTab,
  cosRemoveTabFromLeaf,
  cosSplitLeaf,
  cosMergeLeaf,
  cosOpenArtifactTab,
  cosToggleLearningsTab,
  cosOpenThreadTab,
  cosCloseThreadTab,
  cosIsLearningsOpen,
  cosIsThreadOpen,
  cosSlackMode,
  cosActiveThread,
  cosToggleLeafCollapsed,
  cosCollapseLeafToEdge,
  cosSetLeafCollapsedOffset,
  cosSetLeafFloating,
  cosSetLeafExternal,
  cosMoveDrawerToEdge,
  cosGetDrawerHandlePos,
  cosSetDrawerHandlePos,
  cosDrawerHandlePos,
  COS_POPOUT_CHAT_TAB,
  COS_POPOUT_LEARNINGS_TAB,
  COS_POPOUT_THREAD_TAB,
  isArtifactTab,
  artifactIdFromTab,
} from '../../lib/cos-popout-tree.js';
import { cosArtifacts } from '../../lib/cos-artifacts.js';
import { ArtifactCompanionView } from '../files/ArtifactCompanionView.js';
import { startCosTabDrag, startCosLeafDrag } from '../../lib/cos-tab-drag.js';
import { dragOverLeafZone, openCosExternally, openCosTabExternally } from '../../lib/tab-drag.js';
import {
  popoutPanels,
  updatePanel,
  persistPopoutState,
  COS_PANEL_ID,
} from '../../lib/popout-state.js';
import { DrawerPullHandle, type DrawerEdge } from './DrawerPullHandle.js';

interface ResolvedTab {
  label: string;
  icon?: string;
  content: ComponentChildren;
  closable: boolean;
}

/**
 * Pop the given tab out into a dedicated browser window via `?embed=cos&focus=...`.
 * For thread tabs, propagate the active thread coords so the focused window
 * resolves the right thread regardless of what the parent later selects.
 */
function popOutCosTab(tabId: string) {
  if (tabId === COS_POPOUT_THREAD_TAB) {
    const at = cosActiveThread.value;
    openCosTabExternally(tabId, 'new-window', at ? { agentId: at.agentId, threadKey: at.threadKey } : undefined);
    return;
  }
  openCosTabExternally(tabId, 'new-window');
}

export function CosPopoutTreeView({
  tree,
  chatContent,
  learningsContent,
  threadContent,
}: {
  /** Tree snapshot. Passed by the parent (which subscribes to the signal) so
   *  Preact re-renders on mutation even inside an IIFE-shaped JSX expression. */
  tree: LayoutTree;
  chatContent: ComponentChildren;
  /** Render-prop for the learnings panel so the caller controls data loading. */
  learningsContent: ComponentChildren;
  /** Slack-mode thread side-panel. */
  threadContent: ComponentChildren;
}) {
  function resolve(tabId: string): ResolvedTab {
    if (tabId === COS_POPOUT_CHAT_TAB) {
      // Chat is non-closable: there's no path to re-open it from a fully empty
      // popout, and the popout body itself depends on it being mounted (chat
      // scroll preservation hooks bind to its scrollEl). The pane chrome (+,
      // hamburger, X) treats it like any other tab in every other respect.
      return { label: 'Chat', content: chatContent, closable: false };
    }
    if (tabId === COS_POPOUT_LEARNINGS_TAB) {
      return { label: 'Learnings', icon: '★', content: learningsContent, closable: true };
    }
    if (tabId === COS_POPOUT_THREAD_TAB) {
      const t = cosActiveThread.value;
      const label = t ? 'Thread' : 'Thread (none)';
      return { label, icon: '↳', content: threadContent, closable: true };
    }
    if (isArtifactTab(tabId)) {
      const id = artifactIdFromTab(tabId);
      const art = cosArtifacts.value[id];
      const icon = art?.kind === 'code' ? '❮❯' : art?.kind === 'table' ? '▦' : '☰';
      return {
        label: art?.label || id,
        icon,
        content: <ArtifactCompanionView artifactId={id} />,
        closable: true,
      };
    }
    return { label: tabId, content: <div />, closable: false };
  }

  return (
    <div class="cos-tree-root">
      {renderNode(tree.root, resolve, null)}
    </div>
  );
}

/** A subtree whose every leaf is `floating: true` — i.e. a floating drawer
 *  that may itself be split into sibling drawer panes. Detection has to
 *  recurse: as soon as `addFloatingCompanionPane` nests a floating split,
 *  the parent's child is a `SplitNode`, not a `LeafNode`, and a shallow
 *  `child.type === 'leaf' && child.floating` check would miss it and fall
 *  back to a regular SplitPane (no overlay). */
function isFloatingSubtree(node: PaneNode): boolean {
  if (node.type === 'leaf') return !!node.floating;
  return isFloatingSubtree(node.children[0]) && isFloatingSubtree(node.children[1]);
}

/** A floating subtree whose every leaf is `external: true`. External drawers
 *  render via portal at document.body level, anchored to the popout's bounds
 *  and extending into page space (vs. overlaying the popout's content). */
function isExternalSubtree(node: PaneNode): boolean {
  if (node.type === 'leaf') return !!node.floating && !!node.external;
  return isExternalSubtree(node.children[0]) && isExternalSubtree(node.children[1]);
}

function renderNode(
  node: PaneNode,
  resolve: (tabId: string) => ResolvedTab,
  parentDir: 'horizontal' | 'vertical' | null,
): VNode {
  if (node.type === 'leaf') {
    return <CosLeafView key={node.id} leaf={node} resolve={resolve} parentDir={parentDir} />;
  }
  // Floating-companion split: exactly one side is a floating subtree — render
  // the non-floating sibling at 100% and stack the floating side as an
  // absolutely-positioned overlay on the matching edge of the parent split.
  // See LeafNode.floating in pane-tree.ts and cosDockTabToEdge(opts.floating).
  const a = node.children[0];
  const b = node.children[1];
  const aFloat = isFloatingSubtree(a);
  const bFloat = isFloatingSubtree(b);
  if (aFloat !== bFloat) {
    return (
      <FloatingCompanionSplit
        node={node}
        resolve={resolve}
        parentDir={parentDir}
      />
    );
  }
  return (
    <SplitPane
      direction={node.direction}
      ratio={node.ratio}
      splitId={node.id}
      onRatioChange={(splitId, ratio) => cosSetSplitRatio(splitId, ratio)}
      first={renderNode(node.children[0], resolve, node.direction)}
      second={renderNode(node.children[1], resolve, node.direction)}
    />
  );
}

/**
 * Renders a split that contains exactly one floating leaf. The non-floating
 * sibling fills 100% of the parent; the floating leaf is either (a) overlaid
 * on the matching edge as an absolute child of the parent host (`external`
 * false) or (b) portaled to document.body and positioned fixed against the
 * cos popout's bounding rect, extending into page space (`external` true).
 *
 * Both variants share the inner-edge grab handle that resizes the split
 * ratio. The handle hosts a hamburger popup with quick layout actions:
 * toggle internal/external, convert to split, change edge, close.
 */
function FloatingCompanionSplit({
  node,
  resolve,
  parentDir,
}: {
  node: Extract<PaneNode, { type: 'split' }>;
  resolve: (tabId: string) => ResolvedTab;
  parentDir: 'horizontal' | 'vertical' | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const a = node.children[0];
  const b = node.children[1];
  const isFirst = isFloatingSubtree(a);
  const floatChild = isFirst ? a : b;
  const baseChild = isFirst ? b : a;
  const isHorizontal = node.direction === 'horizontal';
  const isExternal = isExternalSubtree(floatChild);
  const sizePct = (isFirst ? node.ratio : 1 - node.ratio) * 100;
  // First leaf inside the floating subtree drives popup-menu actions
  // (toggle internal/external, etc.). Recurses to handle nested drawer
  // splits where the actionable leaf is deeper than the immediate child.
  const drawerLeaf = firstLeafOf(floatChild);

  // Track the cos popout's bounding rect — needed for both external rendering
  // (the portaled overlay anchors against it) AND the unified drawer handle
  // (the line runs along the popout's edge regardless of overlay/external).
  // We rAF-poll because the popout moves/resizes via signal updates that
  // don't traverse this component.
  const [popoutRect, setPopoutRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const popoutEl = host.closest('.cos-popout') as HTMLElement | null;
    if (!popoutEl) return;
    let raf: number | null = null;
    const tick = () => {
      const r = popoutEl.getBoundingClientRect();
      setPopoutRect((prev) => {
        if (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) return prev;
        return r;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf !== null) cancelAnimationFrame(raf); };
  }, []);

  // The drawer's *inner edge* drives the overlay's border/radius treatment
  // (no border on inner edge so the drawer reads as flush against the
  // popout). The unified `DrawerPullHandle` lives on the popout's edge
  // matching the drawer's anchor side — same edge whether the drawer is
  // overlay or external; the difference is which side of the line the
  // drawer body sits on.
  const innerEdge: 'left' | 'right' | 'top' | 'bottom' = isHorizontal
    ? (isFirst ? 'right' : 'left')
    : (isFirst ? 'bottom' : 'top');
  const grabSide = innerEdge; // legacy alias used for the overlay border/radius class
  const drawerEdge: DrawerEdge = isHorizontal
    ? (isFirst ? 'left' : 'right')
    : (isFirst ? 'top' : 'bottom');

  // Watch the persisted slide position so the hamburger snaps to wherever
  // the operator left it across renders.
  const _handlePosTick = cosDrawerHandlePos.value;
  void _handlePosTick;

  // Resize callbacks: capture starting ratio at drag start, then translate
  // each cumulative px-delta to a ratio delta against the popout's
  // perpendicular size.
  const startRatioRef = useRef<number>(node.ratio);
  const handlePullNode = drawerLeaf && popoutRect ? (
    <DrawerPullHandle
      edge={drawerEdge}
      hostRect={{ top: popoutRect.top, left: popoutRect.left, width: popoutRect.width, height: popoutRect.height }}
      hamburgerPos={cosGetDrawerHandlePos(drawerLeaf.id)}
      zIndex={1100}
      collapsed={floatChild.type === 'leaf' && !!floatChild.collapsed}
      onClickCollapse={() => cosToggleLeafCollapsed(drawerLeaf.id)}
      onResizeStart={() => { startRatioRef.current = node.ratio; }}
      onResize={(deltaPx) => {
        const popoutPerp = isHorizontal ? popoutRect.width : popoutRect.height;
        if (popoutPerp <= 0) return;
        // Outward = drawer growing. The drawer's "first child share" of the
        // parent split corresponds to:
        //   - isFirst=true: ratio represents the floating share itself.
        //   - isFirst=false: ratio represents the base share, so floating
        //     share is (1 - ratio); growing the drawer means *shrinking* ratio.
        const ratioDelta = deltaPx / popoutPerp;
        const newRatio = isFirst ? startRatioRef.current + ratioDelta : startRatioRef.current - ratioDelta;
        cosSetSplitRatio(node.id, Math.max(0.05, Math.min(0.95, newRatio)));
      }}
      onPositionChange={(pos) => cosSetDrawerHandlePos(drawerLeaf.id, pos)}
      onDragOutside={() => {
        // Drag past the popout's edge → flip overlay/external. (For external
        // drawers, "outside" past the *outer* edge is page space — leave
        // alone; the inner-edge cross is what triggers the flip back.)
        if (!isExternal) cosSetLeafExternal(drawerLeaf.id, true);
        else cosSetLeafExternal(drawerLeaf.id, false);
      }}
      menuItems={(close) => (
        <>
          <button
            type="button"
            class="popup-menu-item"
            onClick={() => { cosSetLeafExternal(drawerLeaf.id, !isExternal); close(); }}
          >{isExternal ? '◰ Make overlay drawer' : '⬚ Make external drawer'}</button>
          <button
            type="button"
            class="popup-menu-item"
            onClick={() => { onConvertToSplit(); close(); }}
          >⊟ Convert to split pane</button>
          <div class="popup-menu-separator" />
          {(['L','R','T','B'] as const).filter((e) => e !== (isHorizontal ? (isFirst ? 'L' : 'R') : (isFirst ? 'T' : 'B'))).map((e) => (
            <button
              key={e}
              type="button"
              class="popup-menu-item"
              onClick={() => { cosMoveDrawerToEdge(drawerLeaf.id, e); close(); }}
            >{`${e === 'L' ? '◂ Move to left' : e === 'R' ? '▸ Move to right' : e === 'T' ? '▴ Move to top' : '▾ Move to bottom'} edge`}</button>
          ))}
          <div class="popup-menu-separator" />
          <button
            type="button"
            class="popup-menu-item"
            onClick={() => { cosToggleLeafCollapsed(drawerLeaf.id); close(); }}
          >{floatChild.type === 'leaf' && floatChild.collapsed ? '▣ Show drawer' : '▭ Hide drawer'}</button>
          <button
            type="button"
            class="popup-menu-item popup-menu-item-danger"
            onClick={() => {
              for (const t of [...drawerLeaf.tabs]) cosRemoveTabFromLeaf(drawerLeaf.id, t);
              close();
            }}
          >× Close drawer</button>
        </>
      )}
    />
  ) : null;

  // Convert-to-split helper — preserves chat width by expanding the popout.
  function onConvertToSplit() {
    if (!drawerLeaf) return;
    if (!isExternal) {
      const panel = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
      if (panel) {
        const popoutSize = isHorizontal
          ? (panel.docked ? panel.dockedWidth : panel.floatingRect.w)
          : (panel.docked ? panel.dockedHeight : panel.floatingRect.h);
        const drawerSize = (isFirst ? node.ratio : 1 - node.ratio) * popoutSize;
        const newSize = popoutSize + drawerSize;
        const drawerRatio = drawerSize / newSize;
        const newRatio = isFirst ? drawerRatio : 1 - drawerRatio;
        if (panel.docked) {
          updatePanel(COS_PANEL_ID, isHorizontal ? { dockedWidth: newSize } : { dockedHeight: newSize });
        } else {
          const r = panel.floatingRect;
          if (isHorizontal) {
            const newX = isFirst ? Math.max(0, r.x - drawerSize) : r.x;
            updatePanel(COS_PANEL_ID, { floatingRect: { ...r, x: newX, w: newSize } });
          } else {
            const newY = isFirst ? Math.max(0, r.y - drawerSize) : r.y;
            updatePanel(COS_PANEL_ID, { floatingRect: { ...r, y: newY, h: newSize } });
          }
        }
        cosSetSplitRatio(node.id, Math.max(0.05, Math.min(0.95, newRatio)));
        persistPopoutState();
      }
    }
    cosSetLeafFloating(drawerLeaf.id, false);
  }

  // Collapsed (hidden) drawer — only the handle should show, the leaf content
  // is suppressed and the overlay shrinks to handle width on the matching
  // axis. Click on the handle (the strip mousedown handler) toggles the
  // leaf back to expanded.
  const collapsed = floatChild.type === 'leaf' && !!floatChild.collapsed;
  const HANDLE_SLIM = 26;

  // -- External path: portal the overlay to body, position fixed against the
  // popout's rect. The unified pull-handle is rendered separately (also as
  // a portaled fixed-position element) so it lives on the popout's edge,
  // independent of the drawer body's position.
  if (isExternal) {
    const baseStyle = externalOverlayStyle(popoutRect ?? new DOMRect(0, 0, 0, 0), node.ratio, isHorizontal, isFirst);
    const style = collapsed ? collapseExternalStyle(baseStyle, isHorizontal, isFirst, HANDLE_SLIM) : baseStyle;
    return (
      <div
        ref={hostRef}
        class={`cos-tree-floating-host cos-tree-floating-host-${node.direction}${isFirst ? ' cos-tree-floating-host-first' : ' cos-tree-floating-host-second'} cos-tree-floating-host-external`}
      >
        <div class="cos-tree-floating-base">
          {renderNode(baseChild, resolve, parentDir)}
        </div>
        {popoutRect && createPortal(
          <div
            class={`cos-tree-floating-overlay cos-tree-floating-overlay-external cos-tree-floating-overlay-${grabSide}${collapsed ? ' cos-tree-floating-overlay-collapsed' : ''}`}
            style={style}
          >
            {!collapsed && renderNode(floatChild, resolve, node.direction)}
          </div>,
          document.body,
        )}
        {handlePullNode && createPortal(handlePullNode, document.body)}
      </div>
    );
  }

  // -- Internal path: overlay rendered as an absolute child of the host.
  const overlayStyle: Record<string, string | number> = collapsed
    ? collapseInternalStyle(isHorizontal, isFirst, HANDLE_SLIM)
    : isHorizontal
      ? {
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: `${sizePct}%`,
          ...(isFirst ? { left: 0 } : { right: 0 }),
        }
      : {
          position: 'absolute',
          left: 0,
          right: 0,
          height: `${sizePct}%`,
          ...(isFirst ? { top: 0 } : { bottom: 0 }),
        };
  return (
    <div
      ref={hostRef}
      class={`cos-tree-floating-host cos-tree-floating-host-${node.direction}${isFirst ? ' cos-tree-floating-host-first' : ' cos-tree-floating-host-second'}`}
    >
      <div class="cos-tree-floating-base">
        {renderNode(baseChild, resolve, parentDir)}
      </div>
      <div
        class={`cos-tree-floating-overlay${collapsed ? ' cos-tree-floating-overlay-collapsed' : ''}`}
        style={overlayStyle}
      >
        {!collapsed && renderNode(floatChild, resolve, node.direction)}
      </div>
      {handlePullNode && createPortal(handlePullNode, document.body)}
    </div>
  );
}

/** Hidden-drawer (collapsed) style for the *external* overlay — keep the
 *  position fixed against the popout's outer edge but shrink the perpendicular
 *  axis to handle width so only the strip + hamburger show. */
function collapseExternalStyle(
  baseStyle: Record<string, string | number>,
  isHorizontal: boolean,
  isFirst: boolean,
  slim: number,
): Record<string, string | number> {
  const out = { ...baseStyle };
  if (isHorizontal) {
    out.width = slim;
    if (isFirst && typeof out.left === 'number') {
      // Anchor so the slim strip's outer edge sits flush with where the
      // drawer's outer edge was — i.e., the strip is closest to the popout.
      const prevWidth = (baseStyle.width as number) ?? 0;
      out.left = (out.left as number) + (prevWidth - slim);
    }
  } else {
    out.height = slim;
    if (isFirst && typeof out.top === 'number') {
      const prevHeight = (baseStyle.height as number) ?? 0;
      out.top = (out.top as number) + (prevHeight - slim);
    }
  }
  return out;
}

/** Hidden-drawer style for the *internal* overlay — shrink the absolute
 *  overlay to handle width, anchored on the matching edge so it reads as a
 *  slim tab attached to the popout's interior edge. */
function collapseInternalStyle(
  isHorizontal: boolean,
  isFirst: boolean,
  slim: number,
): Record<string, string | number> {
  if (isHorizontal) {
    return {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: `${slim}px`,
      ...(isFirst ? { left: 0 } : { right: 0 }),
    };
  }
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    height: `${slim}px`,
    ...(isFirst ? { top: 0 } : { bottom: 0 }),
  };
}

function firstLeafOf(node: PaneNode): LeafNode | null {
  if (node.type === 'leaf') return node;
  return firstLeafOf(node.children[0]) ?? firstLeafOf(node.children[1]);
}

/**
 * Compute fixed-position coords for an external drawer anchored to the cos
 * popout's bounding rect. Drawer extends *outside* the popout on the matching
 * edge; size = `ratio` of the popout's perpendicular span (so dragging the
 * resize grip via cosSetSplitRatio works the same way as for internal
 * overlays — same mental model, different anchor).
 */
function externalOverlayStyle(
  popoutRect: DOMRect,
  ratio: number,
  isHorizontal: boolean,
  isFirst: boolean,
): Record<string, string | number> {
  const drawerSize = (isFirst ? ratio : 1 - ratio);
  if (isHorizontal) {
    const width = Math.max(120, popoutRect.width * drawerSize);
    if (isFirst) {
      // Drawer on the left edge of popout — extends leftward into page space.
      return {
        position: 'fixed',
        top: popoutRect.top,
        left: Math.max(0, popoutRect.left - width),
        width,
        height: popoutRect.height,
      };
    }
    return {
      position: 'fixed',
      top: popoutRect.top,
      left: popoutRect.left + popoutRect.width,
      width,
      height: popoutRect.height,
    };
  }
  const height = Math.max(120, popoutRect.height * drawerSize);
  if (isFirst) {
    return {
      position: 'fixed',
      top: Math.max(0, popoutRect.top - height),
      left: popoutRect.left,
      width: popoutRect.width,
      height,
    };
  }
  return {
    position: 'fixed',
    top: popoutRect.top + popoutRect.height,
    left: popoutRect.left,
    width: popoutRect.width,
    height,
  };
}


function CosLeafView({
  leaf,
  resolve,
  parentDir,
}: {
  leaf: LeafNode;
  resolve: (tabId: string) => ResolvedTab;
  parentDir: 'horizontal' | 'vertical' | null;
}) {
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [paneMenuOpen, setPaneMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);

  // Collapsed leaf — render a slim grab handle on the parent split's adjacent
  // edge. Click expands. Drag along the parent direction slides the handle's
  // position (collapsedOffset).
  if (leaf.collapsed) {
    return (
      <CollapsedLeaf leaf={leaf} parentDir={parentDir} resolve={resolve} />
    );
  }

  const isEmpty = leaf.tabs.length === 0;
  const activeId = !isEmpty && leaf.activeTabId && leaf.tabs.includes(leaf.activeTabId)
    ? leaf.activeTabId
    : leaf.tabs[0];
  const active = activeId ? resolve(activeId) : null;

  const paneLabel = leaf.tabs.length === 1 && activeId
    ? resolve(activeId).label
    : `Pane: ${leaf.tabs.length} tab${leaf.tabs.length === 1 ? '' : 's'}`;

  return (
    <div class={`cos-tree-leaf${isEmpty ? ' cos-tree-leaf-empty' : ''}`} data-cos-leaf-id={leaf.id}>
      <div class="cos-tree-tab-bar" role="tablist">
        <div class="cos-tree-tabs">
          {leaf.tabs.map((sid) => {
            const info = resolve(sid);
            const isActive = sid === activeId;
            return (
              <button
                key={sid}
                type="button"
                role="tab"
                aria-selected={isActive}
                class={`cos-tree-tab${isActive ? ' cos-tree-tab-active' : ''}`}
                title={info.label}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  startCosTabDrag(e, {
                    tabId: sid,
                    leafId: leaf.id,
                    label: info.label,
                    onClickFallback: () => cosSetActiveTab(leaf.id, sid),
                  });
                }}
              >
                {info.icon && (
                  <span class="cos-tree-tab-icon" aria-hidden="true">{info.icon}</span>
                )}
                <span class="cos-tree-tab-label">{info.label}</span>
                <span
                  class="cos-tree-tab-popout"
                  role="button"
                  tabIndex={0}
                  aria-label={`Pop out ${info.label} into a new window`}
                  title={`Pop out ${info.label}`}
                  onMouseDown={(e) => {
                    // Block the parent's drag handler; pop-out is a click, not a drag.
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    popOutCosTab(sid);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      popOutCosTab(sid);
                    }
                  }}
                >
                  {'⇱'}
                </span>
                {info.closable && (
                  <span
                    class="cos-tree-tab-close"
                    role="button"
                    tabIndex={0}
                    aria-label={`Close ${info.label}`}
                    onClick={(e) => { e.stopPropagation(); cosRemoveTabFromLeaf(leaf.id, sid); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        cosRemoveTabFromLeaf(leaf.id, sid);
                      }
                    }}
                  >
                    &times;
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div class="cos-tree-tab-actions">
          <button
            ref={plusRef}
            type="button"
            class="cos-tree-action-btn"
            title="Open companion…"
            onClick={(e) => { e.stopPropagation(); setPlusMenuOpen((v) => !v); }}
          >+</button>
          <button
            ref={hamburgerRef}
            type="button"
            class="cos-tree-action-btn"
            title="Pane actions (drag to move/dock the whole pane)"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              startCosLeafDrag(e, {
                leafId: leaf.id,
                label: paneLabel,
                onClickFallback: () => setPaneMenuOpen((v) => !v),
              });
            }}
          >{'☰'}</button>
          <button
            type="button"
            class="cos-tree-action-btn cos-tree-action-close"
            title="Close pane"
            onClick={(e) => { e.stopPropagation(); cosMergeLeaf(leaf.id); }}
          >{'×'}</button>
          {plusMenuOpen && (
            <PopupMenu anchorRef={plusRef} align="right" onClose={() => setPlusMenuOpen(false)}>
              <CosCompanionPickerItems leafId={leaf.id} closeMenu={() => setPlusMenuOpen(false)} />
            </PopupMenu>
          )}
          {paneMenuOpen && (
            <PopupMenu anchorRef={hamburgerRef} align="right" onClose={() => setPaneMenuOpen(false)}>
              <CosSplitSubmenu leafId={leaf.id} closeMenu={() => setPaneMenuOpen(false)} />
              <CosCollapseSubmenu leafId={leaf.id} closeMenu={() => setPaneMenuOpen(false)} />
              <CosPopoutSubmenu closeMenu={() => setPaneMenuOpen(false)} />
              <button
                class="popup-menu-item pane-action-item"
                onClick={() => { setPaneMenuOpen(false); cosMergeLeaf(leaf.id); }}
                title="Close this pane and merge tabs into the sibling"
              >
                <span class="pane-action-icon">{'×'}</span> Close Pane
              </button>
            </PopupMenu>
          )}
        </div>
      </div>
      <div class="cos-tree-leaf-body">
        {active ? active.content : <div class="cos-tree-empty-hint">Empty pane — use + to open a companion, or drag a tab here.</div>}
      </div>
      <CosDiagonalDropZone leafId={leaf.id} />
    </div>
  );
}

/**
 * Collapsed leaf renders as a slim handle on the parent split's adjacent
 * edge. Click expands; drag along the parent's parallel axis slides the
 * handle's offset (so the user can park it anywhere along the edge).
 */
function CollapsedLeaf({
  leaf,
  parentDir,
  resolve,
}: {
  leaf: LeafNode;
  parentDir: 'horizontal' | 'vertical' | null;
  resolve: (tabId: string) => ResolvedTab;
}) {
  const dragRef = useRef({ x: 0, y: 0, t: 0, moved: false, startOffset: 0 });
  const [dragging, setDragging] = useState(false);

  const labelText = leaf.tabs[0] ? resolve(leaf.tabs[0]).label : `${leaf.tabs.length} tab${leaf.tabs.length === 1 ? '' : 's'}`;
  const offset = leaf.collapsedOffset || 0;
  const offsetStyle = parentDir === 'horizontal'
    ? { transform: `translateY(${offset}px)` }
    : { transform: `translateX(${offset}px)` };

  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - dragRef.current.x;
      const dy = ev.clientY - dragRef.current.y;
      if (!dragRef.current.moved && Math.sqrt(dx * dx + dy * dy) > 3) {
        dragRef.current.moved = true;
      }
      // Slide along the parent's parallel axis.
      const delta = parentDir === 'horizontal' ? dy : dx;
      cosSetLeafCollapsedOffset(leaf.id, dragRef.current.startOffset + delta);
    }
    function onUp() {
      setDragging(false);
      // Click without drag → expand.
      if (!dragRef.current.moved && Date.now() - dragRef.current.t < 350) {
        cosToggleLeafCollapsed(leaf.id);
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, leaf.id, parentDir]);

  return (
    <div
      class={`cos-tree-leaf cos-tree-leaf-collapsed cos-tree-leaf-collapsed-${parentDir ?? 'horizontal'}`}
      data-cos-leaf-id={leaf.id}
      title={`Click to expand (${leaf.tabs.length} tab${leaf.tabs.length === 1 ? '' : 's'}): ${labelText}`}
      style={offsetStyle}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, startOffset: leaf.collapsedOffset || 0 };
        setDragging(true);
      }}
    >
      <span class="cos-tree-collapsed-icon">{parentDir === 'vertical' ? '▾' : '◂'}</span>
      <span class="cos-tree-collapsed-count">{leaf.tabs.length}</span>
      <span class="cos-tree-collapsed-label">{labelText}</span>
    </div>
  );
}

function CosSplitSubmenu({ leafId, closeMenu }: { leafId: string; closeMenu: () => void }) {
  return (
    <>
      <button
        class="popup-menu-item pane-action-item pane-submenu-child"
        onClick={() => { closeMenu(); cosSplitLeaf(leafId, 'horizontal', 'first', [], 0.5, true); }}
      >
        <span class="pane-action-icon">{'│'}</span> Split Left
      </button>
      <button
        class="popup-menu-item pane-action-item pane-submenu-child"
        onClick={() => { closeMenu(); cosSplitLeaf(leafId, 'horizontal', 'second', [], 0.5, true); }}
      >
        <span class="pane-action-icon">{'│'}</span> Split Right
      </button>
      <button
        class="popup-menu-item pane-action-item pane-submenu-child"
        onClick={() => { closeMenu(); cosSplitLeaf(leafId, 'vertical', 'first', [], 0.5, true); }}
      >
        <span class="pane-action-icon">{'─'}</span> Split Above
      </button>
      <button
        class="popup-menu-item pane-action-item pane-submenu-child"
        onClick={() => { closeMenu(); cosSplitLeaf(leafId, 'vertical', 'second', [], 0.5, true); }}
      >
        <span class="pane-action-icon">{'─'}</span> Split Down
      </button>
    </>
  );
}

function CosCollapseSubmenu({ leafId, closeMenu }: { leafId: string; closeMenu: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class="popup-menu-item pane-action-item pane-submenu-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Collapse to a slim grab handle on a chosen edge"
      >
        <span class="pane-action-icon">{'−'}</span> Collapse to Edge
        <span class="pane-submenu-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <button class="popup-menu-item pane-action-item pane-submenu-child" onClick={() => { setOpen(false); closeMenu(); cosCollapseLeafToEdge(leafId, 'W'); }}>
            <span class="pane-action-icon">{'◂'}</span> Collapse Left
          </button>
          <button class="popup-menu-item pane-action-item pane-submenu-child" onClick={() => { setOpen(false); closeMenu(); cosCollapseLeafToEdge(leafId, 'E'); }}>
            <span class="pane-action-icon">{'▸'}</span> Collapse Right
          </button>
          <button class="popup-menu-item pane-action-item pane-submenu-child" onClick={() => { setOpen(false); closeMenu(); cosCollapseLeafToEdge(leafId, 'N'); }}>
            <span class="pane-action-icon">{'▴'}</span> Collapse Up
          </button>
          <button class="popup-menu-item pane-action-item pane-submenu-child" onClick={() => { setOpen(false); closeMenu(); cosCollapseLeafToEdge(leafId, 'S'); }}>
            <span class="pane-action-icon">{'▾'}</span> Collapse Down
          </button>
        </>
      )}
    </>
  );
}

function CosPopoutSubmenu({ closeMenu }: { closeMenu: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        class="popup-menu-item pane-action-item pane-submenu-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Open this CoS pane in a separate browser tab or window"
      >
        <span class="pane-action-icon">{'⇱'}</span> Pop Out
        <span class="pane-submenu-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <button class="popup-menu-item pane-action-item pane-submenu-child" onClick={() => { setOpen(false); closeMenu(); openCosExternally('new-tab'); }}>
            <span class="pane-action-icon">{'↗'}</span> Open in New Browser Tab
          </button>
          <button class="popup-menu-item pane-action-item pane-submenu-child" onClick={() => { setOpen(false); closeMenu(); openCosExternally('new-window'); }}>
            <span class="pane-action-icon">{'⇲'}</span> Open in New Window
          </button>
        </>
      )}
    </>
  );
}

function CosCompanionPickerItems({ leafId, closeMenu }: { leafId: string; closeMenu: () => void }) {
  const learningsOpen = cosIsLearningsOpen();
  const threadOpen = cosIsThreadOpen();
  const slack = cosSlackMode.value;
  const active = cosActiveThread.value;
  const artifacts = cosArtifacts.value;
  const artifactList = Object.values(artifacts);

  return (
    <>
      <button
        class="popup-menu-item pane-action-item"
        onClick={() => {
          closeMenu();
          if (learningsOpen) cosToggleLearningsTab();
          else cosToggleLearningsTab('left');
        }}
      >
        <span class="pane-action-icon">★</span> {learningsOpen ? 'Close Learnings' : 'Open Learnings'}
      </button>
      <button
        class="popup-menu-item pane-action-item"
        disabled={!slack || !active}
        title={!slack ? 'Slack mode is off' : !active ? 'No active thread selected' : ''}
        onClick={() => {
          closeMenu();
          if (threadOpen) cosCloseThreadTab();
          else cosOpenThreadTab();
        }}
      >
        <span class="pane-action-icon">↳</span> {threadOpen ? 'Close Thread' : 'Open Thread'}
      </button>
      {artifactList.length > 0 && (
        <>
          <div class="popup-menu-section">Artifacts</div>
          {artifactList.map((art) => {
            const icon = art.kind === 'code' ? '❮❯' : art.kind === 'table' ? '▦' : '☰';
            return (
              <button
                key={art.id}
                class="popup-menu-item pane-action-item"
                onClick={() => { closeMenu(); cosOpenArtifactTab(art.id); }}
                title={art.label}
              >
                <span class="pane-action-icon">{icon}</span>
                <span class="cos-tree-picker-label">{art.label}</span>
              </button>
            );
          })}
        </>
      )}
      {artifactList.length === 0 && (
        <div class="popup-menu-empty">No artifacts in this thread yet</div>
      )}
      <div class="popup-menu-section">Pane</div>
      <CosSplitSubmenu leafId={leafId} closeMenu={closeMenu} />
    </>
  );
}

/**
 * Drop-zone visual overlay shown during a tab/leaf drag. Renders an edge-strip
 * highlight for left/right/top/bottom-edge zones and a diagonal split-zone for
 * h-split / v-split. The shared `dragOverLeafZone` signal is typed for the
 * main tree's narrower zone set; the cos-tab-drag widens it via cast and we
 * read a broader string here. Stay duck-typed.
 */
function CosDiagonalDropZone({ leafId }: { leafId: string }) {
  const zone = dragOverLeafZone.value;
  if (!zone || zone.leafId !== leafId) return null;
  const z = zone.zone as string;
  if (z === 'tab' || z === 'self-popout') return null;

  if (z === 'left-edge' || z === 'right-edge' || z === 'top-edge' || z === 'bottom-edge') {
    const label =
      z === 'left-edge' ? '◂ Dock Left' :
      z === 'right-edge' ? '▸ Dock Right' :
      z === 'top-edge' ? '▴ Dock Top' :
      '▾ Dock Bottom';
    return (
      <div class={`cos-edge-zone-overlay cos-edge-zone-${z}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 91 }}>
        <div class={`cos-edge-zone-fill cos-edge-zone-${z}-fill active`}>
          <span class="cos-edge-zone-label">{label}</span>
        </div>
      </div>
    );
  }

  return (
    <div class="diagonal-drop-zone" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 90 }}>
      <div class={`diagonal-zone diagonal-zone-vsplit${z === 'v-split' ? ' active' : ''}`}>
        <span class="diagonal-zone-label">{'═'} Split Down</span>
      </div>
      <div class={`diagonal-zone diagonal-zone-hsplit${z === 'h-split' ? ' active' : ''}`}>
        <span class="diagonal-zone-label">{'║'} Split Right</span>
      </div>
      <div class="diagonal-line" />
    </div>
  );
}
