import { type ComponentChildren, type VNode } from 'preact';
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
  COS_POPOUT_CHAT_TAB,
  COS_POPOUT_LEARNINGS_TAB,
  COS_POPOUT_THREAD_TAB,
  isArtifactTab,
  artifactIdFromTab,
} from '../../lib/cos-popout-tree.js';
import { cosArtifacts } from '../../lib/cos-artifacts.js';
import { ArtifactCompanionView } from '../files/ArtifactCompanionView.js';
import { startCosTabDrag, startCosLeafDrag } from '../../lib/cos-tab-drag.js';
import { dragOverLeafZone, openCosExternally } from '../../lib/tab-drag.js';

interface ResolvedTab {
  label: string;
  icon?: string;
  content: ComponentChildren;
  closable: boolean;
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
 * sibling fills 100% of the parent; the floating leaf is positioned absolutely
 * on the matching edge as a "companion drawer" overlay. A thin grab strip on
 * the drawer's inner edge resizes the split ratio.
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
  const sizePct = (isFirst ? node.ratio : 1 - node.ratio) * 100;

  const overlayStyle: Record<string, string | number> = isHorizontal
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

  const onResizeMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const onMove = (ev: MouseEvent) => {
      const rect = host.getBoundingClientRect();
      // The handle sits at the inner edge of the overlay regardless of which
      // edge it docks to, so the new "first child share" is just the cursor's
      // fractional position along the parent axis.
      const newRatio = isHorizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      cosSetSplitRatio(node.id, Math.max(0.1, Math.min(0.9, newRatio)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const grabClass = `cos-tree-floating-grab cos-tree-floating-grab-${
    isHorizontal ? (isFirst ? 'right' : 'left') : (isFirst ? 'bottom' : 'top')
  }`;

  return (
    <div
      ref={hostRef}
      class={`cos-tree-floating-host cos-tree-floating-host-${node.direction}${isFirst ? ' cos-tree-floating-host-first' : ' cos-tree-floating-host-second'}`}
    >
      <div class="cos-tree-floating-base">
        {renderNode(baseChild, resolve, parentDir)}
      </div>
      <div class="cos-tree-floating-overlay" style={overlayStyle}>
        {renderNode(floatChild, resolve, node.direction)}
        <div
          class={grabClass}
          onMouseDown={onResizeMouseDown}
          title="Drag to resize"
          aria-label="Resize companion drawer"
        />
      </div>
    </div>
  );
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
