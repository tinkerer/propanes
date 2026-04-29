import { signal, effect } from '@preact/signals';
import {
  type LayoutTree,
  type PaneNode,
  type SplitNode,
  type LeafNode,
  type SplitDirection,
  type PanePosition,
  positionToSplit,
} from './pane-tree.js';

// Well-known tab ids for leaves in the CoS popout tree.
export const COS_POPOUT_CHAT_TAB = 'cos-chat:main';
export const COS_POPOUT_LEARNINGS_TAB = 'cos-learnings:main';
export const COS_POPOUT_THREAD_TAB = 'thread:active';
export const COS_POPOUT_ROOT_LEAF = 'cos-root-leaf';

export const ARTIFACT_TAB_PREFIX = 'artifact:';
export function isArtifactTab(tabId: string): boolean {
  return tabId.startsWith(ARTIFACT_TAB_PREFIX);
}
export function artifactIdFromTab(tabId: string): string {
  return tabId.slice(ARTIFACT_TAB_PREFIX.length);
}
export function artifactTabId(artifactId: string): string {
  return `${ARTIFACT_TAB_PREFIX}${artifactId}`;
}

const STORAGE_KEY = 'pw-cos-popout-tree';
const SLACK_MODE_STORAGE_KEY = 'pw-cos-slack-mode';
const SHOW_RESOLVED_STORAGE_KEY = 'pw-cos-show-resolved';
const SHOW_ARCHIVED_STORAGE_KEY = 'pw-cos-show-archived';
const THREAD_FILTER_STORAGE_KEY = 'pw-cos-thread-filter';
const ACTIVE_THREAD_STORAGE_KEY = 'pw-cos-active-thread';
const THREAD_DRAWER_WIDTH_KEY = 'pw-cos-thread-drawer-width';

const THREAD_DRAWER_WIDTH_MIN = 220;
const THREAD_DRAWER_WIDTH_MAX = 1200;
const THREAD_DRAWER_WIDTH_DEFAULT = 380;

function loadThreadDrawerWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return THREAD_DRAWER_WIDTH_DEFAULT;
    const v = parseInt(localStorage.getItem(THREAD_DRAWER_WIDTH_KEY) || '', 10);
    if (!Number.isFinite(v) || v < THREAD_DRAWER_WIDTH_MIN) return THREAD_DRAWER_WIDTH_DEFAULT;
    return Math.min(THREAD_DRAWER_WIDTH_MAX, v);
  } catch { return THREAD_DRAWER_WIDTH_DEFAULT; }
}

export const cosThreadDrawerWidth = signal<number>(loadThreadDrawerWidth());

export function setCosThreadDrawerWidth(n: number) {
  const clamped = Math.max(THREAD_DRAWER_WIDTH_MIN, Math.min(THREAD_DRAWER_WIDTH_MAX, Math.round(n)));
  if (cosThreadDrawerWidth.value === clamped) return;
  cosThreadDrawerWidth.value = clamped;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THREAD_DRAWER_WIDTH_KEY, String(clamped));
    }
  } catch { /* ignore */ }
}

// Legacy drawer LocalStorage keys — read once at boot to migrate any tabs the
// user had open under the old floating-drawer architecture back into the tree,
// then deleted so we don't double-migrate on the next reload.
const LEGACY_ARTIFACT_DRAWER_KEY = 'pw-cos-artifact-drawer';
const LEGACY_THREAD_DRAWER_KEY = 'pw-cos-thread-drawer';

// Tab ids that previously existed in a persisted tree but are no longer
// resolved by CosPopoutTreeView. Without this list, the resolve() fallback
// renders them as a tab labeled with the raw id (e.g. "cos-thread:main").
const LEGACY_TAB_IDS = new Set<string>([
  'cos-thread:main', // renamed to 'thread:active'
]);

function buildDefault(): LayoutTree {
  return {
    root: {
      type: 'leaf',
      id: COS_POPOUT_ROOT_LEAF,
      panelType: 'tabs',
      tabs: [COS_POPOUT_CHAT_TAB],
      activeTabId: COS_POPOUT_CHAT_TAB,
    },
    focusedLeafId: COS_POPOUT_ROOT_LEAF,
  };
}

function loadTree(): LayoutTree {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    let tree: LayoutTree;
    if (!raw) {
      tree = buildDefault();
    } else {
      const parsed = JSON.parse(raw) as LayoutTree;
      if (!parsed?.root) tree = buildDefault();
      else if (!findLeafWithTabLocal(parsed.root, COS_POPOUT_CHAT_TAB)) tree = buildDefault();
      else tree = parsed;
    }
    // One-shot reverse migration: lift any artifact / thread tabs that were
    // stored in the legacy drawer LS back into the tree, then drop the LS keys.
    migrateDrawerStateToTree(tree);
    stripLegacyTabs(tree);
    return tree;
  } catch {
    return buildDefault();
  }
}

