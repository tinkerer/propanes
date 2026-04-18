import { useState, useEffect, useRef } from 'preact/hooks';
import { currentRoute } from '../lib/state.js';
import { getHintsForRoute, dismissHint, hintsEnabled, type Hint } from '../lib/hints.js';
import { navigate } from '../lib/state.js';

export function HintToast() {
  const [hint, setHint] = useState<Hint | null>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRouteRef = useRef('');
  const highlightRef = useRef<HTMLElement | null>(null);

  const route = currentRoute.value;
  const enabled = hintsEnabled.value;

  useEffect(() => {
    if (!enabled) {
      setHint(null);
      setVisible(false);
      return;
    }

    if (route === lastRouteRef.current) return;
    lastRouteRef.current = route;

    setHint(null);
    setVisible(false);
    setExiting(false);

    timerRef.current = setTimeout(() => {
      const hints = getHintsForRoute(route);
      if (hints.length > 0) {
        setHint(hints[0]);
        setVisible(true);
      }
    }, 1200);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [route, enabled]);

  useEffect(() => {
    if (!hint?.highlightSelector || !visible) return;
    const el = document.querySelector(hint.highlightSelector) as HTMLElement | null;
    if (el) {
      el.classList.add('hint-highlight-pulse');
      highlightRef.current = el;
    }
    return () => {
      if (highlightRef.current) {
        highlightRef.current.classList.remove('hint-highlight-pulse');
        highlightRef.current = null;
      }
    };
  }, [hint, visible]);

  function close() {
    if (highlightRef.current) {
      highlightRef.current.classList.remove('hint-highlight-pulse');
      highlightRef.current = null;
    }
    setExiting(true);
    setTimeout(() => {
      if (hint) dismissHint(hint.id);
      setHint(null);
      setVisible(false);
      setExiting(false);
    }, 200);
  }

  function disableAll() {
    if (hint) dismissHint(hint.id);
    hintsEnabled.value = false;
    setHint(null);
    setVisible(false);
    setExiting(false);
    if (highlightRef.current) {
      highlightRef.current.classList.remove('hint-highlight-pulse');
      highlightRef.current = null;
    }
  }

  function openGuide() {
    if (hint?.guideLink) {
      navigate('/settings/user-guide');
    }
    close();
  }

  if (!hint || !visible) return null;

  return (
    <div class={`hint-toast ${exiting ? 'hint-toast-exit' : 'hint-toast-enter'}`}>
      <div class="hint-toast-header">
        <span class="hint-toast-icon">{'\u{1F4A1}'}</span>
        <span class="hint-toast-title">{hint.title}</span>
        <button class="hint-toast-close" onClick={close} title="Dismiss">&times;</button>
      </div>
      <div class="hint-toast-body">{hint.body}</div>
      <div class="hint-toast-footer">
        {hint.guideLink && (
          <button class="hint-toast-link" onClick={openGuide}>User Guide</button>
        )}
        <div class="hint-toast-actions">
          <button class="hint-toast-mute" onClick={disableAll}>Don't show hints</button>
          <button class="hint-toast-dismiss" onClick={close}>Got it</button>
        </div>
      </div>
    </div>
  );
}
