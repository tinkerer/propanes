/**
 * Eight-direction resize handles for the popout window. Docked panels expose
 * a different subset (the docked edge sticks to the viewport, so its
 * perpendicular handles are dropped). Non-docked floating panels get the
 * full set.
 */
export function CosResizeHandles({
  isDocked,
  isLeftDocked,
  onResizeStart,
}: {
  isDocked: boolean;
  isLeftDocked: boolean;
  onResizeStart: (
    edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw',
    e: MouseEvent,
  ) => void;
}) {
  if (isDocked) {
    return (
      <>
        <div class="popout-resize-n" onMouseDown={(e) => onResizeStart('n', e)} />
        <div class="popout-resize-s" onMouseDown={(e) => onResizeStart('s', e)} />
        {isLeftDocked ? (
          <>
            <div class="popout-resize-e" onMouseDown={(e) => onResizeStart('e', e)} />
            <div class="popout-resize-ne" onMouseDown={(e) => onResizeStart('ne', e)} />
            <div class="popout-resize-se" onMouseDown={(e) => onResizeStart('se', e)} />
          </>
        ) : (
          <>
            <div class="popout-resize-w" onMouseDown={(e) => onResizeStart('w', e)} />
            <div class="popout-resize-nw" onMouseDown={(e) => onResizeStart('nw', e)} />
            <div class="popout-resize-sw" onMouseDown={(e) => onResizeStart('sw', e)} />
          </>
        )}
      </>
    );
  }
  return (
    <>
      <div class="popout-resize-n" onMouseDown={(e) => onResizeStart('n', e)} />
      <div class="popout-resize-s" onMouseDown={(e) => onResizeStart('s', e)} />
      <div class="popout-resize-e" onMouseDown={(e) => onResizeStart('e', e)} />
      <div class="popout-resize-w" onMouseDown={(e) => onResizeStart('w', e)} />
      <div class="popout-resize-ne" onMouseDown={(e) => onResizeStart('ne', e)} />
      <div class="popout-resize-nw" onMouseDown={(e) => onResizeStart('nw', e)} />
      <div class="popout-resize-se" onMouseDown={(e) => onResizeStart('se', e)} />
      <div class="popout-resize-sw" onMouseDown={(e) => onResizeStart('sw', e)} />
    </>
  );
}
