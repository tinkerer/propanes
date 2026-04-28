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
import { openArtifactDrawerTab, closeArtifactDrawer } from './cos-artifact-drawer.js';
import { setThreadDrawerVisible } from './cos-thread-drawer.js';

// Well-known tab ids for leaves in the CoS popout tree.
export const COS_POPOUT_CHAT_TAB = 'cos-chat:main';
export const COS_POPOUT_LEARNINGS_TAB = 'cos-learnings:main';
export const COS_POPOUT_ROOT_LEAF = 'cos-root-leaf';

// Legacy tab id — kept only for migrating older persisted trees off it.
const LEGACY_COS_POPOUT_THREAD_TAB = 'cos-thread:main';

const STORAGE_KEY = 'pw-cos-popout-tree';
const SLACK_MODE_STORAGE_KEY = 'pw-cos-slack-mode';
const SHOW_RESOLVED_STORAGE_KEY = 'pw-cos-show-resolved';
const SHOW_ARCHIVED_STORAGE_KEY = 'pw-cos-show-archived';
const THREAD_FILTER_STORAGE_KEY = 'pw-cos-thread-filter';
const ACTIVE_THREAD_STORAGE_KEY = 'pw-cos-active-thread';

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
    if (!raw) return buildDefault();
    const parsed = JSON.parse(raw) as LayoutTree;
    if (!parsed?.root) return buildDefault();
    // Ensure the chat tab is always present in at least one leaf; if not, fall
    // back to the default layout so the user never gets stuck without chat.
    if (!findLeafWithTabLocal(parsed.root, COS_POPOUT_CHAT_TAB)) return buildDefault();
    // Artifacts now render as a drawer overlay (not a tree split). Migrate any
    // legacy `artifact:*` tabs out of the tree and reopen them in the drawer.
    migrateArtifactTabsToDrawer(parsed);
    // Thread is also a drawer overlay now — strip stale tree tabs.
    migrateLegacyThreadTab(parsed);
    return parsed;
  } catch {
    return buildDefault();
  }
}

function migrateArtifactTabsToDrawer(tree: LayoutTree) {
  const migrated: string[] = [];
  for (const leaf of getAllLeavesLocal(tree.root)) {
    const keep: string[] = [];
    for (const tab of leaf.tabs) {
      if (tab.startsWith('artifact:')) {
        migrated.push(tab.slice('artifact:'.length));
      } else {
        keep.push(tab);
      }
    }
    if (keep.length !== leaf.tabs.length) {
      leaf.tabs = keep;
      if (leaf.activeTabId && !keep.includes(leaf.activeTabId)) {
        leaf.activeTabId = keep[0] ?? null;
      }
    }
  }
  if (migrated.length === 0) return;
  cleanupEmptyLeaves(tree);
  // Defer drawer mutation to after the tree signal is constructed.
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => migrated.forEach(openArtifactDrawerTab));
  } else {
    setTimeout(() => migrated.forEach(openArtifactDrawerTab), 0);
  }
}

function migrateLegacyThreadTab(tree: LayoutTree) {
  let stripped = false;
  for (const leaf of getAllLeavesLocal(tree.root)) {
    if (!leaf.tabs.includes(LEGACY_COS_POPOUT_THREAD_TAB)) continue;
    leaf.tabs = leaf.tabs.filter((t) => t !== LEGACY_COS_POPOUT_THREAD_TAB);
    if (leaf.activeTabId === LEGACY_COS_POPOUT_THREAD_TAB) {
      leaf.activeTabId = leaf.tabs[0] ?? null;
    }
    stripped = true;
  }
  if (stripped) cleanupEmptyLeaves(tree);
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

  // Remove from any other leaf that holds this tab.
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

  // Drop any leaves that became empty as a result of the move (except the
  // root-leaf fallback — that one is allowed to be empty if chat moved away,
  // though we try to avoid that case).
  cleanupEmptyLeaves(tree);

  commit(tree);
}

