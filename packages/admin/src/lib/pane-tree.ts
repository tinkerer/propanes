import { signal, computed } from '@preact/signals';

// --- Types ---

export type SplitDirection = 'horizontal' | 'vertical';

/** High-level pane placement direction, mapped to (SplitDirection, 'first'|'second'). */
export type PanePosition = 'left' | 'right' | 'above' | 'below';

export function positionToSplit(position: PanePosition): { direction: SplitDirection; newPosition: 'first' | 'second' } {
  switch (position) {
    case 'left': return { direction: 'horizontal', newPosition: 'first' };
    case 'right': return { direction: 'horizontal', newPosition: 'second' };
    case 'above': return { direction: 'vertical', newPosition: 'first' };
    case 'below': return { direction: 'vertical', newPosition: 'second' };
  }
}

export interface SplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number; // 0-1, first child gets ratio
  children: [PaneNode, PaneNode];
}

export interface LeafNode {
  type: 'leaf';
  id: string;
  panelType: 'tabs' | 'sidebar';
  tabs: string[];
  activeTabId: string | null;
  singleton?: boolean;
  collapsed?: boolean;
  // When collapsed, the handle is rendered as an edge tab in the parent split.
  // `collapsedOffset` slides the handle along the parallel axis (pixels from
  // the default position). Bounded by the PaneTree at render time.
  collapsedOffset?: number;
}

export type PaneNode = SplitNode | LeafNode;

export interface LayoutTree {
  root: PaneNode;
  focusedLeafId: string | null;
}

// --- Well-known leaf IDs ---

export const SIDEBAR_LEAF_ID = 'sidebar-leaf';
export const PAGE_LEAF_ID = 'page-leaf';
export const SESSIONS_LEAF_ID = 'sessions-leaf';

// --- Persistence ---

const STORAGE_KEY = 'pw-layout-tree';

function loadTree(): LayoutTree | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveTree(tree: LayoutTree) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
  } catch {}
}

// --- Default layout ---

