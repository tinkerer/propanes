// Drag-and-drop helper for the CoS popout tree. Mirrors the main pane-tree
// drag (`tab-drag.ts`) but mutates `cos-popout-tree.ts` so we don't bleed
// CoS-only state into the main pane-tree mutators.
//
// Reuses the shared `dragOverLeafZone` signal from `tab-drag.ts` for hover
// visuals — leaf ids are distinct namespaces, so subscribers in either tree
// only react to their own leaves.

import {
  cosFindLeafWithTab,
  cosMoveTab,
  cosReorderTabInLeaf,
  cosRemoveTabFromLeaf,
  cosSplitLeaf,
  cosGetAllLeaves,
  cosDockTabToEdge,
  cosAddTabToLeaf,
} from './cos-popout-tree.js';
import {
  dragOverLeafZone,
  detectExternalZone,
  applyExternalGhostHint,
  openCosExternally,
} from './tab-drag.js';

/**
 * Cos-popout-specific drop zone set. Same shape semantics as the main tree's
 * `LeafDropZone` plus explicit edge zones for the companion-drawer dock
 * gesture.
 */
export type CosLeafDropZone =
  | 'tab'
  | 'h-split'
  | 'v-split'
  | 'left-edge'
  | 'right-edge'
  | 'top-edge'
  | 'bottom-edge';

/** Top-level dock target — drop on the popout's outer resizer to make the
 *  dragged content a companion drawer at that edge of the popout itself. */
export type CosPopoutEdge = 'L' | 'R' | 'T' | 'B';

type CosDropTarget =
  | { kind: 'leaf'; leafId: string; zone: CosLeafDropZone }
  | { kind: 'popout-edge'; edge: CosPopoutEdge };

export interface CosTabDragConfig {
  tabId: string;
  leafId: string;
  label: string;
  onClickFallback: () => void;
}

export interface CosLeafDragConfig {
  leafId: string;
  label: string;
  onClickFallback: () => void;
}

const DRAG_THRESHOLD = 6;
const EDGE_FRACTION = 0.18; // 18% strip on each edge counts as edge-dock zone

function inEdgeZone(x: number, y: number, leafEl: HTMLElement): CosLeafDropZone | null {
  const rect = leafEl.getBoundingClientRect();
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;
  if (relY < EDGE_FRACTION && relX > EDGE_FRACTION && relX < 1 - EDGE_FRACTION) return 'top-edge';
  if (relY > 1 - EDGE_FRACTION && relX > EDGE_FRACTION && relX < 1 - EDGE_FRACTION) return 'bottom-edge';
  if (relX < EDGE_FRACTION) return 'left-edge';
  if (relX > 1 - EDGE_FRACTION) return 'right-edge';
  return null;
}

function computeLeafZone(x: number, y: number, leafEl: HTMLElement): CosLeafDropZone {
  const tabBar = leafEl.querySelector('.cos-tree-tab-bar') as HTMLElement | null;
  if (tabBar) {
    const r = tabBar.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) return 'tab';
  }
  const edge = inEdgeZone(x, y, leafEl);
  if (edge) return edge;
  const rect = leafEl.getBoundingClientRect();
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;
  return relY > relX ? 'v-split' : 'h-split';
}

/** Inspect elementsFromPoint for the popout's outer resizer strip; if the
 *  cursor is on one and it belongs to a `.cos-popout` panel, return the
 *  matching `CosPopoutEdge`. */
function popoutEdgeAt(x: number, y: number, ghost: HTMLElement | null): CosPopoutEdge | null {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (el === ghost) continue;
    const he = el as HTMLElement;
    const resizeEl = he.closest?.('.popout-resize-w, .popout-resize-e, .popout-resize-n, .popout-resize-s') as HTMLElement | null;
    if (!resizeEl) continue;
    if (!resizeEl.closest?.('.cos-popout')) continue;
    const c = resizeEl.className;
    if (c.includes('popout-resize-w')) return 'L';
    if (c.includes('popout-resize-e')) return 'R';
    if (c.includes('popout-resize-n')) return 'T';
    if (c.includes('popout-resize-s')) return 'B';
  }
  return null;
}

