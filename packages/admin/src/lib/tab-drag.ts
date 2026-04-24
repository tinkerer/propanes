import { signal } from '@preact/signals';
import {
  openTabs,
  popOutTab,
  popOutLeafAsPanel,
  popBackIn,
  popBackInPanelToLeaf,
  popBackInPanelToLeafWithSplit,
  moveSessionToPanel,
  splitFromPanel,
  findPanelForSession,
  reorderTabInPanel,
  reorderGlobalTab,
  splitEnabled,
  rightPaneTabs,
  leftPaneTabs,
  moveToRightPane,
  moveToLeftPane,
  reorderRightPaneTab,
  moveToPanelRightPane,
  moveToPanelLeftPane,
  popoutPanels,
  persistPopoutState,
  closeTab,
} from './sessions.js';
import {
  findLeaf,
  findLeafWithTab,
  moveTab,
  removeTabFromLeaf,
  addTabToLeaf,
  reorderTabInLeaf,
  splitLeaf,
  batch as batchTreeOps,
  layoutTree,
} from './pane-tree.js';
import { buildPanelRoute } from '../pages/StandalonePanelPage.js';

export type TabDragSource = 'main' | 'split-left' | 'split-right' | { panelId: string } | { type: 'leaf'; leafId: string };

export interface TabDragConfig {
  sessionId: string;
  source: TabDragSource;
  label: string;
  onClickFallback: () => void;
}

export type LeafDropZone = 'tab' | 'h-split' | 'v-split' | 'self-popout';

export const dragOverLeafZone = signal<{ leafId: string; zone: LeafDropZone } | null>(null);

const DRAG_THRESHOLD = 6;

// Detect if cursor was released outside the viewport, into browser chrome:
// - top (y < 0) → user likely targeted the browser tab bar → open in new browser tab
// - sides (x outside [0, innerWidth]) → open as a separate browser window
// - bottom (y > innerHeight) → also a window (less common)
export type ExternalDragZone = 'new-tab' | 'new-window';

export function detectExternalZone(x: number, y: number): ExternalDragZone | null {
  if (y < 0) return 'new-tab';
  if (x < 0 || x > window.innerWidth) return 'new-window';
  if (y > window.innerHeight) return 'new-window';
  return null;
}

export function openSessionExternally(sessionId: string, zone: ExternalDragZone) {
  const url = `${location.origin}${location.pathname}#/session/${encodeURIComponent(sessionId)}`;
  if (zone === 'new-tab') {
    window.open(url, '_blank');
  } else {
    const w = Math.min(1200, Math.max(640, Math.floor(window.innerWidth * 0.6)));
    const h = Math.min(900, Math.max(480, Math.floor(window.innerHeight * 0.7)));
    window.open(url, `pw-popout-${sessionId}`, `popup=yes,width=${w},height=${h}`);
  }
}

// Open a multi-tab panel externally. The new tab/window loads `/panel/<ids>?...`
// which renders the full tab bar + active tab, so dragging a pane's hamburger
// out of the window preserves all tabs (not just the active one).
export function openPanelExternally(
  opts: { sessionIds: string[]; activeId?: string | null; rightIds?: string[]; ratio?: number },
  zone: ExternalDragZone
) {
  const { sessionIds, activeId, rightIds, ratio } = opts;
  if (sessionIds.length === 0) return;
  const route = buildPanelRoute({ sessionIds, activeId, rightIds, ratio });
  const url = `${location.origin}${location.pathname}#${route}`;
  if (zone === 'new-tab') {
    window.open(url, '_blank');
  } else {
    const w = Math.min(1400, Math.max(800, Math.floor(window.innerWidth * 0.7)));
    const h = Math.min(1000, Math.max(520, Math.floor(window.innerHeight * 0.75)));
    const winName = `pw-panel-${sessionIds.join('-').slice(0, 40)}`;
    window.open(url, winName, `popup=yes,width=${w},height=${h}`);
  }
}