function migrateDrawerStateToTree(tree: LayoutTree) {
  if (typeof localStorage === 'undefined') return;
  let mutated = false;

  // Artifact drawer → artifact:* tabs in the chat leaf.
  try {
    const raw = localStorage.getItem(LEGACY_ARTIFACT_DRAWER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: string[] };
      const ids = Array.isArray(parsed?.tabs) ? parsed.tabs.filter((t) => typeof t === 'string') : [];
      if (ids.length > 0) {
        const chatLeaf = findLeafWithTabLocal(tree.root, COS_POPOUT_CHAT_TAB);
        if (chatLeaf) {
          for (const id of ids) {
            const tabId = artifactTabId(id);
            if (!chatLeaf.tabs.includes(tabId)) {
              chatLeaf.tabs.push(tabId);
              mutated = true;
            }
          }
        }
      }
      localStorage.removeItem(LEGACY_ARTIFACT_DRAWER_KEY);
    }
  } catch { /* ignore */ }

  // Thread drawer → thread:active tab in the chat leaf, but only if the user
  // had previously opened a thread (active-thread LS is set).
  try {
    const drawerRaw = localStorage.getItem(LEGACY_THREAD_DRAWER_KEY);
    if (drawerRaw) {
      const activeRaw = localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY);
      if (activeRaw) {
        const chatLeaf = findLeafWithTabLocal(tree.root, COS_POPOUT_CHAT_TAB);
        if (chatLeaf && !chatLeaf.tabs.includes(COS_POPOUT_THREAD_TAB)) {
          chatLeaf.tabs.push(COS_POPOUT_THREAD_TAB);
          mutated = true;
        }
      }
      localStorage.removeItem(LEGACY_THREAD_DRAWER_KEY);
    }
  } catch { /* ignore */ }

  if (mutated) {
    // No commit() here — caller is loadTree() and the signal isn't constructed
    // yet. The mutated tree gets handed back to the signal initializer.
  }
}

function stripLegacyTabs(tree: LayoutTree) {
  for (const leaf of getAllLeavesLocal(tree.root)) {
    const next = leaf.tabs.filter((t) => !LEGACY_TAB_IDS.has(t));
    if (next.length === leaf.tabs.length) continue;
    leaf.tabs = next;
    if (leaf.activeTabId && !next.includes(leaf.activeTabId)) {
      leaf.activeTabId = next[0] ?? null;
    }
  }
  cleanupEmptyLeaves(tree);
}

function persist() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cosPopoutTree.value));
    }
  } catch { /* ignore */ }
}

export const cosPopoutTree = signal<LayoutTree>(loadTree());

// --- Tree traversal ---

function findLeafLocal(node: PaneNode, id: string): LeafNode | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeafLocal(node.children[0], id) ?? findLeafLocal(node.children[1], id);
}

function findParentLocal(root: PaneNode, childId: string): SplitNode | null {
  if (root.type !== 'split') return null;
  if (root.children[0].id === childId || root.children[1].id === childId) return root;
  return findParentLocal(root.children[0], childId) ?? findParentLocal(root.children[1], childId);
}

function findLeafWithTabLocal(node: PaneNode, tabId: string): LeafNode | null {
  if (node.type === 'leaf') return node.tabs.includes(tabId) ? node : null;
  return findLeafWithTabLocal(node.children[0], tabId) ?? findLeafWithTabLocal(node.children[1], tabId);
}

function getAllLeavesLocal(node: PaneNode): LeafNode[] {
  if (node.type === 'leaf') return [node];
  return [...getAllLeavesLocal(node.children[0]), ...getAllLeavesLocal(node.children[1])];
}

function findNodeByIdLocal(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  if (node.type === 'split') {
    return findNodeByIdLocal(node.children[0], id) ?? findNodeByIdLocal(node.children[1], id);
  }
  return null;
}

export function cosFindLeafWithTab(tabId: string): LeafNode | null {
  return findLeafWithTabLocal(cosPopoutTree.value.root, tabId);
}

export function cosGetAllLeaves(): LeafNode[] {
  return getAllLeavesLocal(cosPopoutTree.value.root);
}

// --- ID generation ---

let _counter = 0;
function genId(prefix: string): string {
  return `${prefix}-${++_counter}-${Date.now().toString(36)}`;
}

function clone(tree: LayoutTree): LayoutTree {
  return structuredClone(tree);
}