export function buildDefaultLayout(): LayoutTree {
  return {
    root: {
      type: 'split',
      id: 'root-split',
      direction: 'horizontal',
      ratio: 0.15,
      children: [
        {
          type: 'split',
          id: 'sidebar-split',
          direction: 'vertical',
          ratio: 0.35,
          children: [
            {
              type: 'leaf',
              id: SIDEBAR_LEAF_ID,
              panelType: 'tabs',
              tabs: ['view:nav'],
              activeTabId: 'view:nav',
              singleton: true,
            },
            {
              type: 'split',
              id: 'sidebar-lower',
              direction: 'vertical',
              ratio: 0.45,
              children: [
                {
                  type: 'leaf',
                  id: 'sidebar-sessions',
                  panelType: 'tabs',
                  tabs: ['view:sessions-list'],
                  activeTabId: 'view:sessions-list',
                  singleton: true,
                },
                {
                  type: 'split',
                  id: 'sidebar-bottom',
                  direction: 'vertical',
                  ratio: 0.5,
                  children: [
                    {
                      type: 'leaf',
                      id: 'sidebar-terminals',
                      panelType: 'tabs',
                      tabs: ['view:terminals'],
                      activeTabId: 'view:terminals',
                      singleton: true,
                    },
                    {
                      type: 'leaf',
                      id: 'sidebar-files',
                      panelType: 'tabs',
                      tabs: ['view:files'],
                      activeTabId: 'view:files',
                      singleton: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'split',
          id: 'content-split',
          direction: 'vertical',
          ratio: 1.0,
          children: [
            {
              type: 'leaf',
              id: PAGE_LEAF_ID,
              panelType: 'tabs',
              tabs: ['view:feedback'],
              activeTabId: 'view:feedback',
              singleton: true,
            },
            {
              type: 'leaf',
              id: SESSIONS_LEAF_ID,
              panelType: 'tabs',
              tabs: [],
              activeTabId: null,
            },
          ],
        },
      ],
    },
    focusedLeafId: PAGE_LEAF_ID,
  };
}

// --- Migration ---

function migrateTree(tree: LayoutTree): LayoutTree {
  function find(node: PaneNode, id: string): LeafNode | null {
    if (node.type === 'leaf') return node.id === id ? node : null;
    if (node.type === 'split') return find(node.children[0], id) ?? find(node.children[1], id);
    return null;
  }
  function findParentOf(root: PaneNode, id: string): SplitNode | null {
    if (root.type === 'leaf') return null;
    if (root.children[0].id === id || root.children[1].id === id) return root;
    return findParentOf(root.children[0], id) ?? findParentOf(root.children[1], id);
  }
  const sidebar = find(tree.root, SIDEBAR_LEAF_ID);
  if (sidebar) {
    // Fix old panelType
    if (sidebar.panelType === 'sidebar') sidebar.panelType = 'tabs';
    // Ensure nav tab exists
    if (!sidebar.tabs.includes('view:nav')) {
      sidebar.tabs.unshift('view:nav');
      if (!sidebar.activeTabId) sidebar.activeTabId = 'view:nav';
    }
    // Remove sessions-list from nav leaf (it belongs in its own leaf now)
    sidebar.tabs = sidebar.tabs.filter(t => t !== 'view:sessions-list');
    if (sidebar.activeTabId === 'view:sessions-list') sidebar.activeTabId = sidebar.tabs[0] ?? null;
  }
  // If there's no sidebar-sessions leaf, create one by wrapping sidebar-leaf in a split
  const sidebarSessionsLeaf = find(tree.root, 'sidebar-sessions');
  if (!sidebarSessionsLeaf && sidebar) {
    const parent = findParentOf(tree.root, SIDEBAR_LEAF_ID);
    if (parent) {
      const idx = parent.children[0].id === SIDEBAR_LEAF_ID ? 0 : 1;
      const newSplit: SplitNode = {
        type: 'split',
        id: 'sidebar-split',
        direction: 'vertical',
        ratio: 0.35,
        children: [
          { ...sidebar },
          { type: 'leaf', id: 'sidebar-sessions', panelType: 'tabs', tabs: ['view:sessions-list'], activeTabId: 'view:sessions-list' },
        ],
      };
      parent.children[idx] = newSplit as any;
    }
  } else if (sidebarSessionsLeaf) {
    // Ensure sessions leaf has the sessions-list tab
    if (!sidebarSessionsLeaf.tabs.includes('view:sessions-list')) {
      sidebarSessionsLeaf.tabs.unshift('view:sessions-list');
      if (!sidebarSessionsLeaf.activeTabId) sidebarSessionsLeaf.activeTabId = 'view:sessions-list';
    }
  }
  // Migrate page-leaf: replace view:page with view:feedback
  const pageLeaf = find(tree.root, PAGE_LEAF_ID);
  if (pageLeaf) {
    const hasPageView = pageLeaf.tabs.includes('view:page');
    const hasFeedback = pageLeaf.tabs.includes('view:feedback');
    if (hasPageView && !hasFeedback) {
      pageLeaf.tabs = pageLeaf.tabs.map(t => t === 'view:page' ? 'view:feedback' : t);
      if (pageLeaf.activeTabId === 'view:page') pageLeaf.activeTabId = 'view:feedback';
    } else if (pageLeaf.tabs.length === 0) {
      pageLeaf.tabs = ['view:feedback'];
      pageLeaf.activeTabId = 'view:feedback';
    }
  }

  // Migrate singleton flags on well-known leaves
  const singletonLeafIds = [SIDEBAR_LEAF_ID, 'sidebar-sessions', 'sidebar-terminals', 'sidebar-files', PAGE_LEAF_ID];
  for (const id of singletonLeafIds) {
    const leaf = find(tree.root, id);
    if (leaf && !leaf.singleton) leaf.singleton = true;
  }

  // Migrate: remove controlbar-leaf — the ControlBar is always rendered in the
  // fixed top bar by Layout.tsx, so the in-tree pane was a duplicate.
  const controlbarLeaf = find(tree.root, 'controlbar-leaf');
  if (controlbarLeaf) {
    const pageLeaf = find(tree.root, PAGE_LEAF_ID);
    if (pageLeaf) {
      for (const t of controlbarLeaf.tabs) {
        if (t !== 'view:controlbar' && !pageLeaf.tabs.includes(t)) pageLeaf.tabs.push(t);
      }
    }
    const parent = findParentOf(tree.root, 'controlbar-leaf');
    if (parent) {
      const sibling = parent.children[0].id === 'controlbar-leaf' ? parent.children[1] : parent.children[0];
      const grandparent = findParentOf(tree.root, parent.id);
      if (grandparent) {
        const idx = grandparent.children[0].id === parent.id ? 0 : 1;
        grandparent.children[idx] = sibling;
      } else {
        tree.root = sibling;
      }
    }
  }

  return tree;
}

// --- Signals ---

export const layoutTree = signal<LayoutTree>((() => {
  const loaded = loadTree();
  if (loaded) return migrateTree(loaded);
  return buildDefaultLayout();
})());
export const focusedLeafId = signal<string | null>(layoutTree.value.focusedLeafId);

function persist() {
  const tree = layoutTree.value;
  tree.focusedLeafId = focusedLeafId.value;
  saveTree(tree);
}

// --- Tree traversal helpers ---

export function findLeaf(node: PaneNode, leafId: string): LeafNode | null {
  if (node.type === 'leaf') return node.id === leafId ? node : null;
  return findLeaf(node.children[0], leafId) ?? findLeaf(node.children[1], leafId);
}

export function getAllLeaves(node: PaneNode): LeafNode[] {
  if (node.type === 'leaf') return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

export function findLeafWithTab(tabId: string, node?: PaneNode): LeafNode | null {
  const root = node ?? getLatestTree().root;
  if (root.type === 'leaf') return root.tabs.includes(tabId) ? root : null;
  return findLeafWithTab(tabId, root.children[0]) ?? findLeafWithTab(tabId, root.children[1]);
}

export function findParent(root: PaneNode, nodeId: string): SplitNode | null {
  if (root.type === 'leaf') return null;
  if (root.children[0].id === nodeId || root.children[1].id === nodeId) return root;
  return findParent(root.children[0], nodeId) ?? findParent(root.children[1], nodeId);
}

// Find a sibling leaf suitable for hosting companion tabs.
// Accepts any sibling that is empty or consists entirely of companion tabs
// (from any session), so all companions share one pane instead of each
// session spawning a new split.
export function findCompanionSibling(sessionLeafId: string, _sessionId: string): LeafNode | null {
  const tree = getLatestTree();
  const parent = findParent(tree.root, sessionLeafId);
  if (!parent) return null;
  const sibling = parent.children[0].id === sessionLeafId ? parent.children[1] : parent.children[0];
  if (sibling.type !== 'leaf') return null;
  const companionPrefixes = ['jsonl:', 'summary:', 'feedback:', 'iframe:', 'terminal:', 'isolate:', 'url:', 'file:', 'wiggum-runs:', 'artifact:'];
  const allTabsAreCompanions = sibling.tabs.every(t =>
    companionPrefixes.some(prefix => t.startsWith(prefix))
  );
  if (allTabsAreCompanions) return sibling;
  return null;
}

// Deep clone to ensure immutability (use structuredClone for speed)
function cloneTree(tree: LayoutTree): LayoutTree {
  return structuredClone(tree);
}

function cloneNode(node: PaneNode): PaneNode {
  return structuredClone(node);
}

// --- Batching: defer signal update + persist until batch completes ---

let _batchDepth = 0;
let _batchTree: LayoutTree | null = null;

/** Run multiple tree mutations as a single signal update. */
export function batch(fn: () => void) {
  _batchDepth++;
  try {
    fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0 && _batchTree) {
      _scheduleFlush(_batchTree);
      _batchTree = null;
    }
  }
}

/**
 * Commit a cloned tree — debounced via requestAnimationFrame.
 * Multiple mutations within a single frame coalesce into one signal update.
 */
let _pendingTree: LayoutTree | null = null;
let _rafId = 0;

function _scheduleFlush(tree: LayoutTree) {
  _pendingTree = tree;
  if (!_rafId) {
    _rafId = requestAnimationFrame(_flushCommit);
  }
}

function _flushCommit() {
  _rafId = 0;
  if (!_pendingTree) return;
  const tree = _pendingTree;
  _pendingTree = null;
  layoutTree.value = tree;
  persist();
}

function commitTree(tree: LayoutTree) {
  if (_batchDepth > 0) {
    _batchTree = tree;
  } else {
    _scheduleFlush(tree);
  }
}

/**
 * Returns the most up-to-date tree state: batch tree if batching, pending
 * RAF-scheduled tree if one is queued, otherwise the committed signal value.
 * Use this as the clone source in all mutations so consecutive mutations in
 * the same frame see each other's changes instead of racing.
 */
function getLatestTree(): LayoutTree {
  if (_batchDepth > 0 && _batchTree) return _batchTree;
  if (_pendingTree) return _pendingTree;
  return layoutTree.value;
}

// --- Tree mutation functions (all immutable — clone, mutate, assign) ---

let _idCounter = 0;
function genId(prefix = 'pane'): string {
  return `${prefix}-${++_idCounter}-${Date.now().toString(36)}`;
}

export function splitLeaf(
  leafId: string,
  direction: SplitDirection,
  newPosition: 'first' | 'second' = 'second',
  newTabs: string[] = [],
  ratio = 0.5,
  moveActiveTab = false,
): LeafNode | null {
  const tree = cloneTree(getLatestTree());
  const parent = findParent(tree.root, leafId);
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return null;

  // If moveActiveTab is set and no explicit newTabs, move the active tab from the original leaf
  const tabsForNew = [...newTabs];
  if (moveActiveTab && tabsForNew.length === 0 && leaf.activeTabId && leaf.tabs.length > 1) {
    const movingTab = leaf.activeTabId;
    tabsForNew.push(movingTab);
    leaf.tabs = leaf.tabs.filter(t => t !== movingTab);
    leaf.activeTabId = leaf.tabs[0] ?? null;
  }

  const newLeaf: LeafNode = {
    type: 'leaf',
    id: genId('leaf'),
    panelType: 'tabs',
    tabs: tabsForNew,
    activeTabId: tabsForNew[0] ?? null,
  };

  const newSplit: SplitNode = {
    type: 'split',
    id: genId('split'),
    direction,
    ratio,
    children: newPosition === 'second'
      ? [cloneNode(leaf) as LeafNode, newLeaf]
      : [newLeaf, cloneNode(leaf) as LeafNode],
  };

  // Replace the leaf with the new split in the tree
  if (!parent) {
    // The leaf IS the root
    tree.root = newSplit;
  } else {
    if (parent.children[0].id === leafId) parent.children[0] = newSplit;
    else parent.children[1] = newSplit;
  }

  commitTree(tree);
  return newLeaf;
}

/**
 * Split a leaf and place the new pane at a directional position
 * (left / right / above / below). Thin wrapper around splitLeaf.
 */
export function splitLeafAtPosition(
  leafId: string,
  position: PanePosition,
  newTabs: string[] = [],
  ratio = 0.5,
  moveActiveTab = false,
): LeafNode | null {
  const { direction, newPosition } = positionToSplit(position);
  return splitLeaf(leafId, direction, newPosition, newTabs, ratio, moveActiveTab);
}

export function mergeLeaf(leafId: string) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  const parent = findParent(tree.root, leafId);
  if (!parent) return; // Can't merge root

  const sibling = parent.children[0].id === leafId ? parent.children[1] : parent.children[0];

  // Transfer any remaining tabs from the removed leaf to the first leaf in the sibling
  if (leaf && leaf.tabs.length > 0) {
    const targetLeaves = getAllLeaves(sibling);
    const target = targetLeaves[0];
    if (target) {
      for (const t of leaf.tabs) {
        if (!target.tabs.includes(t)) target.tabs.push(t);
      }
      if (!target.activeTabId && leaf.activeTabId) {
        target.activeTabId = leaf.activeTabId;
      }
    }
  }

  const grandparent = findParent(tree.root, parent.id);

  if (!grandparent) {
    // Parent is root — promote sibling to root
    tree.root = cloneNode(sibling);
  } else {
    if (grandparent.children[0].id === parent.id) grandparent.children[0] = cloneNode(sibling);
    else grandparent.children[1] = cloneNode(sibling);
  }

  // If focused leaf was removed, focus the sibling (or first leaf in sibling)
  if (focusedLeafId.value === leafId) {
    const leaves = getAllLeaves(tree.root === sibling ? tree.root : sibling);
    focusedLeafId.value = leaves[0]?.id ?? null;
  }

  commitTree(tree);
}

export function addTabToLeaf(leafId: string, tabId: string, activate = true) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;

  // Invariant: a tab lives in at most one leaf. Remove from any other leaf so
  // drag/drop races and stale state can't produce duplicates.
  const orphanedLeafIds: string[] = [];
  for (const other of getAllLeaves(tree.root)) {
    if (other.id === leafId) continue;
    if (other.tabs.includes(tabId)) {
      other.tabs = other.tabs.filter(t => t !== tabId);
      if (other.activeTabId === tabId) {
        other.activeTabId = other.tabs[0] ?? null;
      }
      if (other.tabs.length === 0 && !isWellKnownLeaf(other.id)) {
        orphanedLeafIds.push(other.id);
      }
    }
  }

  if (!leaf.tabs.includes(tabId)) {
    leaf.tabs.push(tabId);
  }
  if (activate) {
    leaf.activeTabId = tabId;
  }

  commitTree(tree);

  for (const id of orphanedLeafIds) mergeLeaf(id);
}

export function removeTabFromLeaf(leafId: string, tabId: string, autoMerge = true) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;

  leaf.tabs = leaf.tabs.filter(t => t !== tabId);
  if (leaf.activeTabId === tabId) {
    leaf.activeTabId = leaf.tabs[0] ?? null;
  }

  commitTree(tree);

  // Auto-merge empty non-well-known leaves
  if (autoMerge && leaf.tabs.length === 0 && !isWellKnownLeaf(leafId)) {
    mergeLeaf(leafId);
  }
}

export function setActiveTab(leafId: string, tabId: string) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf || !leaf.tabs.includes(tabId)) return;
  leaf.activeTabId = tabId;
  commitTree(tree);
}

export function replaceTabInLeaf(leafId: string, oldTabId: string, newTabId: string) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;
  const idx = leaf.tabs.indexOf(oldTabId);
  if (idx === -1) return;
  leaf.tabs[idx] = newTabId;
  if (leaf.activeTabId === oldTabId) {
    leaf.activeTabId = newTabId;
  }
  commitTree(tree);
}