// Open the Chief of Staff (Ops) panel in its standalone embed mode in a new
// browser tab/window. URL: `<origin><pathname>?embed=cos` — the App router
// detects `embed=cos` and renders the CoS-only embed.
export function openCosExternally(zone: ExternalDragZone) {
  const url = `${location.origin}${location.pathname}?embed=cos`;
  if (zone === 'new-tab') {
    window.open(url, '_blank');
  } else {
    const w = Math.min(640, Math.max(420, Math.floor(window.innerWidth * 0.4)));
    const h = Math.min(900, Math.max(520, Math.floor(window.innerHeight * 0.75)));
    window.open(url, 'pw-cos-popout', `popup=yes,width=${w},height=${h}`);
  }
}

// Show a ghost hint when dragging outside the viewport. Keeps the ghost visible
// at the viewport edge and changes its text to describe the external action.
export function applyExternalGhostHint(
  ghost: HTMLElement | null,
  baseLabel: string,
  x: number,
  y: number
): ExternalDragZone | null {
  if (!ghost) return null;
  const ext = detectExternalZone(x, y);
  if (ext) {
    ghost.classList.add('will-external');
    ghost.textContent = ext === 'new-tab'
      ? `${baseLabel} → new browser tab`
      : `${baseLabel} → new browser window`;
    const cx = Math.max(10, Math.min(window.innerWidth - 260, x + 12));
    const cy = Math.max(10, Math.min(window.innerHeight - 40, y - 12));
    ghost.style.left = `${cx}px`;
    ghost.style.top = `${cy}px`;
  } else {
    ghost.classList.remove('will-external');
    if (ghost.textContent !== baseLabel) ghost.textContent = baseLabel;
  }
  return ext;
}

function sourceIsLeaf(source: TabDragSource): string | null {
  if (typeof source === 'object' && 'type' in source && source.type === 'leaf') return source.leafId;
  return null;
}

function computeLeafZone(x: number, y: number, leafEl: HTMLElement): LeafDropZone {
  // Check if cursor is over the tab bar or singleton handle
  const tabBar = leafEl.querySelector('.pane-leaf-tabs') as HTMLElement | null;
  const singletonHandle = leafEl.querySelector('.singleton-handle') as HTMLElement | null;
  const headerEl = tabBar || singletonHandle;
  if (headerEl) {
    const headerRect = headerEl.getBoundingClientRect();
    if (y >= headerRect.top && y <= headerRect.bottom && x >= headerRect.left && x <= headerRect.right) {
      return 'tab';
    }
  }

  // Diagonal split: relY > relX means lower-left (v-split), else upper-right (h-split)
  const rect = leafEl.getBoundingClientRect();
  const relX = (x - rect.left) / rect.width;
  const relY = (y - rect.top) / rect.height;
  return relY > relX ? 'v-split' : 'h-split';
}

