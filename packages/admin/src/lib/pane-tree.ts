import { signal, computed } from '@preact/signals';

// --- Types ---

export type SplitDirection = 'horizontal' | 'vertical';

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
export const CONTROLBAR_LEAF_ID = 'controlbar-leaf';

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
          id: 'main-split',
          direction: 'vertical',
          ratio: 0.04,
          children: [
            {
              type: 'leaf',
              id: CONTROLBAR_LEAF_ID,
              panelType: 'tabs',
              tabs: ['view:controlbar'],
              activeTabId: 'view:controlbar',
              singleton: true,
            },
            {
              type: 'split',
              id: 'content-split',
              direction: 'horizontal',
              ratio: 0.5,
              children: [
                {
                  type: 'split',
                  id: 'pages-left-split',
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
                {
                  type: 'leaf',
                  id: 'aggregate-leaf',
                  panelType: 'tabs',
                  tabs: ['view:aggregate'],
                  activeTabId: 'view:aggregate',
                  singleton: true,
                },
              ],
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
  const singletonLeafIds = [SIDEBAR_LEAF_ID, 'sidebar-sessions', 'sidebar-terminals', 'sidebar-files', CONTROLBAR_LEAF_ID, PAGE_LEAF_ID, 'aggregate-leaf'];
  for (const id of singletonLeafIds) {
    const leaf = find(tree.root, id);
    if (leaf && !leaf.singleton) leaf.singleton = true;
  }

  // Migrate controlbar-leaf: create if missing
  const controlbarLeaf = find(tree.root, CONTROLBAR_LEAF_ID);
  if (!controlbarLeaf) {
    function findSplit(node: PaneNode, id: string): SplitNode | null {
      if (node.type === 'split') {
        if (node.id === id) return node;
        return findSplit(node.children[0], id) ?? findSplit(node.children[1], id);
      }
      return null;
    }
    const mainSplit = findSplit(tree.root, 'main-split');
    if (mainSplit) {
      const prevRatio = mainSplit.ratio;
      const newControlbar: LeafNode = {
        type: 'leaf',
        id: CONTROLBAR_LEAF_ID,
        panelType: 'tabs',
        tabs: ['view:controlbar'],
        activeTabId: 'view:controlbar',
        singleton: true,
      };
      const contentSplit: SplitNode = {
        type: 'split',
        id: 'content-split',
        direction: 'vertical',
        ratio: prevRatio,
        children: [mainSplit.children[0], mainSplit.children[1]],
      };
      mainSplit.ratio = 0.04;
      mainSplit.children = [newControlbar, contentSplit];
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
  const root = node ?? layoutTree.value.root;
  if (root.type === 'leaf') return root.tabs.includes(tabId) ? root : null;
  return findLeafWithTab(tabId, root.children[0]) ?? findLeafWithTab(tabId, root.children[1]);
}

export function findParent(root: PaneNode, nodeId: string): SplitNode | null {
  if (root.type === 'leaf') return null;
  if (root.children[0].id === nodeId || root.children[1].id === nodeId) return root;
  return findParent(root.children[0], nodeId) ?? findParent(root.children[1], nodeId);
}

// Find a sibling leaf that contains companion tabs for a given session
export function findCompanionSibling(sessionLeafId: string, sessionId: string): LeafNode | null {
  const tree = layoutTree.value;
  const parent = findParent(tree.root, sessionLeafId);
  if (!parent) return null;
  const sibling = parent.children[0].id === sessionLeafId ? parent.children[1] : parent.children[0];
  if (sibling.type !== 'leaf') return null;
  // Check if sibling has any companion tabs for this session
  const companionPrefixes = ['jsonl:', 'feedback:', 'iframe:', 'terminal:', 'isolate:', 'url:'];
  const hasCompanionForSession = sibling.tabs.some(t => {
    for (const prefix of companionPrefixes) {
      if (t.startsWith(prefix) && t.slice(prefix.length) === sessionId) return true;
    }
    return false;
  });
  if (hasCompanionForSession || sibling.tabs.length === 0) return sibling;
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
      layoutTree.value = _batchTree;
      _batchTree = null;
      persist();
    }
  }
}

/** Commit a cloned tree — deferred during batch. */
function commitTree(tree: LayoutTree) {
  if (_batchDepth > 0) {
    _batchTree = tree;
  } else {
    layoutTree.value = tree;
    persist();
  }
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
  const tree = cloneTree(layoutTree.value);
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

export function mergeLeaf(leafId: string) {
  const tree = cloneTree(layoutTree.value);
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
  const tree = cloneTree(layoutTree.value);
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;

  if (!leaf.tabs.includes(tabId)) {
    leaf.tabs.push(tabId);
  }
  if (activate) {
    leaf.activeTabId = tabId;
  }

  commitTree(tree);
}

export function removeTabFromLeaf(leafId: string, tabId: string, autoMerge = true) {
  const tree = cloneTree(layoutTree.value);
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
  const tree = cloneTree(layoutTree.value);
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf || !leaf.tabs.includes(tabId)) return;
  leaf.activeTabId = tabId;
  commitTree(tree);
}

export function moveTab(fromLeafId: string, toLeafId: string, tabId: string) {
  if (fromLeafId === toLeafId) return;
  const tree = cloneTree(layoutTree.value);
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

export function setSplitRatio(splitId: string, ratio: number) {
  const clamped = Math.max(0.05, Math.min(0.95, ratio));
  const tree = cloneTree(layoutTree.value);
  const node = findNodeById(tree.root, splitId);
  if (!node || node.type !== 'split') return;

  const oldRatio = node.ratio;
  node.ratio = clamped;

  // When dragging a split's divider, both children resize. If a child is itself
  // a split in the same direction, all its sub-panels resize proportionally —
  // but the user expects only the sub-panel directly adjacent to the divider to
  // change. Fix by adjusting child split ratios to preserve non-adjacent panels.
  const [first, second] = node.children;

  if (first.type === 'split' && first.direction === node.direction) {
    // First child shrank/grew from oldRatio to clamped.
    // Its second sub-child (index 1) is adjacent to our divider.
    preserveNonAdjacentSizes(first, oldRatio, clamped, 1);
  }

  if (second.type === 'split' && second.direction === node.direction) {
    // Second child shrank/grew from (1-oldRatio) to (1-clamped).
    // Its first sub-child (index 0) is adjacent to our divider.
    preserveNonAdjacentSizes(second, 1 - oldRatio, 1 - clamped, 0);
  }

  commitTree(tree);
}

/**
 * When a same-direction child split's container resizes, adjust its ratio so
 * that the sub-panel NOT adjacent to the external divider keeps its absolute
 * size. Recurses for deeply nested same-direction splits.
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
    // Second child is adjacent — preserve first child's absolute size
    // firstAbs = ratio * proportion → newRatio = oldRatio * old / new
    newRatio = oldRatio * oldProportion / newProportion;
  } else {
    // First child is adjacent — preserve second child's absolute size
    // secondAbs = (1-ratio) * proportion → newRatio = 1 - (1-oldRatio) * old / new
    newRatio = 1 - (1 - oldRatio) * oldProportion / newProportion;
  }

  node.ratio = Math.max(0.05, Math.min(0.95, newRatio));

  // Recurse into the adjacent child if it's also a same-direction split
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
  const tree = cloneTree(layoutTree.value);
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsed = !leaf.collapsed;
  commitTree(tree);
}

// --- Utilities ---

function isWellKnownLeaf(id: string): boolean {
  return id === SIDEBAR_LEAF_ID || id === PAGE_LEAF_ID || id === SESSIONS_LEAF_ID || id === CONTROLBAR_LEAF_ID || id === 'aggregate-leaf';
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
  const tree = cloneTree(_batchDepth > 0 && _batchTree ? _batchTree : layoutTree.value);
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
  const current = _batchDepth > 0 && _batchTree ? _batchTree : layoutTree.value;
  const existing = findLeaf(current.root, SESSIONS_LEAF_ID);
  if (existing) return SESSIONS_LEAF_ID;

  // Sessions leaf doesn't exist — create one by splitting an appropriate leaf.
  // Strategy: find the focused leaf, or any non-sidebar/non-controlbar leaf in the main area.
  const tree = cloneTree(current);
  const allLeaves = getAllLeaves(tree.root);
  const sidebarIds = new Set([SIDEBAR_LEAF_ID, CONTROLBAR_LEAF_ID, 'sidebar-sessions', 'sidebar-terminals', 'sidebar-files']);
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
  const tree = cloneTree(_batchDepth > 0 && _batchTree ? _batchTree : layoutTree.value);
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
  const tree = cloneTree(layoutTree.value);
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