/**
 * Replace a leaf with a new split. `newTabs` becomes the new sibling leaf.
 * `position` determines whether the new leaf appears before or after the
 * original, and along which axis.
 */
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
): string | null {
  const tree = clone(cosPopoutTree.value);
  const leaf = findLeafLocal(tree.root, leafId);
  const parent = findParentLocal(tree.root, leafId);
  if (!leaf) return null;

  // If any of the requested tabs already exist in another leaf, remove them
  // from that leaf first — tabs are unique per tree.
  for (const tab of newTabs) {
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

  const newLeaf: LeafNode = {
    type: 'leaf',
    id: genId('cos-leaf'),
    panelType: 'tabs',
    tabs: [...newTabs],
    activeTabId: newTabs[0] ?? null,
  };

  const split: SplitNode = {
    type: 'split',
    id: genId('cos-split'),
    direction,
    ratio,
    children: newPosition === 'second'
      ? [structuredClone(leaf), newLeaf]
      : [newLeaf, structuredClone(leaf)],
  };

  if (!parent) {
    tree.root = split;
  } else {
    if (parent.children[0].id === leafId) parent.children[0] = split;
    else parent.children[1] = split;
  }

  tree.focusedLeafId = newLeaf.id;
  cleanupEmptyLeaves(tree);
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

/**
 * Walk the tree and collapse any split that has an empty leaf child (the
 * sibling is promoted in its place). The root leaf is preserved even when
 * empty — we always want at least one leaf to render. The chat tab is the
 * only tab that isn't allowed to be orphaned; we never remove it implicitly.
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
      if (!parent) continue; // can't remove the root
      // Clone the sibling so the collapsed node is a fresh reference — if we
      // hoisted the nested child directly into root, Preact signal subscribers
      // that compared `tree.root.id` or held a reference to the sub-node
      // could miss the change.
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
 * Open an artifact in the popout drawer overlay. Artifacts no longer split
 * the tree — splitting forced Preact to remount the chat under a new
 * SplitPane parent, which lost scroll position and felt jarring. The
 * drawer floats over the chat content and can be closed/resized in place.
 *
 * `position` is accepted for back-compat with older callers but is ignored.
 */
export function cosOpenArtifactTab(artifactId: string, _position: PanePosition = 'right') {
  void _position;
  openArtifactDrawerTab(artifactId);
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
    // Default ON so thread replies open in a companion pane instead of
    // expanding inline. Only an explicit '0' opts out.
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

/**
 * Per-bubble visibility filters for resolved / archived threads. Both default
 * to false so the operator only sees the active triage queue. Persisted across
 * sessions so the user's preferred filter state sticks.
 */
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

/**
 * Exclusive filter mode that overrides the show-resolved/show-archived
 * include-toggles when set. `default` defers to those toggles. `drafts`
 * shows only threads that have at least one saved draft (and the new-thread
 * scope if it has any). `archived` shows only archived threads.
 */
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

// Persist the active thread so reload reopens the same thread instead of
// landing on the empty "pick a thread" placeholder. ThreadPanel auto-closes
// itself if the thread no longer exists, so a stale value is harmless.
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
// Skip the initial subscribe run so reload doesn't wipe a freshly-restored
// drawer state.
let prevActiveThreadKey: string | null | undefined = undefined;
effect(() => {
  const v = cosActiveThread.value;
  const key = v ? `${v.agentId}::${v.threadKey}` : null;
  if (prevActiveThreadKey !== undefined && prevActiveThreadKey !== key) {
    closeArtifactDrawer();
  }
  prevActiveThreadKey = key;
});

// --- Per-thread composer drafts ---
//
// Drafts are keyed by `${agentId}::${threadKey}` and persisted across reloads
// and thread switches so a half-typed reply isn't lost when the operator
// flips between threads.

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
 * Open the slack-mode thread companion. The thread renders as an overlay
 * drawer over the chat (see `cos-thread-drawer`) — this just makes sure the
 * drawer is visible. The actual thread to render is keyed off
 * `cosActiveThread`, which the caller sets before invoking this.
 *
 * `_position` is accepted for back-compat with older callers but ignored.
 */
export function cosOpenThreadTab(_position: PanePosition = 'right') {
  void _position;
  setThreadDrawerVisible(true);
}

export function cosCloseThreadTab() {
  setThreadDrawerVisible(false);
}

function pickAnchorLeafId(): string {
  const tree = cosPopoutTree.value;
  // Prefer the leaf that holds the chat tab — it's the "anchor" the user sees.
  const chatLeaf = findLeafWithTabLocal(tree.root, COS_POPOUT_CHAT_TAB);
  if (chatLeaf) return chatLeaf.id;
  if (tree.focusedLeafId) {
    const focused = findLeafLocal(tree.root, tree.focusedLeafId);
    if (focused) return focused.id;
  }
  const anyLeaf = getAllLeavesLocal(tree.root)[0];
  return anyLeaf?.id ?? COS_POPOUT_ROOT_LEAF;
}

export function cosResetPopoutTree() {
  commit(buildDefault());
}