function commit(tree: LayoutTree) {
  cosPopoutTree.value = tree;
  persist();
}

// --- Mutations ---

/**
 * Add a tab to an existing leaf. If the tab already lives in a different leaf
 * in this tree, it is moved (a tab is unique per tree).
 */
export function cosAddTabToLeaf(leafId: string, tabId: string, activate = true) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf) return;

  for (const other of getAllLeavesLocal(tree.root)) {
    if (other.id === leafId) continue;
    if (other.tabs.includes(tabId)) {
      other.tabs = other.tabs.filter((t) => t !== tabId);
      if (other.activeTabId === tabId) {
        other.activeTabId = other.tabs[0] ?? null;
      }
    }
  }

  if (!leaf.tabs.includes(tabId)) leaf.tabs.push(tabId);
  if (activate) leaf.activeTabId = tabId;

  cleanupEmptyLeaves(tree);
  commit(tree);
}

export function cosSplitLeafAtPosition(
  leafId: string,
  position: PanePosition,
  newTabs: string[],
  ratio = 0.5,
): string | null {
  const { direction, newPosition } = positionToSplit(position);
  return cosSplitLeaf(leafId, direction, newPosition, newTabs, ratio);
}

export function cosSplitLeaf(
  leafId: string,
  direction: SplitDirection,
  newPosition: 'first' | 'second',
  newTabs: string[],
  ratio = 0.5,
  moveActiveTab = false,
): string | null {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  const parent = findParentLocal(tree.root, leafId);
  if (!leaf) return null;

  const tabsForNew = [...newTabs];
  if (moveActiveTab && tabsForNew.length === 0 && leaf.activeTabId && leaf.tabs.length > 1) {
    const movingTab = leaf.activeTabId;
    tabsForNew.push(movingTab);
    leaf.tabs = leaf.tabs.filter((t) => t !== movingTab);
    leaf.activeTabId = leaf.tabs[0] ?? null;
  }

  for (const tab of tabsForNew) {
    for (const other of getAllLeavesLocal(tree.root)) {
      if (other.id === leafId) continue;
      if (other.tabs.includes(tab)) {
        other.tabs = other.tabs.filter((t) => t !== tab);
        if (other.activeTabId === tab) {
          other.activeTabId = other.tabs[0] ?? null;
        }
      }
    }
  }
  // Cleanup BEFORE the split is placed: any leaf emptied by the tab moves
  // above is folded into its sibling. Doing this after adding the new (often
  // empty) leaf would collapse it back out — defeating the user's split.
  cleanupEmptyLeaves(tree);

  // Re-resolve leaf/parent: cleanupEmptyLeaves may have promoted a sibling,
  // changing the parent reference, but `leaf` itself is preserved.
  const leafAfter = findLeafLocal(tree.root, leafId);
  const parentAfter = findParentLocal(tree.root, leafId);
  if (!leafAfter) return null;

  const newLeaf: LeafNode = {
    type: 'leaf',
    id: genId('cos-leaf'),
    panelType: 'tabs',
    tabs: [...tabsForNew],
    activeTabId: tabsForNew[0] ?? null,
  };

  const split: SplitNode = {
    type: 'split',
    id: genId('cos-split'),
    direction,
    ratio,
    children: newPosition === 'second'
      ? [structuredClone(leafAfter), newLeaf]
      : [newLeaf, structuredClone(leafAfter)],
  };

  if (!parentAfter) {
    tree.root = split;
  } else {
    if (parentAfter.children[0].id === leafId) parentAfter.children[0] = split;
    else parentAfter.children[1] = split;
  }

  tree.focusedLeafId = newLeaf.id;
  commit(tree);
  return newLeaf.id;
}

export function cosRemoveTabFromLeaf(leafId: string, tabId: string) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf) return;
  leaf.tabs = leaf.tabs.filter((t) => t !== tabId);
  if (leaf.activeTabId === tabId) {
    leaf.activeTabId = leaf.tabs[0] ?? null;
  }
  cleanupEmptyLeaves(tree);
  commit(tree);
}

export function cosRemoveTab(tabId: string) {
  const leaf = cosFindLeafWithTab(tabId);
  if (!leaf) return;
  cosRemoveTabFromLeaf(leaf.id, tabId);
}

export function cosSetActiveTab(leafId: string, tabId: string) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf || !leaf.tabs.includes(tabId)) return;
  leaf.activeTabId = tabId;
  commit(tree);
}

export function cosSetSplitRatio(splitId: string, ratio: number) {
  const tree = clone(cosPopoutTree.value);
  const node = findNodeByIdLocal(tree.root, splitId);
  if (!node || node.type !== 'split') return;
  node.ratio = Math.max(0.1, Math.min(0.9, ratio));
  commit(tree);
}

