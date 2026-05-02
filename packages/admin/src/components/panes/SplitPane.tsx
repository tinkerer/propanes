import { useRef, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { SplitDirection } from '../../lib/pane-tree.js';

interface SplitPaneProps {
  direction: SplitDirection;
  ratio: number;
  splitId: string;
  onRatioChange: (splitId: string, ratio: number, containerSizePx?: number) => void;
  first: ComponentChildren;
  second: ComponentChildren;
  hideSecond?: boolean;
  fixedFirstSize?: number; // if set, first child uses fixed px instead of flex ratio
  onFixedResize?: (newSize: number) => void; // called when dragging divider with fixedFirstSize
  firstCollapsed?: boolean;
  secondCollapsed?: boolean;
  /**
   * If set, the divider sprouts a popout-grab-tab handle. Clicking it (without
   * dragging) calls this callback — used to toggle the secondary pane closed.
   */
  onDividerClick?: () => void;
  /** Optional icon shown inside the divider grab tab (defaults to "┃"). */
  dividerGrabIcon?: string;
}

export function SplitPane({ direction, ratio, splitId, onRatioChange, first, second, hideSecond, fixedFirstSize, onFixedResize, firstCollapsed, secondCollapsed, onDividerClick, dividerGrabIcon }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, t: 0, moved: false });

  const onDividerMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
    const container = containerRef.current;
    if (!container) return;

    container.classList.add('pane-dragging');

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !container) return;
      if (!dragStart.current.moved) {
        const dx = Math.abs(ev.clientX - dragStart.current.x);
        const dy = Math.abs(ev.clientY - dragStart.current.y);
        if (dx > 3 || dy > 3) dragStart.current.moved = true;
      }
      const rect = container.getBoundingClientRect();
      if (fixedFirstSize != null && onFixedResize) {
        const newSize = direction === 'horizontal'
          ? ev.clientX - rect.left
          : ev.clientY - rect.top;
        onFixedResize(Math.max(100, Math.min(newSize, (direction === 'horizontal' ? rect.width : rect.height) - 100)));
      } else {
        const containerSize = direction === 'horizontal' ? rect.width : rect.height;
        const newRatio = direction === 'horizontal'
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        onRatioChange(splitId, newRatio, containerSize);
      }
    };

    const onUp = () => {
      dragging.current = false;
      container.classList.remove('pane-dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Click without drag → toggle callback
      if (onDividerClick && !dragStart.current.moved && Date.now() - dragStart.current.t < 350) {
        onDividerClick();
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [direction, splitId, onRatioChange, fixedFirstSize, onFixedResize, onDividerClick]);

  const isHorizontal = direction === 'horizontal';
  const effectiveRatio = hideSecond ? 1 : ratio;
  const dividerEnabled = fixedFirstSize != null ? !!onFixedResize : true;

  const collapsedStyle = { flex: '0 0 auto' as any, minWidth: 0, minHeight: 0, overflow: 'hidden' as const };
  const firstStyle = firstCollapsed
    ? collapsedStyle
    : fixedFirstSize != null
      ? { width: `${fixedFirstSize}px`, flexShrink: 0, minHeight: 0, overflow: 'hidden' as const }
      : { flex: secondCollapsed ? 1 : effectiveRatio, minWidth: 0, minHeight: 0, overflow: 'hidden' as const };
  const secondStyle = secondCollapsed
    ? collapsedStyle
    : { flex: firstCollapsed ? 1 : (fixedFirstSize != null ? 1 : (1 - effectiveRatio)), minWidth: 0, minHeight: 0, overflow: 'hidden' as const };

  const hasGrab = !!onDividerClick;
  const dividerClass = `pane-split-divider pane-split-divider-${direction}${hasGrab ? ' pane-split-divider-with-grab' : ''}`;

  return (
    <div
      ref={containerRef}
      class={`pane-split pane-split-${direction}`}
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div class="pane-split-child" style={firstStyle}>
        {first}
      </div>
      {!hideSecond && (
        <>
          <div
            class={dividerClass}
            onMouseDown={dividerEnabled ? onDividerMouseDown : undefined}
            style={!dividerEnabled ? { cursor: 'default' } : undefined}
          >
            {hasGrab && (
              <div
                class={`pane-split-divider-grab pane-split-divider-grab-${direction}`}
                title="Click to toggle, drag to resize"
              >
                <span class="grab-indicator">{dividerGrabIcon || '┃'}</span>
              </div>
            )}
          </div>
          <div class="pane-split-child" style={secondStyle}>
            {second}
          </div>
        </>
      )}
    </div>
  );
}