function applyEdgeSplit(targetLeafId: string, zone: CosLeafDropZone, tabIds: string[]): void {
  switch (zone) {
    case 'left-edge':
    case 'right-edge':
    case 'top-edge':
    case 'bottom-edge': {
      // In-leaf edge zones promote to a popout-level floating companion drawer:
      // the drawer overlays the popout edge instead of resizing the existing
      // content. The user's chosen edge is authoritative — drop on the right
      // edge with an existing right drawer merges as a tab; drop on the left
      // edge creates a fresh left drawer overlay. cosDockAsFloatingCompanion's
      // sibling-split behavior is reserved for the artifact picker (where the
      // caller doesn't pick an edge).
      const edge: CosPopoutEdge =
        zone === 'left-edge' ? 'L' :
        zone === 'right-edge' ? 'R' :
        zone === 'top-edge' ? 'T' : 'B';
      if (tabIds.length === 0) break;
      cosDockTabToEdge(tabIds[0], edge, true, { floating: true });
      const dockedLeaf = cosFindLeafWithTab(tabIds[0]);
      if (dockedLeaf) {
        for (let i = 1; i < tabIds.length; i++) cosAddTabToLeaf(dockedLeaf.id, tabIds[i], false);
      }
      break;
    }
    case 'h-split':
      cosSplitLeaf(targetLeafId, 'horizontal', 'second', tabIds, 0.5);
      break;
    case 'v-split':
      cosSplitLeaf(targetLeafId, 'vertical', 'second', tabIds, 0.5);
      break;
    default:
      break;
  }
}

/** Highlight the popout-resize edge strip during drag. Same .drop-target
 *  visual the leaf uses; CSS picks it up via the resizer class. */
function highlightPopoutResizer(edge: CosPopoutEdge | null): Element | null {
  document.querySelectorAll('.cos-popout .popout-resize-w, .cos-popout .popout-resize-e, .cos-popout .popout-resize-n, .cos-popout .popout-resize-s')
    .forEach((el) => el.classList.remove('drop-target'));
  if (!edge) return null;
  const sel =
    edge === 'L' ? '.cos-popout .popout-resize-w' :
    edge === 'R' ? '.cos-popout .popout-resize-e' :
    edge === 'T' ? '.cos-popout .popout-resize-n' :
                   '.cos-popout .popout-resize-s';
  const el = document.querySelector(sel);
  if (el) el.classList.add('drop-target');
  return el;
}