export function moveTab(fromLeafId: string, toLeafId: string, tabId: string) {
  if (fromLeafId === toLeafId) return;
  const tree = cloneTree(getLatestTree());
  const from = findLeaf(tree.root, fromLeafId);
  const to = findLeaf(tree.root, toLeafId);
  if (!from || !to) return;

  from.tabs = from.tabs.filter(t => t !== tabId);
  if (from.activeTabId === tabId) {
    from.activeTabId = from.tabs[0] ?? null;
  }

  if (!to.tabs.includes(tabId)) {
    to.tabs.push(tabId);
  }
  to.activeTabId = tabId;

  commitTree(tree);

  // Auto-merge empty non-well-known leaves
  if (from.tabs.length === 0 && !isWellKnownLeaf(fromLeafId)) {
    mergeLeaf(fromLeafId);
  }
}

// Minimum pixel size for a leaf pane. When a divider drag would push the
// adjacent leaf below this, the deficit cascades to the next sibling along the
// drag axis (instead of the drag stopping).
const MIN_LEAF_PX = 60;
const COLLAPSED_LEAF_PX = 28;
const DIVIDER_PX = 4;

/**
 * Recursive minimum size of a subtree along the given axis. For splits in the
 * same direction, mins sum (with divider). For splits in the perpendicular
 * direction, mins take the max (each child must fit within the constrained
 * dimension).
 */
