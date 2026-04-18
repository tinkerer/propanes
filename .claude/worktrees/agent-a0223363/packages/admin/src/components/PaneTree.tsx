import { useCallback } from 'preact/hooks';
import type { PaneNode } from '../lib/pane-tree.js';
import { setSplitRatio, SIDEBAR_LEAF_ID, PAGE_LEAF_ID, SESSIONS_LEAF_ID } from '../lib/pane-tree.js';
import { sidebarWidth, persistPanelState } from '../lib/sessions.js';
import { SplitPane } from './SplitPane.js';
import { LeafPane } from './LeafPane.js';

interface PaneTreeProps {
  node: PaneNode;
  sidebarContent?: preact.ComponentChildren;
  pageContent?: preact.ComponentChildren;
}

export function PaneTree({ node, sidebarContent, pageContent }: PaneTreeProps) {
  const handleSidebarResize = useCallback((newSize: number) => {
    sidebarWidth.value = Math.max(140, Math.min(newSize, 600));
    persistPanelState();
  }, []);

  if (node.type === 'leaf') {
    if (node.id === SIDEBAR_LEAF_ID && sidebarContent) {
      return <>{sidebarContent}</>;
    }
    if (node.id === PAGE_LEAF_ID && pageContent) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
          {pageContent}
        </div>
      );
    }
    return <LeafPane leaf={node} />;
  }

  // Only hide the well-known sessions-leaf when it has no tabs (initial state).
  // Don't hide arbitrary empty leaves — they may be freshly created from a split.
  const hideSecond =
    node.children[1].type === 'leaf' &&
    node.children[1].id === SESSIONS_LEAF_ID &&
    node.children[1].tabs.length === 0;

  // Root split uses sidebar's pixel width instead of ratio
  const isSidebarSplit = node.id === 'root-split' &&
    node.children[0].type === 'leaf' &&
    node.children[0].id === SIDEBAR_LEAF_ID;

  return (
    <SplitPane
      direction={node.direction}
      ratio={node.ratio}
      splitId={node.id}
      onRatioChange={setSplitRatio}
      hideSecond={hideSecond}
      fixedFirstSize={isSidebarSplit ? sidebarWidth.value : undefined}
      onFixedResize={isSidebarSplit ? handleSidebarResize : undefined}
      first={<PaneTree node={node.children[0]} sidebarContent={sidebarContent} pageContent={pageContent} />}
      second={<PaneTree node={node.children[1]} sidebarContent={sidebarContent} pageContent={pageContent} />}
    />
  );
}
