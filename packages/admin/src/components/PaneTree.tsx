import { useCallback } from 'preact/hooks';
import type { PaneNode } from '../lib/pane-tree.js';
import { setSplitRatio, SIDEBAR_LEAF_ID, SESSIONS_LEAF_ID } from '../lib/pane-tree.js';
import { sidebarWidth, persistPanelState } from '../lib/sessions.js';
import { SplitPane } from './SplitPane.js';
import { LeafPane } from './LeafPane.js';

interface PaneTreeProps {
  node: PaneNode;
}

export function PaneTree({ node }: PaneTreeProps) {
  const handleSidebarResize = useCallback((newSize: number) => {
    sidebarWidth.value = Math.max(140, Math.min(newSize, 600));
    persistPanelState();
  }, []);

  if (node.type === 'leaf') {
    return <LeafPane leaf={node} />;
  }

  // Only hide the well-known sessions-leaf when it has no tabs (initial state).
  // Don't hide arbitrary empty leaves — they may be freshly created from a split.
  const hideSecond =
    node.children[1].type === 'leaf' &&
    node.children[1].id === SESSIONS_LEAF_ID &&
    node.children[1].tabs.length === 0;

  // Root split uses sidebar's pixel width instead of ratio
  const firstChild = node.children[0];
  const isSidebarSplit = node.id === 'root-split' && (
    (firstChild.type === 'leaf' && firstChild.id === SIDEBAR_LEAF_ID) ||
    (firstChild.type === 'split' && firstChild.id === 'sidebar-split')
  );

  const isCollapsed = (child: typeof node.children[0]) =>
    child.type === 'leaf' && !!child.collapsed;

  return (
    <SplitPane
      direction={node.direction}
      ratio={node.ratio}
      splitId={node.id}
      onRatioChange={setSplitRatio}
      hideSecond={hideSecond}
      fixedFirstSize={isSidebarSplit ? sidebarWidth.value : undefined}
      onFixedResize={isSidebarSplit ? handleSidebarResize : undefined}
      firstCollapsed={isCollapsed(node.children[0])}
      secondCollapsed={isCollapsed(node.children[1])}
      first={<PaneTree node={node.children[0]} />}
      second={<PaneTree node={node.children[1]} />}
    />
  );
}
