import { type ComponentChildren, type VNode } from 'preact';
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
} from '../lib/cos-popout-tree.js';
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
}: {
  /** Tree snapshot. Passed by the parent (which subscribes to the signal) so
   *  Preact re-renders on mutation even inside an IIFE-shaped JSX expression. */
  tree: LayoutTree;
  chatContent: ComponentChildren;
  /** Render-prop for the learnings panel so the caller controls data loading. */
  learningsContent: ComponentChildren;
}) {
  function resolve(tabId: string): ResolvedTab {
    if (tabId === COS_POPOUT_CHAT_TAB) {
      return { label: 'Chat', content: chatContent, closable: false };
    }
    if (tabId === COS_POPOUT_LEARNINGS_TAB) {
      return { label: 'Learnings', icon: '★', content: learningsContent, closable: true };
    }
    if (tabId.startsWith('artifact:')) {
      const id = tabId.slice('artifact:'.length);
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
      {renderNode(tree.root, resolve)}
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
