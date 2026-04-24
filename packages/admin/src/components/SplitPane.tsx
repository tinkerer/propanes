import { useRef, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { SplitDirection } from '../lib/pane-tree.js';

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
}

export function SplitPane({ direction, ratio, splitId, onRatioChange, first, second, hideSecond, fixedFirstSize, onFixedResize, firstCollapsed, secondCollapsed }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onDividerMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const container = containerRef.current;
    if (!container) return;

    container.classList.add('pane-dragging');

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !container) return;
      const rect = container.getBoundingClientRect();
      if (fixedFirstSize != null && onFixedResize) {
        // Fixed-size mode: compute pixel size
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
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [direction, splitId, onRatioChange, fixedFirstSize, onFixedResize]);

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
            class={`pane-split-divider pane-split-divider-${direction}`}
            onMouseDown={dividerEnabled ? onDividerMouseDown : undefined}
            style={!dividerEnabled ? { cursor: 'default' } : undefined}
          />
          <div class="pane-split-child" style={secondStyle}>
            {second}
          </div>
        </>
      )}
    </div>
  );
}
