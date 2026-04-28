import { type ComponentChildren, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SplitPane } from './SplitPane.js';
import {
  type PaneNode,
  type LeafNode,
  type LayoutTree,
} from '../lib/pane-tree.js';
import {
  cosSetSplitRatio,
  cosSetActiveTab,
  cosRemoveTabFromLeaf,
  cosSlackMode,
  cosActiveThread,
  COS_POPOUT_CHAT_TAB,
  COS_POPOUT_LEARNINGS_TAB,
} from '../lib/cos-popout-tree.js';
import {
  cosArtifactDrawer,
  closeArtifactDrawerTab,
  setActiveArtifactDrawerTab,
  setArtifactDrawerWidth,
  setArtifactDrawerVisible,
  ARTIFACT_DRAWER_MIN_WIDTH,
} from '../lib/cos-artifact-drawer.js';
import {
  cosThreadDrawer,
  setThreadDrawerWidth,
  setThreadDrawerVisible,
  THREAD_DRAWER_MIN_WIDTH,
} from '../lib/cos-thread-drawer.js';
import { cosArtifacts } from '../lib/cos-artifacts.js';
import { ArtifactCompanionView } from './ArtifactCompanionView.js';

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
      return { label: 'Chat', content: chatContent, closable: false };
    }
    if (tabId === COS_POPOUT_LEARNINGS_TAB) {
      return { label: 'Learnings', icon: '★', content: learningsContent, closable: true };
    }
    return { label: tabId, content: <div />, closable: false };
  }

  return (
    <div class="cos-tree-root">
      {renderNode(tree.root, resolve)}
      <ThreadDrawerOverlay content={threadContent} />
      <ArtifactDrawerOverlay />
    </div>
  );
}

/**
 * Walk a subtree and collect closable companion tabs (thread/learnings) it
 * contains. Used to drive divider grab tabs that toggle the secondary pane.
 */
function collectClosableTabs(node: PaneNode): { tabs: string[]; leafIds: Map<string, string> } {
  const tabs: string[] = [];
  const leafIds = new Map<string, string>();
  function walk(n: PaneNode) {
    if (n.type === 'leaf') {
      for (const t of n.tabs) {
        if (t === COS_POPOUT_LEARNINGS_TAB) {
          tabs.push(t);
          leafIds.set(t, n.id);
        }
      }
    } else {
      walk(n.children[0]);
      walk(n.children[1]);
    }
  }
  walk(node);
  return { tabs, leafIds };
}

function pickGrabIcon(tabs: string[]): string {
  return tabs.includes(COS_POPOUT_LEARNINGS_TAB) ? '★' : '┃';
}

function renderNode(
  node: PaneNode,
  resolve: (tabId: string) => ResolvedTab,
): VNode {
  if (node.type === 'leaf') {
    return <CosLeafView leaf={node} resolve={resolve} />;
  }

  // Determine which child holds the chat tab vs. the closable companion side.
  // The side without chat is what the divider grab tab toggles closed.
  const firstHasChat = subtreeHasTab(node.children[0], COS_POPOUT_CHAT_TAB);
  const sideChild = firstHasChat ? node.children[1] : node.children[0];
  const { tabs: sideTabs, leafIds } = collectClosableTabs(sideChild);
  const onDividerClick = sideTabs.length > 0
    ? () => {
        for (const t of sideTabs) {
          const lid = leafIds.get(t);
          if (lid) cosRemoveTabFromLeaf(lid, t);
        }
      }
    : undefined;

  return (
    <SplitPane
      direction={node.direction}
      ratio={node.ratio}
      splitId={node.id}
      onRatioChange={(splitId, ratio) => cosSetSplitRatio(splitId, ratio)}
      onDividerClick={onDividerClick}
      dividerGrabIcon={pickGrabIcon(sideTabs)}
      first={renderNode(node.children[0], resolve)}
      second={renderNode(node.children[1], resolve)}
    />
  );
}

function subtreeHasTab(node: PaneNode, tabId: string): boolean {
  if (node.type === 'leaf') return node.tabs.includes(tabId);
  return subtreeHasTab(node.children[0], tabId) || subtreeHasTab(node.children[1], tabId);
}

