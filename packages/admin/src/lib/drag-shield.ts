/**
 * Transparent full-viewport overlay installed for the duration of a mouse
 * drag (pane dividers, panel resizers).
 *
 * Without it, the moment the pointer crosses into an <iframe> (companion
 * pages, isolate tabs) the iframe's own document swallows mousemove/mouseup —
 * the parent's document listeners stop firing, so the divider freezes and the
 * drag never ends. The shield sits above every iframe, so all pointer events
 * stay in this document and still bubble to the document-level listeners.
 *
 * Returns a disposer; call it from the drag's mouseup handler.
 */
export function beginDragShield(cursor: string): () => void {
  const el = document.createElement('div');
  el.className = 'drag-shield';
  el.style.cursor = cursor;
  document.body.appendChild(el);
  document.body.classList.add('drag-shield-active');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    el.remove();
    document.body.classList.remove('drag-shield-active');
  };
}

/** Map a resize-handle edge name ('n', 'se', …) to its CSS cursor. */
export function edgeCursor(edge: string): string {
  const e = edge.toLowerCase();
  if (e === 'n' || e === 's') return 'ns-resize';
  if (e === 'e' || e === 'w') return 'ew-resize';
  if (e === 'ne' || e === 'sw') return 'nesw-resize';
  if (e === 'nw' || e === 'se') return 'nwse-resize';
  return 'default';
}