export function cosSetFocusedLeaf(leafId: string | null) {
  const tree = clone(cosPopoutTree.value);
  tree.focusedLeafId = leafId;
  commit(tree);
}

export function cosMoveTab(fromLeafId: string, toLeafId: string, tabId: string, activate = true) {
  if (fromLeafId === toLeafId) return;
  const tree = clone(cosPopoutTree.value);
  const from = findLeafLocal(tree.root, fromLeafId);
  const to = findLeafLocal(tree.root, toLeafId);
  if (!from || !to) return;

  from.tabs = from.tabs.filter((t) => t !== tabId);
  if (from.activeTabId === tabId) {
    from.activeTabId = from.tabs[0] ?? null;
  }
  if (!to.tabs.includes(tabId)) to.tabs.push(tabId);
  if (activate) to.activeTabId = tabId;

  cleanupEmptyLeaves(tree);
  commit(tree);
}

export function cosReorderTabInLeaf(leafId: string, tabId: string, insertBeforeTabId: string | null) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf) return;
  const idx = leaf.tabs.indexOf(tabId);
  if (idx < 0) return;
  leaf.tabs.splice(idx, 1);
  if (insertBeforeTabId) {
    const targetIdx = leaf.tabs.indexOf(insertBeforeTabId);
    if (targetIdx >= 0) leaf.tabs.splice(targetIdx, 0, tabId);
    else leaf.tabs.push(tabId);
  } else {
    leaf.tabs.push(tabId);
  }
  commit(tree);
}

/**
 * Merge a leaf into its sibling — promotes the sibling in place. If the leaf
 * still holds tabs, those tabs migrate to the first leaf in the sibling.
 * No-op if the leaf is the root (no sibling exists).
 */
export function cosMergeLeaf(leafId: string) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  const parent = findParentLocal(tree.root, leafId);
  if (!parent || !leaf) return;

  const sibling = parent.children[0].id === leafId ? parent.children[1] : parent.children[0];

  if (leaf.tabs.length > 0) {
    const targetLeaves = getAllLeavesLocal(sibling);
    const target = targetLeaves[0];
    if (target) {
      for (const t of leaf.tabs) {
        if (!target.tabs.includes(t)) target.tabs.push(t);
      }
      if (!target.activeTabId && leaf.activeTabId) target.activeTabId = leaf.activeTabId;
    }
  }

  const grandparent = findParentLocal(tree.root, parent.id);
  const sibClone = structuredClone(sibling);
  if (!grandparent) {
    tree.root = sibClone;
  } else {
    if (grandparent.children[0].id === parent.id) grandparent.children[0] = sibClone;
    else grandparent.children[1] = sibClone;
  }

  if (tree.focusedLeafId === leafId) {
    const firstLeaf = getAllLeavesLocal(tree.root)[0];
    tree.focusedLeafId = firstLeaf?.id ?? null;
  }

  cleanupEmptyLeaves(tree);
  commit(tree);
}

/**
 * Walk the tree and collapse any split that has an empty leaf child. The chat
 * tab must always remain present somewhere; we never auto-collapse a leaf that
 * still holds it.
 */
function cleanupEmptyLeaves(tree: LayoutTree) {
  let changed = true;
  while (changed) {
    changed = false;
    const leaves = getAllLeavesLocal(tree.root);
    if (leaves.length <= 1) return;
    for (const leaf of leaves) {
      if (leaf.tabs.length > 0) continue;
      const parent = findParentLocal(tree.root, leaf.id);
      if (!parent) continue;
      const sibling = structuredClone(
        parent.children[0].id === leaf.id ? parent.children[1] : parent.children[0]
      );
      const grandparent = findParentLocal(tree.root, parent.id);
      if (!grandparent) {
        tree.root = sibling;
      } else {
        if (grandparent.children[0].id === parent.id) grandparent.children[0] = sibling;
        else grandparent.children[1] = sibling;
      }
      if (tree.focusedLeafId === leaf.id) {
        const firstLeaf = getAllLeavesLocal(sibling)[0];
        tree.focusedLeafId = firstLeaf?.id ?? null;
      }
      changed = true;
      break;
    }
  }
}

/**
 * Pick the leaf that should host new companion tabs (artifacts, threads,
 * learnings). Prefers the chat-tab leaf so companions sit next to chat.
 */