export function startCosTabDrag(e: MouseEvent, config: CosTabDragConfig): void {
  const target = e.target as HTMLElement;
  if (target.closest('.cos-tree-tab-close')) return;

  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  const sourceTab = e.currentTarget as HTMLElement;
  let dropTarget: CosDropTarget | null = null;
  let lastHighlighted: Element | null = null;
  let reorderIndicator: HTMLElement | null = null;
  let reorderInsertBefore: string | null = null;

  function createGhost() {
    ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.textContent = config.label;
    document.body.appendChild(ghost);
    sourceTab?.classList.add('tab-dragging');
  }
  function updateGhost(x: number, y: number) {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y - 12}px`;
  }

  function detectDropTarget(x: number, y: number): CosDropTarget | null {
    // Popout-edge wins over any leaf detection — the resizer overlays the
    // outer chrome and is what the operator targets when "throwing" a tab to
    // the popout's edge.
    const edge = popoutEdgeAt(x, y, ghost);
    if (edge) return { kind: 'popout-edge', edge };

    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el === ghost || el === reorderIndicator) continue;
      const leafEl = (el as HTMLElement).closest?.('[data-cos-leaf-id]') as HTMLElement | null;
      if (!leafEl) continue;
      const leafId = leafEl.dataset.cosLeafId!;
      if (leafId === config.leafId) {
        const zone = computeLeafZone(x, y, leafEl);
        if (zone === 'tab') continue;
        return null;
      }
      const zone = computeLeafZone(x, y, leafEl);
      return { kind: 'leaf', leafId, zone };
    }
    return null;
  }

  function highlightTarget(target: CosDropTarget | null) {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('drop-target');
      lastHighlighted = null;
    }
    highlightPopoutResizer(null);
    if (!target) {
      ghost?.classList.remove('will-drop');
      dragOverLeafZone.value = null;
      return;
    }
    ghost?.classList.add('will-drop');

    if (target.kind === 'popout-edge') {
      dragOverLeafZone.value = null;
      lastHighlighted = highlightPopoutResizer(target.edge);
      if (ghost) {
        const labelMap = { L: 'Dock as drawer ◂ Left edge', R: 'Dock as drawer ▸ Right edge', T: 'Dock as drawer ▴ Top edge', B: 'Dock as drawer ▾ Bottom edge' };
        ghost.textContent = `${config.label} → ${labelMap[target.edge]}`;
      }
      return;
    }

    if (ghost && ghost.textContent !== config.label) ghost.textContent = config.label;
    dragOverLeafZone.value = { leafId: target.leafId, zone: target.zone as unknown as 'tab' | 'h-split' | 'v-split' | 'self-popout' };
    if (target.zone === 'tab') {
      const el = document.querySelector(`[data-cos-leaf-id="${target.leafId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    }
  }

  function updateReorderIndicator(x: number, y: number) {
    const els = document.elementsFromPoint(x, y);
    let tabBar: HTMLElement | null = null;

    for (const el of els) {
      if (el === ghost || el === reorderIndicator) continue;
      const leafEl = (el as HTMLElement).closest?.(`[data-cos-leaf-id="${config.leafId}"]`) as HTMLElement | null;
      if (!leafEl) continue;
      const tb = leafEl.querySelector('.cos-tree-tab-bar') as HTMLElement | null;
      if (!tb) continue;
      const r = tb.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) {
        tabBar = tb;
        break;
      }
    }

    if (!tabBar) {
      removeReorderIndicator();
      reorderInsertBefore = null;
      return;
    }

    const tabs = Array.from(tabBar.querySelectorAll('.cos-tree-tab')) as HTMLElement[];
    const leaf = cosFindLeafWithTab(config.tabId);
    const leafTabs = leaf?.tabs ?? [];
    let insertBefore: string | null = null;
    let indicatorX = 0;
    let found = false;

    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (x < mid) {
        insertBefore = leafTabs[i] || null;
        indicatorX = rect.left;
        found = true;
        break;
      }
    }
    if (!found && tabs.length > 0) {
      const lastRect = tabs[tabs.length - 1].getBoundingClientRect();
      indicatorX = lastRect.right;
      insertBefore = null;
    }

    reorderInsertBefore = insertBefore;
    if (!reorderIndicator) {
      reorderIndicator = document.createElement('div');
      reorderIndicator.className = 'tab-reorder-indicator';
      document.body.appendChild(reorderIndicator);
    }
    const barRect = tabBar.getBoundingClientRect();
    reorderIndicator.style.left = `${indicatorX}px`;
    reorderIndicator.style.top = `${barRect.top}px`;
    reorderIndicator.style.height = `${barRect.height}px`;
  }

  function removeReorderIndicator() {
    if (reorderIndicator) {
      reorderIndicator.remove();
      reorderIndicator = null;
    }
  }

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      dragging = true;
      createGhost();
    }
    if (!dragging) return;
    updateGhost(ev.clientX, ev.clientY);
    const ext = applyExternalGhostHint(ghost, config.label, ev.clientX, ev.clientY);
    if (ext) {
      dropTarget = null;
      highlightTarget(null);
      removeReorderIndicator();
      return;
    }
    dropTarget = detectDropTarget(ev.clientX, ev.clientY);
    highlightTarget(dropTarget);
    updateReorderIndicator(ev.clientX, ev.clientY);
  }

  function onUp(ev: MouseEvent) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (lastHighlighted) lastHighlighted.classList.remove('drop-target');
    highlightPopoutResizer(null);
    sourceTab?.classList.remove('tab-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    const hadReorderIndicator = !!reorderIndicator;
    removeReorderIndicator();
    dragOverLeafZone.value = null;

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    const ext = detectExternalZone(ev.clientX, ev.clientY);
    if (ext) {
      openCosExternally(ext);
      return;
    }

    if (hadReorderIndicator && reorderInsertBefore !== config.tabId) {
      cosReorderTabInLeaf(config.leafId, config.tabId, reorderInsertBefore);
      return;
    }

    if (!dropTarget) return;

    if (dropTarget.kind === 'popout-edge') {
      cosRemoveTabFromLeaf(config.leafId, config.tabId);
      cosDockTabToEdge(config.tabId, dropTarget.edge, true, { floating: true });
      return;
    }

    if (dropTarget.zone === 'tab') {
      cosMoveTab(config.leafId, dropTarget.leafId, config.tabId, true);
      return;
    }

    cosRemoveTabFromLeaf(config.leafId, config.tabId);
    applyEdgeSplit(dropTarget.leafId, dropTarget.zone, [config.tabId]);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * Drag the whole leaf via its hamburger button. Same drop-zone semantics as
 * tab drag: dropping on the popout's outer resizer docks the entire pane as
 * a companion drawer; dropping on a leaf merges or splits.
 */
export function startCosLeafDrag(e: MouseEvent, config: CosLeafDragConfig): void {
  const target = e.target as HTMLElement;
  if (target.closest('.cos-tree-action-close')) return;

  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let dropTarget: CosDropTarget | null = null;
  let lastHighlighted: Element | null = null;

  function createGhost() {
    ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.textContent = config.label;
    document.body.appendChild(ghost);
  }
  function updateGhost(x: number, y: number) {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y - 12}px`;
  }

  function detectDropTarget(x: number, y: number): CosDropTarget | null {
    const edge = popoutEdgeAt(x, y, ghost);
    if (edge) return { kind: 'popout-edge', edge };

    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el === ghost) continue;
      const leafEl = (el as HTMLElement).closest?.('[data-cos-leaf-id]') as HTMLElement | null;
      if (!leafEl) continue;
      const leafId = leafEl.dataset.cosLeafId!;
      if (leafId === config.leafId) return null;
      return { kind: 'leaf', leafId, zone: computeLeafZone(x, y, leafEl) };
    }
    return null;
  }

  function highlightTarget(target: CosDropTarget | null) {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('drop-target');
      lastHighlighted = null;
    }
    highlightPopoutResizer(null);
    if (!target) {
      ghost?.classList.remove('will-drop');
      dragOverLeafZone.value = null;
      return;
    }
    ghost?.classList.add('will-drop');

    if (target.kind === 'popout-edge') {
      dragOverLeafZone.value = null;
      lastHighlighted = highlightPopoutResizer(target.edge);
      if (ghost) {
        const labelMap = { L: 'Dock pane ◂ Left edge', R: 'Dock pane ▸ Right edge', T: 'Dock pane ▴ Top edge', B: 'Dock pane ▾ Bottom edge' };
        ghost.textContent = `${config.label} → ${labelMap[target.edge]}`;
      }
      return;
    }

    if (ghost && ghost.textContent !== config.label) ghost.textContent = config.label;
    dragOverLeafZone.value = { leafId: target.leafId, zone: target.zone as unknown as 'tab' | 'h-split' | 'v-split' | 'self-popout' };
    if (target.zone === 'tab') {
      const el = document.querySelector(`[data-cos-leaf-id="${target.leafId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    }
  }

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      dragging = true;
      createGhost();
    }
    if (!dragging) return;
    updateGhost(ev.clientX, ev.clientY);
    const ext = applyExternalGhostHint(ghost, config.label, ev.clientX, ev.clientY);
    if (ext) {
      dropTarget = null;
      highlightTarget(null);
      return;
    }
    dropTarget = detectDropTarget(ev.clientX, ev.clientY);
    highlightTarget(dropTarget);
  }

  function onUp(ev: MouseEvent) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (lastHighlighted) lastHighlighted.classList.remove('drop-target');
    highlightPopoutResizer(null);
    if (ghost) { ghost.remove(); ghost = null; }
    dragOverLeafZone.value = null;

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    const ext = detectExternalZone(ev.clientX, ev.clientY);
    if (ext) {
      openCosExternally(ext);
      return;
    }

    if (!dropTarget) return;

    const sourceLeaf = cosGetAllLeaves().find((l) => l.id === config.leafId);
    if (!sourceLeaf || sourceLeaf.tabs.length === 0) return;
    const tabs = [...sourceLeaf.tabs];

    if (dropTarget.kind === 'popout-edge') {
      // Dock the whole pane as a floating companion at the chosen popout edge.
      // The first tab opens (or merges into) the drawer at that edge;
      // subsequent tabs from the same source leaf join as additional tabs.
      for (const t of tabs) cosRemoveTabFromLeaf(config.leafId, t);
      cosDockTabToEdge(tabs[0], dropTarget.edge, true, { floating: true });
      const dockedLeaf = cosFindLeafWithTab(tabs[0]);
      if (dockedLeaf) {
        for (let i = 1; i < tabs.length; i++) cosAddTabToLeaf(dockedLeaf.id, tabs[i], false);
      }
      return;
    }

    if (dropTarget.zone === 'tab') {
      for (const t of tabs) cosMoveTab(config.leafId, dropTarget.leafId, t, false);
      return;
    }

    for (const t of tabs) cosRemoveTabFromLeaf(config.leafId, t);
    applyEdgeSplit(dropTarget.leafId, dropTarget.zone, tabs);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