function CosLeafView({
  leaf,
  resolve,
}: {
  leaf: LeafNode;
  resolve: (tabId: string) => ResolvedTab;
}) {
  if (leaf.tabs.length === 0) {
    return <div class="cos-tree-leaf cos-tree-leaf-empty" />;
  }
  const activeId = leaf.activeTabId && leaf.tabs.includes(leaf.activeTabId)
    ? leaf.activeTabId
    : leaf.tabs[0];
  const active = resolve(activeId);
  // Hide the tab bar when the leaf holds only the chat tab — chat already has
  // its own agent/settings tab bar in the popout header, a second row would
  // look redundant. Any leaf with a companion or multiple tabs shows the bar.
  const isChatOnly = leaf.tabs.length === 1 && leaf.tabs[0] === COS_POPOUT_CHAT_TAB;

  return (
    <div class="cos-tree-leaf">
      {!isChatOnly && (
        <div class="cos-tree-tab-bar" role="tablist">
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
                onClick={() => cosSetActiveTab(leaf.id, sid)}
                title={info.label}
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
      )}
      <div class="cos-tree-leaf-body">
        {active.content}
      </div>
    </div>
  );
}

/**
 * Floating drawer that overlays the popout chat tree from the right edge.
 * Tabs across the top let the user switch between multiple open artifacts;
 * the left edge is a resize handle. Dragging the handle past the close
 * threshold (right of the right edge) closes the drawer entirely.
 */
function ArtifactDrawerOverlay() {
  const state = cosArtifactDrawer.value;
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragInfo = useRef({ x: 0, t: 0, moved: false });

  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: MouseEvent) {
      const root = containerRef.current?.parentElement;
      if (!root) return;
      if (!dragInfo.current.moved) {
        if (Math.abs(ev.clientX - dragInfo.current.x) > 3) dragInfo.current.moved = true;
      }
      const rect = root.getBoundingClientRect();
      // Drawer is anchored to the right edge of the tree root. New width =
      // distance from cursor to right edge.
      const next = Math.max(0, rect.right - ev.clientX);
      if (rect.right - ev.clientX < ARTIFACT_DRAWER_MIN_WIDTH / 2) {
        setArtifactDrawerWidth(ARTIFACT_DRAWER_MIN_WIDTH);
        return;
      }
      // Cap drawer width so it never extends past the SplitPane divider —
      // the drawer is supposed to overlay the side pane it's over (thread or
      // learnings), not creep over the chat. Falls back to 95% of the tree
      // root when there's no split (chat-only layout).
      const sideRight = root.querySelector(':scope > .pane-split > .pane-split-child:last-of-type') as HTMLElement | null;
      const maxWidth = sideRight
        ? sideRight.getBoundingClientRect().width
        : rect.width * 0.95;
      setArtifactDrawerWidth(Math.min(maxWidth, next));
    }
    function onUp() {
      setDragging(false);
      // Click without drag → toggle drawer visibility
      if (!dragInfo.current.moved && Date.now() - dragInfo.current.t < 350) {
        setArtifactDrawerVisible(!cosArtifactDrawer.value.visible);
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  if (state.tabs.length === 0) return null;

  const activeId = state.activeTabId && state.tabs.includes(state.activeTabId)
    ? state.activeTabId
    : state.tabs[0];

  // Collapsed: render only the grab tab on the right edge so the operator can
  // re-summon the drawer without losing tab state.
  if (!state.visible) {
    return (
      <div
        ref={containerRef}
        class="cos-artifact-drawer-overlay cos-artifact-drawer-overlay-collapsed"
      >
        <div
          class="cos-artifact-drawer-grab cos-artifact-drawer-grab-collapsed"
          onMouseDown={(e) => {
            e.preventDefault();
            dragInfo.current = { x: e.clientX, t: Date.now(), moved: false };
            setDragging(true);
          }}
          title="Click to expand, drag to resize"
        >
          <span class="grab-indicator">{'❮❯'}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      class={`cos-artifact-drawer-overlay${dragging ? ' cos-artifact-drawer-overlay-dragging' : ''}`}
      style={{ width: `${state.width}px` }}
    >
      <div
        class="cos-artifact-drawer-grab"
        onMouseDown={(e) => {
          e.preventDefault();
          dragInfo.current = { x: e.clientX, t: Date.now(), moved: false };
          setDragging(true);
        }}
        title="Click to collapse, drag to resize"
      >
        <span class="grab-indicator">{'❮❯'}</span>
      </div>
      <div class="cos-artifact-drawer-tabs" role="tablist">
        {state.tabs.map((id) => {
          const art = cosArtifacts.value[id];
          const icon = art?.kind === 'code' ? '❮❯' : art?.kind === 'table' ? '▦' : '☰';
          const label = art?.label || id;
          const isActive = id === activeId;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              class={`cos-artifact-drawer-tab${isActive ? ' cos-artifact-drawer-tab-active' : ''}`}
              onClick={() => setActiveArtifactDrawerTab(id)}
              title={label}
            >
              <span class="cos-artifact-drawer-tab-icon" aria-hidden="true">{icon}</span>
              <span class="cos-artifact-drawer-tab-label">{label}</span>
              <span
                class="cos-artifact-drawer-tab-close"
                role="button"
                tabIndex={0}
                aria-label={`Close ${label}`}
                onClick={(e) => { e.stopPropagation(); closeArtifactDrawerTab(id); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    closeArtifactDrawerTab(id);
                  }
                }}
              >
                &times;
              </span>
            </button>
          );
        })}
      </div>
      <div class="cos-artifact-drawer-body">
        {activeId && <ArtifactCompanionView artifactId={activeId} />}
      </div>
    </div>
  );
}