function pickAnchorLeafId(): string {
  const tree = cosPopoutTree.value;
  const chatLeaf = findLeafWithTabLocal(tree.root, COS_POPOUT_CHAT_TAB);
  if (chatLeaf) return chatLeaf.id;
  if (tree.focusedLeafId) {
    const focused = findLeafLocal(tree.root, tree.focusedLeafId);
    if (focused) return focused.id;
  }
  const anyLeaf = getAllLeavesLocal(tree.root)[0];
  return anyLeaf?.id ?? COS_POPOUT_ROOT_LEAF;
}

/**
 * Open an artifact as its own drawer pane next to the thread. If a floating
 * drawer is already open, the artifact gets a fresh floating leaf split off
 * to the inner side of the existing drawer's leaf — they sit side-by-side
 * inside the drawer overlay area, the thread on the outer edge and the
 * artifact closer to the chat. With no drawer open yet, falls back to a
 * fresh single-pane floating drawer at the right edge.
 */
export function cosOpenArtifactTab(artifactId: string) {
  const tabId = artifactTabId(artifactId);
  const existing = cosFindLeafWithTab(tabId);
  if (existing) {
    if (existing.activeTabId !== tabId) cosSetActiveTab(existing.id, tabId);
    return;
  }
  cosDockAsFloatingCompanion(tabId, 'R');
}

/**
 * Locate a leaf together with its parent split, so callers can replace the
 * leaf with a new subtree in-place.
 */
function findLeafAndParent(
  node: PaneNode,
  leafId: string,
  parent: SplitNode | null,
  idxInParent: 0 | 1,
): { leaf: LeafNode; parent: SplitNode | null; idx: 0 | 1 } | null {
  if (node.type === 'leaf') {
    return node.id === leafId ? { leaf: node, parent, idx: idxInParent } : null;
  }
  return (
    findLeafAndParent(node.children[0], leafId, node, 0) ??
    findLeafAndParent(node.children[1], leafId, node, 1)
  );
}

/**
 * If at least one floating leaf already exists, split the innermost one
 * (closest to the chat) so the new tab gets its own floating sibling pane
 * next to it. Returns true when a split happened, false when there's no
 * existing floating leaf to split (caller should fall back to a fresh
 * dock).
 */
function addFloatingCompanionPane(tabId: string): boolean {
  const tree = clone(cosPopoutTree.value);
  // Detach the tab from wherever it lives now. addFloatingCompanionPane is
  // also used by drag-to-edge, where the tab originated in a non-floating
  // leaf — leaving it there would result in two copies.
  for (const leaf of getAllLeavesLocal(tree.root)) {
    if (leaf.tabs.includes(tabId)) {
      leaf.tabs = leaf.tabs.filter((t) => t !== tabId);
      if (leaf.activeTabId === tabId) leaf.activeTabId = leaf.tabs[0] ?? null;
    }
  }
  const floating = getAllLeavesLocal(tree.root).filter((l) => l.floating);
  if (floating.length === 0) {
    // No drawer to companion against — caller should fall back to the
    // fresh-dock path. Restore the tree (we stripped the tab; let
    // cosDockTabToEdge handle detach again).
    return false;
  }
  // Pick the floating leaf farthest from the right edge — i.e. the one that
  // currently sits closest to the chat. The new pane goes inside of it,
  // pushing the existing drawer content further out toward the edge.
  const target = floating[0];
  const found = findLeafAndParent(tree.root, target.id, null, 0);
  if (!found) return false;
  const newLeaf: LeafNode = {
    type: 'leaf',
    id: genId('cos-leaf'),
    panelType: 'tabs',
    tabs: [tabId],
    activeTabId: tabId,
    floating: true,
  };
  // Split horizontally: new pane on the left (chat side), existing leaf
  // on the right. Within the right-edge drawer area this puts artifacts
  // between the chat and the thread.
  const newSplit: SplitNode = {
    type: 'split',
    id: genId('cos-split'),
    direction: 'horizontal',
    ratio: 0.5,
    children: [newLeaf, found.leaf],
  };
  if (found.parent === null) {
    tree.root = newSplit;
  } else {
    found.parent.children[found.idx] = newSplit;
  }
  cleanupEmptyLeaves(tree);
  tree.focusedLeafId = newLeaf.id;
  commit(tree);
  return true;
}

/**
 * Public wrapper: dock a tab as a floating companion pane. Adds it next to
 * any existing floating drawer (split into siblings) when one is open;
 * otherwise creates a fresh single-pane floating drawer at `edge`. Used by
 * `cosOpenArtifactTab` and the tab-drag drop handlers so both flows share
 * the same companion-pane behavior.
 */
export function cosDockAsFloatingCompanion(tabId: string, edge: 'L' | 'R' | 'T' | 'B' = 'R') {
  if (addFloatingCompanionPane(tabId)) return;
  cosDockTabToEdge(tabId, edge, true, { floating: true });
}