export function startTabDrag(e: MouseEvent, config: TabDragConfig): void {
  const target = e.target as HTMLElement;
  if (target.closest('.tab-close, .popout-tab-close, .status-dot')) return;

  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let sourceTab: HTMLElement | null = (e.currentTarget as HTMLElement);
  let dropTarget: { type: 'panel'; panelId: string } | { type: 'main' } | { type: 'split-left' } | { type: 'split-right' } | { type: 'popout-split'; panelId: string; pane: 'left' | 'right' } | { type: 'leaf'; leafId: string; zone: LeafDropZone } | null = null;
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

  function sourceIsPanelId(): string | null {
    if (typeof config.source === 'object' && 'panelId' in config.source) return config.source.panelId;
    return null;
  }

  function detectDropTarget(x: number, y: number): typeof dropTarget {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el === ghost || el === reorderIndicator) continue;

      // Check popout split panes
      const popoutSplitPane = (el as HTMLElement).closest?.('[data-popout-split-pane]') as HTMLElement | null;
      if (popoutSplitPane) {
        const val = popoutSplitPane.dataset.popoutSplitPane!; // "panelId:left" or "panelId:right"
        const colonIdx = val.lastIndexOf(':');
        const panelId = val.slice(0, colonIdx);
        const pane = val.slice(colonIdx + 1) as 'left' | 'right';
        const srcPanelId = sourceIsPanelId();
        if (srcPanelId === panelId) {
          return { type: 'popout-split', panelId, pane };
        }
        return { type: 'popout-split', panelId, pane };
      }

      // Check leaf panes
      const leafEl = (el as HTMLElement).closest?.('[data-leaf-id]') as HTMLElement | null;
      if (leafEl) {
        const leafId = leafEl.dataset.leafId!;
        const srcLeafId = sourceIsLeaf(config.source);
        if (srcLeafId && srcLeafId === leafId) {
          // Same leaf: tab bar → let reorder logic handle it; content area → pop out to new panel.
          const zone = computeLeafZone(x, y, leafEl);
          if (zone === 'tab') continue;
          return { type: 'leaf', leafId, zone: 'self-popout' };
        }
        const zone = computeLeafZone(x, y, leafEl);
        return { type: 'leaf', leafId, zone };
      }

      // Check split panes
      const splitPane = (el as HTMLElement).closest?.('[data-split-pane]') as HTMLElement | null;
      if (splitPane) {
        const paneId = splitPane.dataset.splitPane as 'split-left' | 'split-right';
        if (config.source === paneId) continue;
        return { type: paneId };
      }

      const panelEl = (el as HTMLElement).closest?.('[data-panel-id]') as HTMLElement | null;
      if (panelEl) {
        const panelId = panelEl.dataset.panelId!;
        const srcPanelId = sourceIsPanelId();
        if (srcPanelId && srcPanelId === panelId) continue;
        return { type: 'panel', panelId };
      }
      if ((el as HTMLElement).closest?.('.terminal-tab-bar')) {
        if (config.source === 'main') continue;
        return { type: 'main' };
      }
    }
    return null;
  }

  function highlightTarget(target: typeof dropTarget) {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('drop-target');
      lastHighlighted = null;
    }
    if (!target) {
      ghost?.classList.remove('will-drop');
      dragOverLeafZone.value = null;
      return;
    }
    ghost?.classList.add('will-drop');
    if (target.type === 'popout-split') {
      dragOverLeafZone.value = null;
      const el = document.querySelector(`[data-popout-split-pane="${target.panelId}:${target.pane}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else if (target.type === 'panel') {
      dragOverLeafZone.value = null;
      const el = document.querySelector(`[data-panel-id="${target.panelId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else if (target.type === 'leaf') {
      // Update zone signal for DiagonalDropZone component
      dragOverLeafZone.value = { leafId: target.leafId, zone: target.zone };
      if (target.zone === 'tab') {
        // Highlight the tab bar / handle
        const el = document.querySelector(`[data-leaf-id="${target.leafId}"]`);
        if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
      }
      // For h-split/v-split zones, the DiagonalDropZone handles the visual
    } else if (target.type === 'split-left' || target.type === 'split-right') {
      dragOverLeafZone.value = null;
      const el = document.querySelector(`[data-split-pane="${target.type}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else {
      dragOverLeafZone.value = null;
      const el = document.querySelector('.terminal-tab-bar');
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    }
  }

  function updateReorderIndicator(x: number, y: number) {
    const els = document.elementsFromPoint(x, y);
    let tabBar: HTMLElement | null = null;
    let isSamePanel = false;

    const srcLeafId = sourceIsLeaf(config.source);

    for (const el of els) {
      if (el === ghost || el === reorderIndicator) continue;

      // Check leaf pane tab bars (same leaf only) — must actually be over the tab bar,
      // not just anywhere in the source leaf (else content-area hover triggers reorder).
      if (srcLeafId) {
        const leafEl = (el as HTMLElement).closest?.(`[data-leaf-id="${srcLeafId}"]`) as HTMLElement | null;
        if (leafEl) {
          const tb = leafEl.querySelector('.pane-leaf-tabs') as HTMLElement | null;
          if (tb) {
            const tbRect = tb.getBoundingClientRect();
            if (y >= tbRect.top && y <= tbRect.bottom && x >= tbRect.left && x <= tbRect.right) {
              tabBar = tb; isSamePanel = true; break;
            }
          }
        }
      }

      // Check split pane tab bars
      if (config.source === 'split-left' || config.source === 'split-right') {
        const splitPane = (el as HTMLElement).closest?.(`[data-split-pane="${config.source}"]`) as HTMLElement | null;
        if (splitPane) {
          const tb = splitPane.querySelector('.split-pane-tab-bar .terminal-tabs') as HTMLElement | null;
          if (tb) { tabBar = tb; isSamePanel = true; break; }
        }
      }

      // Check popout panel tab bars
      const srcPanelId = sourceIsPanelId();
      if (srcPanelId) {
        const panelEl = (el as HTMLElement).closest?.('[data-panel-id]') as HTMLElement | null;
        if (panelEl && panelEl.dataset.panelId === srcPanelId) {
          const tb = panelEl.querySelector('.popout-tab-bar') as HTMLElement | null;
          if (tb) { tabBar = tb; isSamePanel = true; break; }
        }
      }
      // Check global tab bar
      if (config.source === 'main') {
        const tb = (el as HTMLElement).closest?.('.terminal-tabs') as HTMLElement | null;
        if (tb && !tb.closest('[data-split-pane]')) { tabBar = tb; isSamePanel = true; break; }
      }
    }

    if (!isSamePanel || !tabBar) {
      removeReorderIndicator();
      reorderInsertBefore = null;
      return;
    }

    const tabSelector = srcLeafId ? '.pane-leaf-tab'
      : (config.source === 'main' || config.source === 'split-left' || config.source === 'split-right')
        ? '.terminal-tab' : '.popout-tab';
    const tabs = Array.from(tabBar.querySelectorAll(tabSelector)) as HTMLElement[];
    let insertBefore: string | null = null;
    let indicatorX = 0;
    let found = false;

    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (x < mid) {
        const tabIdx = tabs.indexOf(tab);
        if (srcLeafId) {
          const leaf = findLeafWithTab(config.sessionId);
          if (leaf) insertBefore = leaf.tabs[tabIdx] || null;
        } else if (config.source === 'main') {
          const tabIds = splitEnabled.value ? leftPaneTabs() : openTabs.value;
          insertBefore = tabIds[tabIdx] || null;
        } else if (config.source === 'split-left') {
          insertBefore = leftPaneTabs()[tabIdx] || null;
        } else if (config.source === 'split-right') {
          insertBefore = rightPaneTabs.value[tabIdx] || null;
        } else {
          const panel = findPanelForSession(config.sessionId);
          if (panel) insertBefore = panel.sessionIds[tabIdx] || null;
        }
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

  function handleLeafDrop(targetLeafId: string, zone: LeafDropZone, sessionId: string, srcLeafId: string | null, srcPanelId: string | null) {
    if (zone === 'self-popout') {
      if (srcLeafId) {
        removeTabFromLeaf(srcLeafId, sessionId);
      }
      popOutTab(sessionId);
      return;
    }
    if (zone === 'tab') {
      // Add as tab to the target leaf
      if (srcLeafId) {
        moveTab(srcLeafId, targetLeafId, sessionId);
      } else if (srcPanelId) {
        const panel = findPanelForSession(sessionId);
        if (panel) splitFromPanel(sessionId);
        addTabToLeaf(targetLeafId, sessionId, true);
      } else {
        closeTab(sessionId);
        addTabToLeaf(targetLeafId, sessionId, true);
      }
    } else {
      // Split the target leaf
      const dir = zone === 'h-split' ? 'horizontal' : 'vertical';
      if (srcLeafId) {
        removeTabFromLeaf(srcLeafId, sessionId, true);
      } else if (srcPanelId) {
        const panel = findPanelForSession(sessionId);
        if (panel) splitFromPanel(sessionId);
      } else {
        closeTab(sessionId);
      }
      splitLeaf(targetLeafId, dir, 'second', [sessionId]);
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
    sourceTab?.classList.remove('tab-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    const hadReorderIndicator = !!reorderIndicator;
    removeReorderIndicator();
    dragOverLeafZone.value = null;

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    const srcLeafId = sourceIsLeaf(config.source);
    const srcPanelId = sourceIsPanelId();

    // External zone: dragged outside the viewport → open in new browser tab/window.
    // closeTab handles removal from leaves, panels, and openTabs.
    const externalZone = detectExternalZone(ev.clientX, ev.clientY);
    if (externalZone) {
      openSessionExternally(config.sessionId, externalZone);
      closeTab(config.sessionId);
      return;
    }

    // Leaf pane source
    if (srcLeafId) {
      // Same-leaf reorder
      if (hadReorderIndicator && reorderInsertBefore !== config.sessionId) {
        reorderTabInLeaf(srcLeafId, config.sessionId, reorderInsertBefore);
        return;
      }
      // Drop onto another leaf (zone-aware)
      if (dropTarget?.type === 'leaf') {
        handleLeafDrop(dropTarget.leafId, dropTarget.zone, config.sessionId, srcLeafId, null);
        return;
      }
      // Drop onto a popout panel
      if (dropTarget?.type === 'panel') {
        removeTabFromLeaf(srcLeafId, config.sessionId);
        closeTab(config.sessionId);
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
        return;
      }
      if (dropTarget?.type === 'popout-split') {
        removeTabFromLeaf(srcLeafId, config.sessionId);
        closeTab(config.sessionId);
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
        if (dropTarget.pane === 'right') moveToPanelRightPane(dropTarget.panelId, config.sessionId);
        return;
      }
      // Drop onto old global terminal bar
      if (dropTarget?.type === 'main' || dropTarget?.type === 'split-left' || dropTarget?.type === 'split-right') {
        removeTabFromLeaf(srcLeafId, config.sessionId);
        return;
      }
      // Drop into empty space or same position in same tab group — pop out to floating panel
      if (!dropTarget) {
        removeTabFromLeaf(srcLeafId, config.sessionId);
        popOutTab(config.sessionId);
        return;
      }
      return;
    }

    // Old-style source handling (main, split-left, split-right, panel)
    if (config.source === 'main' || config.source === 'split-left') {
      // Same-pane reorder
      if (hadReorderIndicator && reorderInsertBefore !== config.sessionId) {
        if (config.source === 'split-left') {
          reorderGlobalTab(config.sessionId, reorderInsertBefore);
        } else {
          reorderGlobalTab(config.sessionId, reorderInsertBefore);
        }
        return;
      }
      if (dropTarget?.type === 'split-right') {
        moveToRightPane(config.sessionId);
      } else if (dropTarget?.type === 'leaf') {
        handleLeafDrop(dropTarget.leafId, dropTarget.zone, config.sessionId, null, null);
      } else if (dropTarget?.type === 'popout-split') {
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
        if (dropTarget.pane === 'right') moveToPanelRightPane(dropTarget.panelId, config.sessionId);
      } else if (dropTarget?.type === 'panel') {
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
      } else if (!dropTarget && !hadReorderIndicator) {
        popOutTab(config.sessionId);
      }
    } else if (config.source === 'split-right') {
      if (hadReorderIndicator && reorderInsertBefore !== config.sessionId) {
        reorderRightPaneTab(config.sessionId, reorderInsertBefore);
        return;
      }
      if (dropTarget?.type === 'main' || dropTarget?.type === 'split-left') {
        moveToLeftPane(config.sessionId);
      } else if (dropTarget?.type === 'leaf') {
        handleLeafDrop(dropTarget.leafId, dropTarget.zone, config.sessionId, null, null);
      } else if (dropTarget?.type === 'popout-split') {
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
        if (dropTarget.pane === 'right') moveToPanelRightPane(dropTarget.panelId, config.sessionId);
      } else if (dropTarget?.type === 'panel') {
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
      } else if (!dropTarget && !hadReorderIndicator) {
        popOutTab(config.sessionId);
      }
    } else if (srcPanelId) {
      if (hadReorderIndicator && reorderInsertBefore !== config.sessionId) {
        reorderTabInPanel(srcPanelId, config.sessionId, reorderInsertBefore);
        return;
      }
      if (dropTarget?.type === 'main' || dropTarget?.type === 'split-left') {
        popBackIn(config.sessionId);
      } else if (dropTarget?.type === 'split-right') {
        popBackIn(config.sessionId);
        moveToRightPane(config.sessionId);
      } else if (dropTarget?.type === 'leaf') {
        handleLeafDrop(dropTarget.leafId, dropTarget.zone, config.sessionId, null, srcPanelId);
      } else if (dropTarget?.type === 'popout-split') {
        if (dropTarget.panelId === srcPanelId) {
          if (dropTarget.pane === 'right') moveToPanelRightPane(srcPanelId, config.sessionId);
          else moveToPanelLeftPane(srcPanelId, config.sessionId);
        } else {
          moveSessionToPanel(config.sessionId, dropTarget.panelId);
          if (dropTarget.pane === 'right') moveToPanelRightPane(dropTarget.panelId, config.sessionId);
        }
      } else if (dropTarget?.type === 'panel' && dropTarget.panelId !== srcPanelId) {
        moveSessionToPanel(config.sessionId, dropTarget.panelId);
      } else if (!dropTarget && !hadReorderIndicator) {
        splitFromPanel(config.sessionId);
      }
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Standalone panel tab drag ---
//
// Used by the /panel/<ids> route (StandalonePanelPage) when the user is
// already in a popped-out browser tab/window. Dragging a tab out of the
// viewport opens that session in its own browser window; dragging within
// the viewport is a no-op (the standalone page has no in-page drop zones).
// A plain click (drag threshold not exceeded) falls through to onClickFallback.

export interface StandalonePanelTabDragConfig {
  sessionId: string;
  label: string;
  onExternalPopOut: (sessionId: string, zone: ExternalDragZone) => void;
  onClickFallback: () => void;
}

export function startStandalonePanelTabDrag(e: MouseEvent, config: StandalonePanelTabDragConfig): void {
  const target = e.target as HTMLElement;
  if (target.closest('.popout-tab-close, .status-dot')) return;

  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  const sourceTab = e.currentTarget as HTMLElement;

  function createGhost() {
    ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.textContent = config.label;
    document.body.appendChild(ghost);
    sourceTab.classList.add('tab-dragging');
  }

  function updateGhost(x: number, y: number) {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y - 12}px`;
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
    applyExternalGhostHint(ghost, config.label, ev.clientX, ev.clientY);
  }

  function onUp(ev: MouseEvent) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    sourceTab.classList.remove('tab-dragging');
    if (ghost) { ghost.remove(); ghost = null; }

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    const externalZone = detectExternalZone(ev.clientX, ev.clientY);
    if (externalZone) {
      config.onExternalPopOut(config.sessionId, externalZone);
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Leaf drag (drag whole pane via hamburger) ---

export interface LeafDragConfig {
  leafId: string;
  label: string;
  onClickFallback: () => void;
}

type LeafDragTarget =
  | { type: 'panel'; panelId: string }
  | { type: 'leaf'; leafId: string; zone: LeafDropZone }
  | null;

export function startLeafDrag(e: MouseEvent, config: LeafDragConfig): void {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let dropTarget: LeafDragTarget = null;
  let lastHighlighted: Element | null = null;

  function createGhost() {
    ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost pane-drag-ghost';
    ghost.textContent = config.label;
    document.body.appendChild(ghost);
  }

  function updateGhost(x: number, y: number) {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y - 12}px`;
  }

  function detectTarget(x: number, y: number): LeafDragTarget {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el === ghost) continue;

      const leafEl = (el as HTMLElement).closest?.('[data-leaf-id]') as HTMLElement | null;
      if (leafEl) {
        const leafId = leafEl.dataset.leafId!;
        // Skip the source leaf — dropping on self is a no-op (treated as empty → pop-out).
        if (leafId === config.leafId) return null;
        const zone = computeLeafZone(x, y, leafEl);
        return { type: 'leaf', leafId, zone };
      }

      const panelEl = (el as HTMLElement).closest?.('[data-panel-id]') as HTMLElement | null;
      if (panelEl) {
        return { type: 'panel', panelId: panelEl.dataset.panelId! };
      }
    }
    return null;
  }

  function highlight(target: LeafDragTarget) {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('drop-target');
      lastHighlighted = null;
    }
    if (!target) {
      ghost?.classList.remove('will-drop');
      dragOverLeafZone.value = null;
      return;
    }
    ghost?.classList.add('will-drop');
    if (target.type === 'panel') {
      dragOverLeafZone.value = null;
      const el = document.querySelector(`[data-panel-id="${target.panelId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else {
      dragOverLeafZone.value = { leafId: target.leafId, zone: target.zone };
      if (target.zone === 'tab') {
        const el = document.querySelector(`[data-leaf-id="${target.leafId}"]`);
        if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
      }
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
      highlight(null);
      return;
    }
    dropTarget = detectTarget(ev.clientX, ev.clientY);
    highlight(dropTarget);
  }

  function onUp(ev: MouseEvent) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (lastHighlighted) lastHighlighted.classList.remove('drop-target');
    if (ghost) { ghost.remove(); ghost = null; }
    dragOverLeafZone.value = null;

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    // External zone: open the whole pane (all tabs + active) in a new browser
    // tab/window via the /panel/<ids> route. closeTab removes from the leaf.
    const externalZone = detectExternalZone(ev.clientX, ev.clientY);
    if (externalZone) {
      const srcLeaf = findLeaf(layoutTree.value.root, config.leafId);
      if (!srcLeaf) return;
      const tabs = [...srcLeaf.tabs];
      if (tabs.length === 0) return;
      openPanelExternally({ sessionIds: tabs, activeId: srcLeaf.activeTabId }, externalZone);
      for (const t of tabs) closeTab(t);
      return;
    }

    if (!dropTarget) {
      popOutLeafAsPanel(config.leafId);
      return;
    }

    if (dropTarget.type === 'leaf') {
      const srcLeaf = findLeaf(layoutTree.value.root, config.leafId);
      if (!srcLeaf) return;
      const tabs = [...srcLeaf.tabs];
      const activeId = srcLeaf.activeTabId;
      if (tabs.length === 0) return;

      const targetLeafId = dropTarget.leafId;
      if (dropTarget.zone === 'tab') {
        // Merge all tabs into the target leaf (source auto-merges when orphaned).
        batchTreeOps(() => {
          for (const t of tabs) addTabToLeaf(targetLeafId, t, t === activeId);
        });
      } else {
        // Split target with all source tabs.
        const direction = dropTarget.zone === 'h-split' ? 'horizontal' : 'vertical';
        batchTreeOps(() => {
          for (let i = 0; i < tabs.length; i++) {
            removeTabFromLeaf(config.leafId, tabs[i], i === tabs.length - 1);
          }
          splitLeaf(targetLeafId, direction, 'second', tabs);
        });
      }
      return;
    }

    if (dropTarget.type === 'panel') {
      const srcLeaf = findLeaf(layoutTree.value.root, config.leafId);
      if (!srcLeaf) return;
      const tabs = [...srcLeaf.tabs];
      const panelId = dropTarget.panelId;
      if (tabs.length === 0) return;
      batchTreeOps(() => {
        for (let i = 0; i < tabs.length; i++) {
          removeTabFromLeaf(config.leafId, tabs[i], i === tabs.length - 1);
        }
      });
      for (const t of tabs) {
        closeTab(t);
        moveSessionToPanel(t, panelId);
      }
      return;
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// --- Panel drag (drag a popout panel via its window-menu handle) ---

export interface PanelDragConfig {
  panelId: string;
  label: string;
  onClickFallback: () => void;
}

export function startPanelDrag(e: MouseEvent, config: PanelDragConfig): void {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;
  let dropTarget: LeafDragTarget = null;
  let lastHighlighted: Element | null = null;

  function createGhost() {
    ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost pane-drag-ghost';
    ghost.textContent = config.label;
    document.body.appendChild(ghost);
  }

  function updateGhost(x: number, y: number) {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y - 12}px`;
  }

  function detectTarget(x: number, y: number): LeafDragTarget {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el === ghost) continue;

      const leafEl = (el as HTMLElement).closest?.('[data-leaf-id]') as HTMLElement | null;
      if (leafEl) {
        const leafId = leafEl.dataset.leafId!;
        const zone = computeLeafZone(x, y, leafEl);
        return { type: 'leaf', leafId, zone };
      }

      const panelEl = (el as HTMLElement).closest?.('[data-panel-id]') as HTMLElement | null;
      if (panelEl) {
        const panelId = panelEl.dataset.panelId!;
        // Skip the source panel — dropping on self is a no-op.
        if (panelId === config.panelId) return null;
        return { type: 'panel', panelId };
      }
    }
    return null;
  }

  function highlight(target: LeafDragTarget) {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('drop-target');
      lastHighlighted = null;
    }
    if (!target) {
      ghost?.classList.remove('will-drop');
      dragOverLeafZone.value = null;
      return;
    }
    ghost?.classList.add('will-drop');
    if (target.type === 'panel') {
      dragOverLeafZone.value = null;
      const el = document.querySelector(`[data-panel-id="${target.panelId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else {
      dragOverLeafZone.value = { leafId: target.leafId, zone: target.zone };
      if (target.zone === 'tab') {
        const el = document.querySelector(`[data-leaf-id="${target.leafId}"]`);
        if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
      }
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
      highlight(null);
      return;
    }
    dropTarget = detectTarget(ev.clientX, ev.clientY);
    highlight(dropTarget);
  }

  function onUp(ev: MouseEvent) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (lastHighlighted) lastHighlighted.classList.remove('drop-target');
    if (ghost) { ghost.remove(); ghost = null; }
    dragOverLeafZone.value = null;

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    // External zone: open panel contents (all tabs + split state) in a new
    // browser tab/window via the /panel/<ids> route.
    const externalZone = detectExternalZone(ev.clientX, ev.clientY);
    if (externalZone) {
      const src = popoutPanels.value.find((p) => p.id === config.panelId);
      if (!src) return;
      const sessionIds = [...src.sessionIds];
      if (sessionIds.length === 0) return;
      openPanelExternally({
        sessionIds,
        activeId: src.activeSessionId,
        rightIds: src.splitEnabled ? src.rightPaneTabs : undefined,
        ratio: src.splitRatio,
      }, externalZone);
      for (const sid of sessionIds) closeTab(sid);
      return;
    }

    // No target → leave the panel where it is (it's already popped out).
    if (!dropTarget) return;

    if (dropTarget.type === 'leaf') {
      if (dropTarget.zone === 'tab') {
        popBackInPanelToLeaf(config.panelId, dropTarget.leafId);
      } else {
        const direction = dropTarget.zone === 'h-split' ? 'horizontal' : 'vertical';
        popBackInPanelToLeafWithSplit(config.panelId, dropTarget.leafId, direction);
      }
      return;
    }

    if (dropTarget.type === 'panel') {
      // Merge all sessions from the source panel into the target panel.
      const src = popoutPanels.value.find((p) => p.id === config.panelId);
      if (!src) return;
      const sessionIds = [...src.sessionIds];
      for (const sid of sessionIds) {
        moveSessionToPanel(sid, dropTarget.panelId);
      }
      persistPopoutState();
      return;
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
