import { signal, effect } from '@preact/signals';
import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

const MOBILE_QUERY = '(max-width: 768px)';

// Narrow-container detection: the JSONL view is embedded in split panes,
// popout drawers, and grid tiles where the window is wide but the pane
// itself is tiny. `isMobile` only fires at window ≤768px, so the existing
// mobile collapse logic never triggered in those contexts. Descendants read
// this via `useNarrow()` and combine it with `isMobile` when deciding
// thresholds; the provider is set by the scroll container using
// `useContainerNarrow(ref)`.
export const NarrowContext = createContext(false);

export function useNarrow(): boolean {
  return useContext(NarrowContext);
}

export function useContainerNarrow<T extends HTMLElement>(
  ref: RefObject<T>,
  threshold = 560,
): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) setNarrow(w < threshold);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, threshold]);
  return narrow;
}

const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(MOBILE_QUERY)
  : null;

export const isMobile = signal(mq ? mq.matches : false);

if (mq) {
  const onChange = (e: MediaQueryListEvent) => { isMobile.value = e.matches; };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
  } else if (typeof (mq as any).addListener === 'function') {
    (mq as any).addListener(onChange);
  }
}

effect(() => {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('pw-mobile', isMobile.value);
});

// iOS Safari keyboard handling: the on-screen keyboard shrinks the *visual*
// viewport but leaves the layout viewport unchanged, so `position: fixed;
// bottom: N` elements (like the CoS popout) get covered by the keyboard.
// Track visualViewport and expose the keyboard height as --pw-keyboard-inset
// so docked panels can lift above the keyboard when an input is focused.
//
// We only publish the inset when a form element is focused — without that
// guard, pinch-zoom or URL-bar retraction also shrinks visualViewport.height
// and the false-positive inset squeezes the CoS popout to near-zero height.
if (typeof window !== 'undefined' && window.visualViewport && typeof document !== 'undefined') {
  const vv = window.visualViewport;
  const isFormFocused = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  };
  const update = () => {
    const raw = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // Require (a) a focused form element and (b) at least 80px of inset so
    // small rendering jitters don't flip the layout.
    const inset = isFormFocused() && raw >= 80 ? raw : 0;
    document.documentElement.style.setProperty('--pw-keyboard-inset', `${Math.round(inset)}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  update();
}
