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
          type: 'leaf',
          id: SIDEBAR_LEAF_ID,
          panelType: 'sidebar',
          tabs: [],
          activeTabId: null,
        },
        {
          type: 'split',
          id: 'main-split',
          direction: 'vertical',
          ratio: 1.0,
          children: [
            {
              type: 'leaf',
              id: PAGE_LEAF_ID,
              panelType: 'tabs',
              tabs: [],
              activeTabId: null,
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

// --- Signals ---

export const layoutTree = signal<LayoutTree>(loadTree() ?? buildDefaultLayout());
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

// Deep clone to ensure immutability
function cloneTree(tree: LayoutTree): LayoutTree {
  return JSON.parse(JSON.stringify(tree));
}

function cloneNode(node: PaneNode): PaneNode {
  return JSON.parse(JSON.stringify(node));
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
): LeafNode | null {
  const tree = cloneTree(layoutTree.value);
  const parent = findParent(tree.root, leafId);
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return null;

  const newLeaf: LeafNode = {
    type: 'leaf',
    id: genId('leaf'),
    panelType: 'tabs',
    tabs: newTabs,
    activeTabId: newTabs[0] ?? null,
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

  layoutTree.value = tree;
  persist();
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

  layoutTree.value = tree;
  persist();
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

  layoutTree.value = tree;
  persist();
}

export function removeTabFromLeaf(leafId: string, tabId: string, autoMerge = true) {
  const tree = cloneTree(layoutTree.value);
  const leaf = findLeaf(tree.root, leafId);
  if (!leaf) return;

  leaf.tabs = leaf.tabs.filter(t => t !== tabId);
  if (leaf.activeTabId === tabId) {
    leaf.activeTabId = leaf.tabs[0] ?? null;
  }

  layoutTree.value = tree;
  persist();

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
  layoutTree.value = tree;
  persist();
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

  layoutTree.value = tree;
  persist();

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
  node.ratio = clamped;
  layoutTree.value = tree;
  persist();
}

export function setFocusedLeaf(leafId: string | null) {
  focusedLeafId.value = leafId;
  persist();
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
  const tree = cloneTree(layoutTree.value);
  const mainSplit = findNodeById(tree.root, 'main-split');
  if (mainSplit && mainSplit.type === 'split' && mainSplit.ratio >= 0.95) {
    mainSplit.ratio = 0.6;
    layoutTree.value = tree;
    persist();
  }
}

export function hideSessionsLeaf() {
  const tree = cloneTree(layoutTree.value);
  const mainSplit = findNodeById(tree.root, 'main-split');
  if (mainSplit && mainSplit.type === 'split') {
    mainSplit.ratio = 1.0;
    layoutTree.value = tree;
    persist();
  }
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
  layoutTree.value = tree;
  persist();
}

export function resetLayout() {
  layoutTree.value = buildDefaultLayout();
  focusedLeafId.value = PAGE_LEAF_ID;
  persist();
}