/**
 * Close every floating leaf in the tree — used by the drawer's edge handle
 * so a single click collapses the whole companion-drawer area regardless of
 * how many panes (thread + N artifacts) live inside it.
 */
export function cosCloseFloatingDrawers() {
  const tree = clone(cosPopoutTree.value);
  let mutated = false;
  for (const leaf of getAllLeavesLocal(tree.root)) {
    if (leaf.floating && leaf.tabs.length > 0) {
      leaf.tabs = [];
      leaf.activeTabId = null;
      mutated = true;
    }
  }
  if (!mutated) return;
  cleanupEmptyLeaves(tree);
  commit(tree);
}

/**
 * Close all artifact:* tabs, leaving the rest of the tree intact.
 */
export function cosCloseAllArtifactTabs() {
  const tree = clone(cosPopoutTree.value);
  let mutated = false;
  for (const leaf of getAllLeavesLocal(tree.root)) {
    const next = leaf.tabs.filter((t) => !isArtifactTab(t));
    if (next.length !== leaf.tabs.length) {
      leaf.tabs = next;
      if (leaf.activeTabId && !next.includes(leaf.activeTabId)) {
        leaf.activeTabId = next[0] ?? null;
      }
      mutated = true;
    }
  }
  if (!mutated) return;
  cleanupEmptyLeaves(tree);
  commit(tree);
}

/**
 * Toggle the learnings tab. Adding it splits the anchor leaf to the left
 * (matching the prior fixed-position drawer default). Removing it detaches
 * the leaf from the tree.
 */
export function cosToggleLearningsTab(position: PanePosition = 'left') {
  const existingLeaf = cosFindLeafWithTab(COS_POPOUT_LEARNINGS_TAB);
  if (existingLeaf) {
    cosRemoveTabFromLeaf(existingLeaf.id, COS_POPOUT_LEARNINGS_TAB);
    return false;
  }
  const anchorLeafId = pickAnchorLeafId();
  cosSplitLeafAtPosition(anchorLeafId, position, [COS_POPOUT_LEARNINGS_TAB], 0.32);
  return true;
}

export function cosIsLearningsOpen(): boolean {
  return !!cosFindLeafWithTab(COS_POPOUT_LEARNINGS_TAB);
}

/**
 * Slack-mode toggle: when on, ThreadBlock collapses replies inline and renders
 * the active thread in a side companion panel (a popout tab in popout mode, a
 * side drawer in pane mode). Persisted across sessions.
 */
function loadSlackMode(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const v = localStorage.getItem(SLACK_MODE_STORAGE_KEY);
    return v !== '0';
  } catch { return true; }
}

export const cosSlackMode = signal<boolean>(loadSlackMode());

export function setCosSlackMode(next: boolean) {
  cosSlackMode.value = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SLACK_MODE_STORAGE_KEY, next ? '1' : '0');
    }
  } catch { /* ignore */ }
  if (!next) {
    cosActiveThread.value = null;
    cosCloseThreadTab();
  }
}

function loadFlag(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(key) === '1';
  } catch { return false; }
}

export const cosShowResolved = signal<boolean>(loadFlag(SHOW_RESOLVED_STORAGE_KEY));
export const cosShowArchived = signal<boolean>(loadFlag(SHOW_ARCHIVED_STORAGE_KEY));

export function setCosShowResolved(next: boolean) {
  cosShowResolved.value = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHOW_RESOLVED_STORAGE_KEY, next ? '1' : '0');
    }
  } catch { /* ignore */ }
}

export function setCosShowArchived(next: boolean) {
  cosShowArchived.value = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, next ? '1' : '0');
    }
  } catch { /* ignore */ }
}

export type CosThreadFilter = 'default' | 'drafts' | 'archived';

function loadThreadFilter(): CosThreadFilter {
  try {
    if (typeof localStorage === 'undefined') return 'default';
    const v = localStorage.getItem(THREAD_FILTER_STORAGE_KEY);
    if (v === 'drafts' || v === 'archived') return v;
    return 'default';
  } catch { return 'default'; }
}

export const cosThreadFilter = signal<CosThreadFilter>(loadThreadFilter());

export function setCosThreadFilter(next: CosThreadFilter) {
  cosThreadFilter.value = next;
  try {
    if (typeof localStorage !== 'undefined') {
      if (next === 'default') localStorage.removeItem(THREAD_FILTER_STORAGE_KEY);
      else localStorage.setItem(THREAD_FILTER_STORAGE_KEY, next);
    }
  } catch { /* ignore */ }
}

export type CosActiveThread = { agentId: string; threadKey: string };