/**
 * Floating drawer that overlays the popout chat tree from the right edge,
 * mirroring the artifact drawer. Anchored at the same right edge as the
 * artifact drawer; the artifact drawer has a higher z-index so it stacks
 * over the thread when both are open. Renders only when slack mode is on
 * and there's an active thread.
 *
 * The thread itself (which agent / which thread key) is read from
 * `cosActiveThread` inside the passed-in content; this overlay only handles
 * sizing, the collapse/expand grab tab, and visibility.
 */
function ThreadDrawerOverlay({ content }: { content: ComponentChildren }) {
  const slack = cosSlackMode.value;
  const active = cosActiveThread.value;
  const state = cosThreadDrawer.value;
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragInfo = useRef({ x: 0, t: 0, moved: false });

  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: MouseEvent) {
      const root = containerRef.current?.parentElement;
      if (!root) return;
      if (!dragInfo.current.moved) {
        if (Math.abs(ev.clientX - dragInfo.current.x) > 3) dragInfo.current.moved = true;
      }
      const rect = root.getBoundingClientRect();
      // Anchor is the tree-root right edge — same anchor as the artifact
      // drawer. New width = distance from cursor to that edge.
      const next = Math.max(0, rect.right - ev.clientX);
      if (rect.right - ev.clientX < THREAD_DRAWER_MIN_WIDTH / 2) {
        setThreadDrawerWidth(THREAD_DRAWER_MIN_WIDTH);
        return;
      }
      const maxWidth = rect.width * 0.95;
      setThreadDrawerWidth(Math.min(maxWidth, next));
    }
    function onUp() {
      setDragging(false);
      if (!dragInfo.current.moved && Date.now() - dragInfo.current.t < 350) {
        setThreadDrawerVisible(!cosThreadDrawer.value.visible);
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  if (!slack || !active) return null;

  if (!state.visible) {
    return (
      <div
        ref={containerRef}
        class="cos-thread-drawer-overlay cos-thread-drawer-overlay-collapsed"
      >
        <div
          class="cos-thread-drawer-grab cos-thread-drawer-grab-collapsed"
          onMouseDown={(e) => {
            e.preventDefault();
            dragInfo.current = { x: e.clientX, t: Date.now(), moved: false };
            setDragging(true);
          }}
          title="Click to expand, drag to resize"
        >
          <span class="grab-indicator">{'↳'}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      class={`cos-thread-drawer-overlay${dragging ? ' cos-thread-drawer-overlay-dragging' : ''}`}
      style={{ width: `${state.width}px` }}
    >
      <div
        class="cos-thread-drawer-grab"
        onMouseDown={(e) => {
          e.preventDefault();
          dragInfo.current = { x: e.clientX, t: Date.now(), moved: false };
          setDragging(true);
        }}
        title="Click to collapse, drag to resize"
      >
        <span class="grab-indicator">{'↳'}</span>
      </div>
      <div class="cos-thread-drawer-body">
        {content}
      </div>
    </div>
  );
}
