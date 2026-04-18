import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession, loadAllSessions } from '../lib/sessions.js';

interface AiAssistButtonProps {
  context: string;
  appId: string;
  settingPath?: string;
}

export function AiAssistButton({ context, appId, settingPath }: AiAssistButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <span class="ai-assist-wrapper">
      <button
        ref={btnRef}
        class="ai-assist-btn"
        onClick={() => setOpen(!open)}
        title="AI Assist"
      >
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/>
        </svg>
      </button>
      {open && (
        <AiAssistPopover
          context={context}
          appId={appId}
          settingPath={settingPath}
          onClose={() => setOpen(false)}
          triggerRef={btnRef}
        />
      )}
    </span>
  );
}

function AiAssistPopover({ context, appId, settingPath, onClose, triggerRef }: AiAssistButtonProps & { onClose: () => void; triggerRef: preact.RefObject<HTMLElement> }) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    function updatePos() {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
    }
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [triggerRef]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const btn = (e.target as HTMLElement).closest?.('.ai-assist-btn');
        if (btn) return;
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  async function submit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { sessionId } = await api.designAssist(appId, {
        request: text.trim(),
        context,
        settingPath,
      });
      openSession(sessionId);
      loadAllSessions();
      onClose();
    } catch (err: any) {
      console.error('AI Assist failed:', err.message);
    }
    setSubmitting(false);
  }

  return (
    <div
      class="ai-assist-popover"
      ref={panelRef}
      style={pos ? `position:fixed;bottom:auto;left:auto;top:${pos.top}px;left:${pos.left}px;transform:translateX(-50%) translateY(-100%)` : undefined}
    >
      <div class="ai-assist-header">
        <span style="font-weight:600;font-size:13px">AI Assist</span>
        <span style="font-size:11px;color:var(--pw-text-muted)">{context}</span>
      </div>
      <textarea
        ref={textareaRef}
        class="request-panel-textarea"
        placeholder="What would you like to change?"
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
      <div class="ai-assist-footer">
        <button
          class="btn btn-sm btn-primary"
          disabled={!text.trim() || submitting}
          onClick={submit}
        >
          {submitting ? 'Sending...' : 'Go'}
        </button>
        <span class="request-panel-hint">{'\u2318'}+Enter</span>
      </div>
    </div>
  );
}
