import { useRef, useState, useEffect, useCallback } from 'preact/hooks';

const NEAR_BOTTOM_THRESHOLD = 24;

interface ScrollAnchorOptions {
  /** Reset anchor state when this key changes (e.g. active session ID). */
  resetKey?: string | null;
  /** Dependency array whose length changes trigger auto-scroll. */
  contentDeps?: number[];
  /** Whether the scroll container is currently visible/mounted. Default true. */
  visible?: boolean;
}

interface ScrollAnchorResult {
  /** Callback ref — pass to the scrollable container's `ref`. */
  setRef: (el: HTMLDivElement | null) => void;
  /** Whether the user has scrolled away from the bottom. */
  showScrollDown: boolean;
  /** Scroll programmatically to the bottom. */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * Shared scroll-anchor hook for chat panels.
 *
 * Tracks whether the user is pinned to the bottom of a scrollable container.
 * When pinned, new content auto-scrolls into view. When scrolled away,
 * `showScrollDown` flips to true so the UI can render a floating button.
 */
export function useScrollAnchor(opts: ScrollAnchorOptions = {}): ScrollAnchorResult {
  const { resetKey, contentDeps = [], visible = true } = opts;

  const elRef = useRef<HTMLDivElement | null>(null);
  const [el, setElState] = useState<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const setRef = useCallback((node: HTMLDivElement | null) => {
    elRef.current = node;
    setElState(node);
  }, []);

  function isAtBottom(e: HTMLElement | null): boolean {
    if (!e) return true;
    return e.scrollHeight - e.scrollTop - e.clientHeight < NEAR_BOTTOM_THRESHOLD;
  }

  function scrollToBottom(behavior: ScrollBehavior = 'auto') {
    const e = elRef.current;
    if (e) e.scrollTo({ top: e.scrollHeight, behavior });
  }

  // Reset state when the key changes (new session / new agent).
  useEffect(() => {
    wasAtBottomRef.current = true;
    lastScrollTopRef.current = 0;
    setShowScrollDown(false);
  }, [resetKey]);

  // Auto-scroll on mount / content change while pinned. Also restores
  // prior scrollTop when the DOM element remounts (popout tree splits).
  useEffect(() => {
    if (!visible || !el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollDown(false);
    } else if (lastScrollTopRef.current > 0 && el.scrollTop === 0) {
      el.scrollTop = lastScrollTopRef.current;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, el, ...contentDeps]);

  // Scroll listener — track pinned state + toggle button visibility.
  useEffect(() => {
    if (!visible || !el) return;
    const onScroll = () => {
      const atBottom = isAtBottom(el);
      wasAtBottomRef.current = atBottom;
      lastScrollTopRef.current = el.scrollTop;
      setShowScrollDown(!atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [visible, resetKey, el]);

  return { setRef, showScrollDown, scrollToBottom };
}