function getMinSize(node: PaneNode, axis: SplitDirection): number {
  if (node.type === 'leaf') {
    return node.collapsed ? COLLAPSED_LEAF_PX : MIN_LEAF_PX;
  }
  const a = getMinSize(node.children[0], axis);
  const b = getMinSize(node.children[1], axis);
  if (node.direction === axis) return a + b + DIVIDER_PX;
  return Math.max(a, b);
}

export function setSplitRatio(splitId: string, ratio: number, containerSizePx?: number) {
  const tree = cloneTree(getLatestTree());
  const node = findNodeById(tree.root, splitId);
  if (!node || node.type !== 'split') return;

  const oldRatio = node.ratio;

  // Pixel-aware clamp: enforce minimum size for each side based on the actual
  // recursive minimum of its subtree (so cascading can absorb the rest).
  let clamped: number;
  if (containerSizePx && containerSizePx > 0) {
    const firstMin = getMinSize(node.children[0], node.direction);
    const secondMin = getMinSize(node.children[1], node.direction);
    const minRatio = Math.min(0.499, firstMin / containerSizePx);
    const maxRatio = Math.max(0.501, 1 - secondMin / containerSizePx);
    clamped = Math.max(minRatio, Math.min(maxRatio, ratio));
  } else {
    clamped = Math.max(0.05, Math.min(0.95, ratio));
  }

  node.ratio = clamped;

  const [first, second] = node.children;

  if (containerSizePx && containerSizePx > 0) {
    // Cascade: distribute the new pixel size for each side into nested
    // same-direction splits, shrinking the pane closest to the outer divider
    // first (down to its min), then continuing into the next pane.
    const firstNewPx = clamped * containerSizePx;
    const secondNewPx = (1 - clamped) * containerSizePx;
    const firstOldPx = oldRatio * containerSizePx;
    const secondOldPx = (1 - oldRatio) * containerSizePx;
    if (first.type === 'split' && first.direction === node.direction) {
      cascadeResize(first, firstOldPx, firstNewPx, 1);
    }
    if (second.type === 'split' && second.direction === node.direction) {
      cascadeResize(second, secondOldPx, secondNewPx, 0);
    }
  } else {
    // Fallback (no container size): preserve non-adjacent absolute sizes
    // as before. This path is hit only by callers that don't pass container
    // size (currently none; kept for safety).
    if (first.type === 'split' && first.direction === node.direction) {
      preserveNonAdjacentSizes(first, oldRatio, clamped, 1);
    }
    if (second.type === 'split' && second.direction === node.direction) {
      preserveNonAdjacentSizes(second, 1 - oldRatio, 1 - clamped, 0);
    }
  }

  commitTree(tree);
}