function loadActiveThread(): CosActiveThread | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(ACTIVE_THREAD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.agentId !== 'string' || typeof parsed.threadKey !== 'string') {
      return null;
    }
    return { agentId: parsed.agentId, threadKey: parsed.threadKey };
  } catch { return null; }
}

export const cosActiveThread = signal<CosActiveThread | null>(loadActiveThread());

effect(() => {
  const v = cosActiveThread.value;
  try {
    if (typeof localStorage === 'undefined') return;
    if (v) localStorage.setItem(ACTIVE_THREAD_STORAGE_KEY, JSON.stringify(v));
    else localStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY);
  } catch { /* ignore */ }
});

// Close any open artifact panes when the active thread changes. Artifacts are
// scoped to a thread; carrying them across switches confuses the operator.
let prevActiveThreadKey: string | null | undefined = undefined;
effect(() => {
  const v = cosActiveThread.value;
  const key = v ? `${v.agentId}::${v.threadKey}` : null;
  if (prevActiveThreadKey !== undefined && prevActiveThreadKey !== key) {
    cosCloseAllArtifactTabs();
  }
  prevActiveThreadKey = key;
});

// --- Per-thread composer drafts ---

const THREAD_DRAFTS_STORAGE_KEY = 'pw-cos-thread-drafts';

function loadThreadDrafts(): Record<string, string> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(THREAD_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

const cosThreadDrafts = signal<Record<string, string>>(loadThreadDrafts());

effect(() => {
  const v = cosThreadDrafts.value;
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THREAD_DRAFTS_STORAGE_KEY, JSON.stringify(v));
  } catch { /* ignore */ }
});

function draftKey(agentId: string, threadKey: string): string {
  return `${agentId}::${threadKey}`;
}

export function getThreadDraft(agentId: string, threadKey: string): string {
  return cosThreadDrafts.value[draftKey(agentId, threadKey)] || '';
}

export function setThreadDraft(agentId: string, threadKey: string, text: string) {
  const k = draftKey(agentId, threadKey);
  const cur = cosThreadDrafts.value;
  if ((cur[k] || '') === text) return;
  const next = { ...cur };
  if (text) next[k] = text;
  else delete next[k];
  cosThreadDrafts.value = next;
}

export function clearThreadDraft(agentId: string, threadKey: string) {
  setThreadDraft(agentId, threadKey, '');
}

/**
 * Open the slack-mode thread companion as a floating right-edge drawer. If
 * the tab is already open anywhere, just activate it; otherwise dock it to
 * the popout's right edge as an overlay drawer that floats over the chat
 * instead of splitting the layout.
 */
export function cosOpenThreadTab(_position: PanePosition = 'right') {
  void _position;
  const existing = cosFindLeafWithTab(COS_POPOUT_THREAD_TAB);
  if (existing) {
    if (existing.activeTabId !== COS_POPOUT_THREAD_TAB) {
      cosSetActiveTab(existing.id, COS_POPOUT_THREAD_TAB);
    }
    return;
  }
  cosDockTabToEdge(COS_POPOUT_THREAD_TAB, 'R', true, { floating: true });
}

export function cosCloseThreadTab() {
  const existing = cosFindLeafWithTab(COS_POPOUT_THREAD_TAB);
  if (!existing) return;
  cosRemoveTabFromLeaf(existing.id, COS_POPOUT_THREAD_TAB);
}

export function cosIsThreadOpen(): boolean {
  return !!cosFindLeafWithTab(COS_POPOUT_THREAD_TAB);
}

export function cosResetPopoutTree() {
  commit(buildDefault());
}

const COMPANION_DRAWER_RATIO = 0.32;

/**
 * Dock a tab to a specific edge of the *popout itself* as a companion
 * drawer. Reuses an existing root-level companion split on the same edge if
 * one is already there; otherwise wraps the root in a fresh horizontal /
 * vertical split with the new pane sized to a narrower ratio than a regular
 * 50/50 split (`COMPANION_DRAWER_RATIO`).
 *
 * Edge → (split direction, child position):
 *   'L' left  → horizontal, first
 *   'R' right → horizontal, second
 *   'T' top   → vertical,   first
 *   'B' bottom→ vertical,   second
 */
