import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'preact/hooks';
import { api } from '../../lib/api.js';
import { openSession, loadAllSessions } from '../../lib/sessions.js';

interface FlatterAssistButtonProps {
  appId: string;
  appLabel: string;
}

const PRESETS: { label: string; request: string }[] = [
  { label: 'Monitor an upstream repo', request: 'Help me set up a Flatter monitor for an upstream git repository. Ask me for the repo URL if you need it, pick sensible focus keywords for this app, create the monitor, and run the first scan.' },
  { label: 'Examine a live web app', request: 'I want to pull features from a live web application. Use the shared Playwright browser to explore it screen by screen, identify features worth emulating in this app, and post them as Flatter findings for triage. Ask me for the target URL if I have not given one.' },
  { label: 'Emulate a downloaded app', request: 'I have a downloaded/local application whose functionality I want to emulate. Set up a local-source Flatter monitor, launch the app with computer-use tooling (visible browser / DISPLAY=:1), examine its features, and post findings for triage.' },
  { label: 'Tune focus & rescan', request: 'Review my existing Flatter monitors and their include/exclude keywords, tune them so scans surface the most relevant changes for this app, then rescan.' },
];

export function FlatterAssistButton({ appId, appLabel }: FlatterAssistButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <span class="ai-assist-wrapper">
      <button
        ref={btnRef}
        class="ai-assist-btn"
        onClick={() => setOpen(!open)}
        title="Flatter Assist"
      >
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
        </svg>
      </button>
      {open && (
        <FlatterAssistPopover
          appId={appId}
          appLabel={appLabel}
          onClose={() => setOpen(false)}
          triggerRef={btnRef}
        />
      )}
    </span>
  );
}

function clampToViewport(x: number, y: number, w: number, h: number) {
  const pad = 8;
  return {
    x: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
    y: Math.max(pad, Math.min(y, window.innerHeight - h - pad)),
  };
}

function FlatterAssistPopover({ appId, appLabel, onClose, triggerRef }: FlatterAssistButtonProps & { onClose: () => void; triggerRef: preact.RefObject<HTMLElement> }) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  // Position near trigger, clamped to viewport
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const pw = 340;
    const ph = el.offsetHeight || 260;
    let x = trigger.left + trigger.width / 2 - pw / 2;
    let y = trigger.top - ph - 8;
    if (y < 8) y = trigger.bottom + 8;
    const clamped = clampToViewport(x, y, pw, ph);
    el.style.left = `${clamped.x}px`;
    el.style.top = `${clamped.y}px`;
    el.style.visibility = 'visible';
  }, [triggerRef]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Drag on header
  const onDragStart = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragging.current = true;
    const el = panelRef.current!;
    dragStart.current = { mx: e.clientX, my: e.clientY, px: el.offsetLeft, py: el.offsetTop };

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - dragStart.current.mx;
      const dy = ev.clientY - dragStart.current.my;
      el.style.left = `${dragStart.current.px + dx}px`;
      el.style.top = `${dragStart.current.py + dy}px`;
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const btn = (e.target as HTMLElement).closest?.('.ai-assist-btn');
        if (btn) return;
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    // Capture phase so Escape closes the popover before pane-level handlers swallow it.
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  function submit(requestText?: string) {
    const finalText = requestText || text.trim();
    if (!finalText || submitting) return;
    onClose();
    // Fire-and-forget: close popover immediately, open session tab when ready
    (async () => {
      try {
        const { sessionId } = await api.flatterAssist(appId, { request: finalText });
        await loadAllSessions();
        openSession(sessionId);
      } catch (err: any) {
        console.error('Flatter Assist failed:', err.message);
      }
    })();
  }

  return (
    <div
      class="ai-assist-popover"
      ref={panelRef}
      style="visibility:hidden"
    >
      <div class="ai-assist-header" onMouseDown={onDragStart}>
        <span style="font-weight:600;font-size:13px">Flatter Assist</span>
        <span style="font-size:11px;color:var(--pw-text-muted)">{appLabel}</span>
        <button
          class="ai-assist-close"
          title="Close"
          aria-label="Close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >{'✕'}</button>
      </div>
      <div class="ai-assist-body">
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              class="btn btn-sm"
              style="font-size:11px;padding:2px 8px"
              disabled={submitting}
              onClick={() => submit(p.request)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div class="ai-assist-body" style="padding-top:0">
        <textarea
          ref={textareaRef}
          class="request-panel-textarea"
          placeholder="How should Flatter pull in features from other apps? e.g. “watch github.com/org/repo for editor features” or “examine https://app.example.com and emulate its command palette”"
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
        />
      </div>
      <div class="ai-assist-footer">
        <button
          class="btn btn-sm btn-primary"
          disabled={!text.trim() || submitting}
          onClick={() => submit()}
        >
          {submitting ? 'Sending...' : 'Go'}
        </button>
        <span class="request-panel-hint">{'⌘'}+Enter</span>
      </div>
    </div>
  );
}
