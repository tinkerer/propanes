// Viewport placement for a fixed-position submenu that flies out beside a
// menu row (e.g. "Review PRs ›" in the sidebar session menu). Pure so the
// clamping rules can be unit-tested without a DOM.

export interface SubmenuAnchor {
  // Bounding rect of the row the submenu hangs off (viewport coordinates).
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SubmenuPlacement {
  left: number;
  top: number;
  // Hard cap so a long list scrolls inside the submenu instead of running
  // off the bottom of the window.
  maxHeight: number;
}

export const SUBMENU_VIEWPORT_MARGIN = 8;

export function placeSubmenu(
  anchor: SubmenuAnchor,
  viewport: { width: number; height: number },
  estimatedHeight: number,
  estimatedWidth = 180,
): SubmenuPlacement {
  const margin = SUBMENU_VIEWPORT_MARGIN;
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const height = Math.min(estimatedHeight, maxHeight);

  // Open to the right of the row; flip to the left edge of the row when the
  // right side would run off-screen.
  let left = anchor.right;
  if (left + estimatedWidth > viewport.width - margin) {
    left = Math.max(margin, anchor.left - estimatedWidth);
  }

  // Align the first item with the row; slide up just enough to keep the
  // submenu inside the viewport, never above the top margin.
  let top = anchor.top;
  if (top + height > viewport.height - margin) {
    top = Math.max(margin, viewport.height - margin - height);
  }

  return { left, top, maxHeight };
}