export function cosDockTabToEdge(
  tabId: string,
  edge: 'L' | 'R' | 'T' | 'B',
  activate = true,
  opts?: { floating?: boolean },
) {
  const tree = clone(cosPopoutTree.value);
  const floating = opts?.floating === true;

  // Detach the tab from any leaf currently holding it.
  for (const leaf of getAllLeavesLocal(tree.root)) {
    if (leaf.tabs.includes(tabId)) {
      leaf.tabs = leaf.tabs.filter((t) => t !== tabId);
      if (leaf.activeTabId === tabId) leaf.activeTabId = leaf.tabs[0] ?? null;
    }
  }

  const wantDir: SplitDirection = (edge === 'L' || edge === 'R') ? 'horizontal' : 'vertical';
  const wantPos: 'first' | 'second' = (edge === 'L' || edge === 'T') ? 'first' : 'second';

  // Try to reuse an existing root-level companion split on the same edge —
  // when the user docks multiple tabs to the same edge they should land in
  // the same companion pane. Only reuse when the floating-ness matches; we
  // don't want a floating dock to merge into an existing non-floating split.
  if (tree.root.type === 'split' && tree.root.direction === wantDir) {
    const idx = wantPos === 'first' ? 0 : 1;
    const sideChild = tree.root.children[idx];
    if (sideChild.type === 'leaf' && !!sideChild.floating === floating) {
      if (!sideChild.tabs.includes(tabId)) sideChild.tabs.push(tabId);
      if (activate) sideChild.activeTabId = tabId;
      cleanupEmptyLeaves(tree);
      commit(tree);
      return;
    }
  }

  // Otherwise, wrap the root in a new split with a fresh companion leaf on
  // the chosen edge.
  const newLeaf: LeafNode = {
    type: 'leaf',
    id: genId('cos-leaf'),
    panelType: 'tabs',
    tabs: [tabId],
    activeTabId: tabId,
    ...(floating ? { floating: true } : {}),
  };
  cleanupEmptyLeaves(tree);
  const oldRoot = structuredClone(tree.root);
  const ratio = wantPos === 'first' ? COMPANION_DRAWER_RATIO : 1 - COMPANION_DRAWER_RATIO;
  const split: SplitNode = {
    type: 'split',
    id: genId('cos-split'),
    direction: wantDir,
    ratio,
    children: wantPos === 'second' ? [oldRoot, newLeaf] : [newLeaf, oldRoot],
  };
  tree.root = split;
  tree.focusedLeafId = newLeaf.id;
  commit(tree);
}

// --- Collapsed-leaf / companion-drawer state ---
//
// `collapsed` is already on `LeafNode` (shared with the main pane tree).
// When set, the leaf renders as a slim grab handle on the parent split's
// adjacent edge — clicking expands it back. `collapseLeafToEdge` rotates the
// parent split's direction + child order so the handle appears on the
// requested edge regardless of where the leaf currently sits.

export function cosToggleLeafCollapsed(leafId: string) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsed = !leaf.collapsed;
  if (!leaf.collapsed) leaf.collapsedOffset = 0;
  commit(tree);
}

export function cosSetLeafCollapsed(leafId: string, collapsed: boolean) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf || leaf.collapsed === collapsed) return;
  leaf.collapsed = collapsed;
  if (!collapsed) leaf.collapsedOffset = 0;
  commit(tree);
}

export function cosSetLeafCollapsedOffset(leafId: string, offset: number) {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsedOffset = offset;
  commit(tree);
}

/**
 * Collapse a leaf to a specific edge of its parent split. If the parent's
 * direction doesn't already align with the chosen edge, the parent is rotated
 * (direction swap + child re-order + ratio flip) so the handle ends up on the
 * desired side without moving the leaf elsewhere in the tree.
 *
 * Edge → (parent direction, child position):
 *   'W' left  → horizontal, first
 *   'E' right → horizontal, second
 *   'N' top   → vertical,   first
 *   'S' bottom→ vertical,   second
 */
export function cosCollapseLeafToEdge(leafId: string, edge: 'N' | 'S' | 'E' | 'W') {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  const parent = findParentLocal(tree.root, leafId);
  if (!leaf) return;
  leaf.collapsed = true;
  leaf.collapsedOffset = 0;

  if (parent) {
    const wantDir: 'horizontal' | 'vertical' = (edge === 'E' || edge === 'W') ? 'horizontal' : 'vertical';
    const wantFirst = (edge === 'W' || edge === 'N');
    const currentIdx = parent.children[0].id === leafId ? 0 : 1;
    const currentFirst = currentIdx === 0;

    if (parent.direction !== wantDir) parent.direction = wantDir;
    if (currentFirst !== wantFirst) {
      const other = parent.children[currentIdx === 0 ? 1 : 0];
      parent.children = wantFirst
        ? [parent.children[currentIdx], other] as [PaneNode, PaneNode]
        : [other, parent.children[currentIdx]] as [PaneNode, PaneNode];
      parent.ratio = 1 - parent.ratio;
    }
  }

  commit(tree);
}
