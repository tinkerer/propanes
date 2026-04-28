// Chief-of-Staff panel/pane lifecycle.
//
// The CoS UI has two surfaces: a floating popout panel (managed via
// popout-state) and a first-class tab in the layout tree. This module owns
// the helpers that switch between them — `setChiefOfStaffOpen`/`toggleChiefOfStaff`
// drive the popout visibility, while `openCosInPane`/`closeCosPane`/`isCosInPane`
// manage the layout-tree tab. `ensureCosPanel` provisions the popout state
// row on first use.
//
// The `chiefOfStaffOpen` signal still lives in `chief-of-staff.ts` because
// it is persisted alongside the other CoS UI state. We import it here so
// the open/close helpers can mutate it.

import {
  popoutPanels,
  updatePanel,
  bringToFront,
  persistPopoutState,
  COS_PANEL_ID,
  type PopoutPanelState,
} from './popout-state.js';
import {
  layoutTree,
  findLeafWithTab,
  findLeaf,
  focusedLeafId,
  addTabToLeaf,
  setActiveTab,
  setFocusedLeaf,
  splitLeaf,
  removeTabFromLeaf,
  SIDEBAR_LEAF_ID,
  getAllLeaves,
} from './pane-tree.js';
import { isMobile } from './viewport.js';
import { chiefOfStaffOpen } from './chief-of-staff.js';

export function ensureCosPanel(): PopoutPanelState {
  const existing = popoutPanels.value.find((p) => p.id === COS_PANEL_ID);
  if (existing) return existing;
  const w = 420;
  const h = 600;
  const panel: PopoutPanelState = {
    id: COS_PANEL_ID,
    sessionIds: [],
    activeSessionId: '',
    docked: false,
    visible: chiefOfStaffOpen.value,
    floatingRect: {
      x: Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1024) - w - 16),
      y: 72,
      w,
      h,
    },
    dockedHeight: h,
    dockedWidth: w,
    alwaysOnTop: true,
  };
  popoutPanels.value = [...popoutPanels.value, panel];
  return panel;
}

export function setChiefOfStaffOpen(open: boolean): void {
  ensureCosPanel();
  chiefOfStaffOpen.value = open;
  updatePanel(COS_PANEL_ID, { visible: open, minimized: false });
  if (open) bringToFront(COS_PANEL_ID);
  persistPopoutState();
}

export function toggleChiefOfStaff(): void {
  setChiefOfStaffOpen(!chiefOfStaffOpen.value);
}

/** Single well-known tab id for the in-tree CoS pane. */
export const COS_PANE_TAB_ID = 'cos:main';

/**
 * Open the CoS as a first-class pane in the layout tree. If the cos tab
 * already exists, focus/activate it. Otherwise insert it into the focused
 * leaf (or split the main content leaf). Hides the floating popout.
 */
export function openCosInPane(): void {
  // Mobile: the layout renders MobilePageView instead of the pane tree, so a
  // cos:main tab added to the tree would be invisible. Fall back to the
  // floating popout (which has full-screen mobile CSS). Also strip any stale
  // pane tab so the popout's !hasCosTabInTree guard doesn't suppress it.
  if (isMobile.value) {
    const stale = findLeafWithTab(COS_PANE_TAB_ID);
    if (stale) removeTabFromLeaf(stale.id, COS_PANE_TAB_ID);
    setChiefOfStaffOpen(true);
    return;
  }

  // If already open, just activate.
  const existing = findLeafWithTab(COS_PANE_TAB_ID);
  if (existing) {
    setActiveTab(existing.id, COS_PANE_TAB_ID);
    setFocusedLeaf(existing.id);
    // Also hide the floating popout so only one cos UI is visible.
    chiefOfStaffOpen.value = false;
    updatePanel(COS_PANEL_ID, { visible: false });
    persistPopoutState();
    return;
  }

  // Pick a target leaf: focused (non-sidebar) leaf, else first non-sidebar leaf.
  const sidebarIds = new Set([SIDEBAR_LEAF_ID, 'sidebar-sessions', 'sidebar-terminals', 'sidebar-files']);
  const tree = layoutTree.value;
  const focused = focusedLeafId.value;
  let targetLeaf = focused ? findLeaf(tree.root, focused) : null;
  if (!targetLeaf || sidebarIds.has(targetLeaf.id)) {
    const mainLeaf = getAllLeaves(tree.root).find((l) => !sidebarIds.has(l.id));
    targetLeaf = mainLeaf ?? null;
  }
  if (!targetLeaf) return;

  // If the target already has tabs, split right with the cos tab so it gets
  // its own pane rather than becoming a sibling tab. This matches the
  // first-class-pane intent.
  if (targetLeaf.tabs.length > 0) {
    const newLeaf = splitLeaf(targetLeaf.id, 'horizontal', 'second', [COS_PANE_TAB_ID], 0.6);
    if (newLeaf) setFocusedLeaf(newLeaf.id);
  } else {
    addTabToLeaf(targetLeaf.id, COS_PANE_TAB_ID, true);
    setFocusedLeaf(targetLeaf.id);
  }

  // Hide the popout so we show one CoS surface at a time.
  chiefOfStaffOpen.value = false;
  updatePanel(COS_PANEL_ID, { visible: false });
  persistPopoutState();
}

/** True when the CoS tab is present somewhere in the layout tree. */
export function isCosInPane(): boolean {
  return !!findLeafWithTab(COS_PANE_TAB_ID);
}

export function closeCosPane(): void {
  // On mobile the pane-mode surface is the popout (see openCosInPane), so the
  // "close pane" toggle means "hide the popout." Still sweep any stale pane
  // tab so a subsequent open isn't blocked by shouldRenderShell's
  // !hasCosTabInTree guard.
  if (isMobile.value) {
    const stale = findLeafWithTab(COS_PANE_TAB_ID);
    if (stale) removeTabFromLeaf(stale.id, COS_PANE_TAB_ID);
    setChiefOfStaffOpen(false);
    return;
  }
  const existing = findLeafWithTab(COS_PANE_TAB_ID);
  if (!existing) return;
  removeTabFromLeaf(existing.id, COS_PANE_TAB_ID);
}