/**
 * Resize a same-direction nested split so its new total pixel size is
 * newSizePx. The sub-pane on the side `adjacentChildIndex` (the one closest to
 * the outer divider) absorbs the change first; once it hits its minimum, the
 * far sub-pane starts shrinking. This makes a chain of splits behave like one
 * continuous track for the user dragging the divider.
 */
function cascadeResize(
  node: SplitNode,
  oldSizePx: number,
  newSizePx: number,
  adjacentChildIndex: 0 | 1,
) {
  if (oldSizePx < 0.001 || newSizePx < 0.001) return;

  const adjChild = node.children[adjacentChildIndex];
  const farChild = node.children[1 - adjacentChildIndex];

  const oldAdjSize = (adjacentChildIndex === 1 ? (1 - node.ratio) : node.ratio) * oldSizePx;
  const oldFarSize = oldSizePx - oldAdjSize;

  const adjMin = getMinSize(adjChild, node.direction);
  const farMin = getMinSize(farChild, node.direction);

  let newFarSize: number;
  let newAdjSize: number;
  if (newSizePx >= oldFarSize + adjMin) {
    // Far stays put; the adjacent absorbs the entire size change.
    newFarSize = oldFarSize;
    newAdjSize = newSizePx - oldFarSize;
  } else if (newSizePx >= adjMin + farMin) {
    // Adjacent pinned at its minimum; the far pane absorbs the rest.
    newAdjSize = adjMin;
    newFarSize = newSizePx - adjMin;
  } else {
    // Even both at minimum won't fit; distribute proportionally to the mins.
    const total = adjMin + farMin;
    newAdjSize = newSizePx * (adjMin / total);
    newFarSize = newSizePx - newAdjSize;
  }

  const newRatio = adjacentChildIndex === 1
    ? newFarSize / newSizePx
    : newAdjSize / newSizePx;
  node.ratio = Math.max(0.001, Math.min(0.999, newRatio));

  if (adjChild.type === 'split' && adjChild.direction === node.direction) {
    cascadeResize(adjChild, oldAdjSize, newAdjSize, adjacentChildIndex);
  }
  if (farChild.type === 'split' && farChild.direction === node.direction) {
    const farIndex: 0 | 1 = adjacentChildIndex === 1 ? 0 : 1;
    cascadeResize(farChild, oldFarSize, newFarSize, farIndex);
  }
}

