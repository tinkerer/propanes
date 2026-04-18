import {
  openTabs,
  popOutTab,
  popBackIn,
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
  closeTab,
} from './sessions.js';
import {
  findLeafWithTab,
  moveTab,
  removeTabFromLeaf,
  addTabToLeaf,
  reorderTabInLeaf,
} from './pane-tree.js';

export type TabDragSource = 'main' | 'split-left' | 'split-right' | { panelId: string } | { type: 'leaf'; leafId: string };

export interface TabDragConfig {
  sessionId: string;
  source: TabDragSource;
  label: string;
  onClickFallback: () => void;
}

const DRAG_THRESHOLD = 6;

function sourceIsLeaf(source: TabDragSource): string | null {
  if (typeof source === 'object' && 'type' in source && source.type === 'leaf') return source.leafId;
  return null;
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
  let dropTarget: { type: 'panel'; panelId: string } | { type: 'main' } | { type: 'split-left' } | { type: 'split-right' } | { type: 'popout-split'; panelId: string; pane: 'left' | 'right' } | { type: 'leaf'; leafId: string } | null = null;
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
        if (srcLeafId && srcLeafId === leafId) continue; // same leaf — skip for drop target (reorder handled separately)
        return { type: 'leaf', leafId };
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
      return;
    }
    ghost?.classList.add('will-drop');
    if (target.type === 'popout-split') {
      const el = document.querySelector(`[data-popout-split-pane="${target.panelId}:${target.pane}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else if (target.type === 'panel') {
      const el = document.querySelector(`[data-panel-id="${target.panelId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else if (target.type === 'leaf') {
      const el = document.querySelector(`[data-leaf-id="${target.leafId}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else if (target.type === 'split-left' || target.type === 'split-right') {
      const el = document.querySelector(`[data-split-pane="${target.type}"]`);
      if (el) { el.classList.add('drop-target'); lastHighlighted = el; }
    } else {
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

      // Check leaf pane tab bars (same leaf only)
      if (srcLeafId) {
        const leafEl = (el as HTMLElement).closest?.(`[data-leaf-id="${srcLeafId}"]`) as HTMLElement | null;
        if (leafEl) {
          const tb = leafEl.querySelector('.pane-leaf-tabs') as HTMLElement | null;
          if (tb) { tabBar = tb; isSamePanel = true; break; }
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

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      dragging = true;
      createGhost();
    }
    if (!dragging) return;
    updateGhost(ev.clientX, ev.clientY);
    dropTarget = detectDropTarget(ev.clientX, ev.clientY);
    highlightTarget(dropTarget);
    updateReorderIndicator(ev.clientX, ev.clientY);
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (lastHighlighted) lastHighlighted.classList.remove('drop-target');
    sourceTab?.classList.remove('tab-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    const hadReorderIndicator = !!reorderIndicator;
    removeReorderIndicator();

    if (!dragging) {
      config.onClickFallback();
      return;
    }

    const srcLeafId = sourceIsLeaf(config.source);
    const srcPanelId = sourceIsPanelId();

    // Leaf pane source
    if (srcLeafId) {
      // Same-leaf reorder
      if (hadReorderIndicator && reorderInsertBefore !== config.sessionId) {
        reorderTabInLeaf(srcLeafId, config.sessionId, reorderInsertBefore);
        return;
      }
      // Drop onto another leaf
      if (dropTarget?.type === 'leaf') {
        moveTab(srcLeafId, dropTarget.leafId, config.sessionId);
        return;
      }
      // Drop onto a popout panel
      if (dropTarget?.type === 'panel') {
        // Remove from tree leaf, add to popout panel
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
        // Move tab to the global openTabs
        removeTabFromLeaf(srcLeafId, config.sessionId);
        return;
      }
      // Drop into empty space — pop out to floating panel
      if (!dropTarget && !hadReorderIndicator) {
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
        // Drop from global panel into a leaf pane
        closeTab(config.sessionId);
        addTabToLeaf(dropTarget.leafId, config.sessionId, true);
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
        closeTab(config.sessionId);
        addTabToLeaf(dropTarget.leafId, config.sessionId, true);
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
        // Drop from popout panel into a leaf pane
        // Remove from panel first, then add to leaf
        const panel = findPanelForSession(config.sessionId);
        if (panel) {
          splitFromPanel(config.sessionId);
        }
        addTabToLeaf(dropTarget.leafId, config.sessionId, true);
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
