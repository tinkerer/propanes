import { useRef, useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';

interface PopupMenuProps {
  /** Ref to the element the menu should anchor to */
  anchorRef: { current: HTMLElement | null };
  /** Called when the menu should close (click outside, Escape) */
  onClose: () => void;
  children: ComponentChildren;
  /** Horizontal alignment relative to anchor */
  align?: 'left' | 'right';
  /** Extra CSS class for the menu container */
  className?: string;
}

/**
 * Portal-based popup menu that renders at document.body level.
 * Escapes any overflow:hidden or stacking-context traps.
 *
 * Usage:
 *   const btnRef = useRef<HTMLButtonElement>(null);
 *   {open && (
 *     <PopupMenu anchorRef={btnRef} onClose={() => setOpen(false)}>
 *       <button class="popup-menu-item" onClick={...}>Item</button>
 *     </PopupMenu>
 *   )}
 */
export function PopupMenu({ anchorRef, onClose, children, align = 'left', className }: PopupMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Track whether we've done the initial right-align adjustment
  const [aligned, setAligned] = useState(false);

  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setAligned(false);
    setPos({
      top: rect.bottom + 4,
      left: align === 'right' ? rect.right : rect.left,
    });
  }, [align]);

  // Reposition if window resizes
  useEffect(() => {
    function reposition() {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      setAligned(false);
      setPos({
        top: rect.bottom + 4,
        left: align === 'right' ? rect.right : rect.left,
      });
    }
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [align]);

  // Clamp to viewport after the menu renders and we know its size
  useLayoutEffect(() => {
    if (!menuRef.current || !pos) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    let { top, left } = pos;

    // For right-align, shift left so the menu's right edge aligns with anchor's right edge
    if (align === 'right' && !aligned) {
      left = pos.left - rect.width;
      setAligned(true);
    }

    // Clamp to viewport
    if (left + rect.width > window.innerWidth) {
      left = Math.max(4, window.innerWidth - rect.width - 4);
    }
    if (left < 4) left = 4;
    if (rect.bottom > window.innerHeight) {
      if (anchorRef.current) {
        const anchorRect = anchorRef.current.getBoundingClientRect();
        top = anchorRect.top - rect.height - 4;
      }
    }
    if (top !== pos.top || left !== pos.left) {
      setPos({ top, left });
    }
  }, [pos, aligned]);

  // Click outside to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      class={`popup-menu ${className || ''}`}
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
    >
      {children}
    </div>,
    document.body,
  );
}