/**
 * Legacy fallback: when a same-direction child split's container resizes,
 * adjust its ratio so that the sub-panel NOT adjacent to the external divider
 * keeps its absolute size. Used only when container size is unavailable.
 */
function preserveNonAdjacentSizes(
  node: SplitNode,
  oldProportion: number,
  newProportion: number,
  adjacentChildIndex: 0 | 1,
) {
  if (newProportion < 0.001 || oldProportion < 0.001) return;

  const oldRatio = node.ratio;
  let newRatio: number;

  if (adjacentChildIndex === 1) {
    newRatio = oldRatio * oldProportion / newProportion;
  } else {
    newRatio = 1 - (1 - oldRatio) * oldProportion / newProportion;
  }

  node.ratio = Math.max(0.05, Math.min(0.95, newRatio));

  const adjChild = node.children[adjacentChildIndex];
  if (adjChild.type === 'split' && adjChild.direction === node.direction) {
    const oldAdj = adjacentChildIndex === 1
      ? (1 - oldRatio) * oldProportion
      : oldRatio * oldProportion;
    const newAdj = adjacentChildIndex === 1
      ? (1 - node.ratio) * newProportion
      : node.ratio * newProportion;
    preserveNonAdjacentSizes(adjChild, oldAdj, newAdj, adjacentChildIndex);
  }
}

