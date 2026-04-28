// Eight-direction resize border for a popout panel. Docked panels only
// expose three edges (the docked side has no handle); floating panels expose
// all eight corners + edges.

export function PopoutResizeHandles({
  docked,
  isLeftDocked,
  onResizeStart,
}: {
  docked: boolean;
  isLeftDocked: boolean;
  onResizeStart: (edge: string, e: MouseEvent) => void;
}) {
  if (docked) {
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
