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
  COS_POPOUT_CHAT_TAB,
  COS_POPOUT_LEARNINGS_TAB,
  COS_POPOUT_THREAD_TAB,
} from '../lib/cos-popout-tree.js';
import {
  cosArtifactDrawer,
  closeArtifactDrawerTab,
  setActiveArtifactDrawerTab,
  setArtifactDrawerWidth,
  ARTIFACT_DRAWER_MIN_WIDTH,
} from '../lib/cos-artifact-drawer.js';
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
    if (tabId === COS_POPOUT_THREAD_TAB) {
      return { label: 'Thread', icon: '↳', content: threadContent, closable: true };
    }
    return { label: tabId, content: <div />, closable: false };
  }

  return (
    <div class="cos-tree-root">
      {renderNode(tree.root, resolve)}
      <ArtifactDrawerOverlay />
    </div>
  );
}

function renderNode(
  node: PaneNode,
  resolve: (tabId: string) => ResolvedTab,
): VNode {
  if (node.type === 'leaf') {
    return <CosLeafView leaf={node} resolve={resolve} />;
  }
  return (
    <SplitPane
      direction={node.direction}
      ratio={node.ratio}
      splitId={node.id}
      onRatioChange={(splitId, ratio) => cosSetSplitRatio(splitId, ratio)}
      first={renderNode(node.children[0], resolve)}
      second={renderNode(node.children[1], resolve)}
    />
  );
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

  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: MouseEvent) {
      const root = containerRef.current?.parentElement;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      // Drawer is anchored to the right edge of the tree root. New width =
      // distance from cursor to right edge.
      const next = Math.max(0, rect.right - ev.clientX);
      // If the user drags the handle past the right edge (negative width
      // intent), close the drawer outright.
      if (rect.right - ev.clientX < ARTIFACT_DRAWER_MIN_WIDTH / 2) {
        // Don't auto-close mid-drag; just clamp to min. Closing happens on
        // mouseup if we ended below the threshold.
        setArtifactDrawerWidth(ARTIFACT_DRAWER_MIN_WIDTH);
        return;
      }
      // Cap at 95% of tree-root width so the chat stays peekable.
      const maxWidth = rect.width * 0.95;
      setArtifactDrawerWidth(Math.min(maxWidth, next));
    }
    function onUp() {
      setDragging(false);
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

  return (
    <div
      ref={containerRef}
      class={`cos-artifact-drawer-overlay${dragging ? ' cos-artifact-drawer-overlay-dragging' : ''}`}
      style={{ width: `${state.width}px` }}
    >
      <div
        class="cos-artifact-drawer-resize"
        onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
        title="Drag to resize, drag right to close"
      />
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