export function setFocusedLeaf(leafId: string | null) {
  focusedLeafId.value = leafId;
  persist();
}

export function toggleLeafCollapsed(leafId: string) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsed = !leaf.collapsed;
  // Reset offset when opening back up — otherwise the next collapse would
  // inherit a stale slide position from a previous session.
  if (!leaf.collapsed) leaf.collapsedOffset = 0;
  commitTree(tree);
}

export function setLeafCollapsed(leafId: string, collapsed: boolean) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf || leaf.collapsed === collapsed) return;
  leaf.collapsed = collapsed;
  if (!collapsed) leaf.collapsedOffset = 0;
  commitTree(tree);
}

export function setLeafCollapsedOffset(leafId: string, offset: number) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsedOffset = offset;
  commitTree(tree);
}

/**
 * Collapse a leaf to a specific edge of its parent split. If the parent's
 * direction doesn't align with the desired edge, we swap the parent's
 * direction and child order so the collapsed handle lives on the chosen edge.
 *
 * Edge → (parent direction, leaf position in parent):
 *   'W' left  → horizontal, first
 *   'E' right → horizontal, second
 *   'N' top   → vertical,   first
 *   'S' bottom→ vertical,   second
 */
export function collapseLeafToEdge(leafId: string, edge: 'N' | 'S' | 'E' | 'W') {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  const parent = findParent(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsed = true;
  leaf.collapsedOffset = 0;

  if (parent) {
    const wantDir: SplitDirection = (edge === 'E' || edge === 'W') ? 'horizontal' : 'vertical';
    const wantFirst = (edge === 'W' || edge === 'N');
    const currentIdx = parent.children[0].id === leafId ? 0 : 1;
    const currentFirst = currentIdx === 0;

    if (parent.direction !== wantDir) {
      parent.direction = wantDir;
    }
    if (currentFirst !== wantFirst) {
      // Swap children so leaf sits on the correct side.
      const other = parent.children[currentIdx === 0 ? 1 : 0];
      parent.children = wantFirst
        ? [parent.children[currentIdx], other] as [PaneNode, PaneNode]
        : [other, parent.children[currentIdx]] as [PaneNode, PaneNode];
      // Flip ratio so the non-leaf side keeps its share.
      parent.ratio = 1 - parent.ratio;
    }
  }

  commitTree(tree);
}

// --- Utilities ---

function isWellKnownLeaf(id: string): boolean {
  return id === SIDEBAR_LEAF_ID || id === PAGE_LEAF_ID || id === SESSIONS_LEAF_ID;
}

function findNodeById(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  if (node.type === 'split') {
    return findNodeById(node.children[0], id) ?? findNodeById(node.children[1], id);
  }
  return null;
}

// --- Backward compatibility bridge (computed from tree) ---

export const treeOpenTabs = computed(() => {
  const leaf = findLeaf(layoutTree.value.root, SESSIONS_LEAF_ID);
  return leaf?.tabs ?? [];
});

export const treeActiveTabId = computed(() => {
  const leaf = findLeaf(layoutTree.value.root, SESSIONS_LEAF_ID);
  return leaf?.activeTabId ?? null;
});

export const treeSessionsLeafHasTabs = computed(() => {
  return treeOpenTabs.value.length > 0;
});

// --- Main-split ratio auto-adjust ---

export function showSessionsLeaf() {
  const tree = cloneTree(getLatestTree());
  // Find the split that directly contains the sessions-leaf
  const parent = findParentSplit(tree.root, SESSIONS_LEAF_ID);
  if (parent && parent.type === 'split' && parent.ratio >= 0.95) {
    parent.ratio = 0.6;
    commitTree(tree);
  }
}

/**
 * Ensure SESSIONS_LEAF_ID exists in the tree.
 * If it doesn't, create a vertical split in the main content area.
 * Returns the leaf ID to use for adding sessions.
 */
export function ensureSessionsLeaf(): string {
  const current = getLatestTree();
  const existing = findLeaf(current.root, SESSIONS_LEAF_ID);
  if (existing) return SESSIONS_LEAF_ID;

  // Sessions leaf doesn't exist — create one by splitting an appropriate leaf.
  // Strategy: find the focused leaf, or any non-sidebar/non-controlbar leaf in the main area.
  const tree = cloneTree(current);
  const allLeaves = getAllLeaves(tree.root);
  const sidebarIds = new Set([SIDEBAR_LEAF_ID, 'sidebar-sessions', 'sidebar-terminals', 'sidebar-files']);
  const mainLeaf = allLeaves.find(l => !sidebarIds.has(l.id)) || allLeaves[0];
  if (!mainLeaf) return SESSIONS_LEAF_ID; // shouldn't happen

  // Split the chosen leaf vertically, placing a new sessions leaf at the bottom
  const newSessionsLeaf: LeafNode = {
    type: 'leaf',
    id: SESSIONS_LEAF_ID,
    panelType: 'tabs',
    tabs: [],
    activeTabId: null,
  };

  const parent = findParent(tree.root, mainLeaf.id);
  const newSplit: SplitNode = {
    type: 'split',
    id: genId('split'),
    direction: 'vertical',
    ratio: 0.6,
    children: [cloneNode(mainLeaf) as LeafNode, newSessionsLeaf],
  };

  if (!parent) {
    tree.root = newSplit;
  } else {
    if (parent.children[0].id === mainLeaf.id) parent.children[0] = newSplit;
    else parent.children[1] = newSplit;
  }

  commitTree(tree);
  return SESSIONS_LEAF_ID;
}

export function hideSessionsLeaf() {
  const tree = cloneTree(getLatestTree());
  const parent = findParentSplit(tree.root, SESSIONS_LEAF_ID);
  if (parent && parent.type === 'split') {
    parent.ratio = 1.0;
    commitTree(tree);
  }
}

function findParentSplit(node: PaneNode, childId: string): SplitNode | null {
  if (node.type !== 'split') return null;
  if (node.children[0].id === childId || node.children[1].id === childId) return node;
  return findParentSplit(node.children[0], childId) ?? findParentSplit(node.children[1], childId);
}

export function reorderTabInLeaf(leafId: string, tabId: string, insertBeforeTabId: string | null) {
  const tree = cloneTree(getLatestTree());
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;
  const idx = leaf.tabs.indexOf(tabId);
  if (idx < 0) return;
  leaf.tabs.splice(idx, 1);
  if (insertBeforeTabId) {
    const targetIdx = leaf.tabs.indexOf(insertBeforeTabId);
    if (targetIdx >= 0) {
      leaf.tabs.splice(targetIdx, 0, tabId);
    } else {
      leaf.tabs.push(tabId);
    }
  } else {
    leaf.tabs.push(tabId);
  }
  commitTree(tree);
}

export function resetLayout() {
  layoutTree.value = buildDefaultLayout();
  focusedLeafId.value = PAGE_LEAF_ID;
  persist();
}
