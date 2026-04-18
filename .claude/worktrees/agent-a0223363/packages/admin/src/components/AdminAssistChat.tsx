import { useState, useRef, useEffect } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession, loadAllSessions, panelHeight, sidebarWidth, sidebarCollapsed, sidebarAnimating } from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';

const PRESETS = [
  { label: 'Feedback summary', prompt: 'Show a summary of recent feedback' },
  { label: 'System status', prompt: 'Check the current system status' },
  { label: 'Recent errors', prompt: 'Show recent errors from agent sessions' },
];

export function AdminAssistChat() {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const height = panelHeight.value;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function submit(request?: string) {
    const msg = (request || text).trim();
    if (!msg || submitting) return;
    setSubmitting(true);
    try {
      const appId = selectedAppId.value;
      if (!appId) {
        console.error('Admin Assist: no app selected');
        setSubmitting(false);
        return;
      }
      const { sessionId } = await api.designAssist(appId, {
        request: msg,
        context: 'admin-panel',
      });
      openSession(sessionId);
      loadAllSessions();
    } catch (err: any) {
      console.error('Admin Assist failed:', err.message);
    }
    setSubmitting(false);
  }

  return (
    <div
      class={`global-terminal-panel admin-assist-panel${sidebarAnimating.value ? ' animating' : ''}`}
      style={{ height: `${height}px`, left: `${sidebarWidth.value + (sidebarCollapsed.value ? 0 : 3)}px` }}
    >
      <div class="admin-assist-chat">
        <div class="admin-assist-chat-inner">
          <div class="admin-assist-title">Admin Assist</div>
          <textarea
            ref={textareaRef}
            class="request-panel-textarea"
            placeholder="Ask admin assist..."
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
          <div class="admin-assist-chat-actions">
            <button
              class="btn btn-sm btn-primary"
              disabled={!text.trim() || submitting}
              onClick={() => submit()}
            >
              {submitting ? 'Sending...' : 'Go'}
            </button>
            <span class="request-panel-hint">{'\u2318'}+Enter</span>
          </div>
          <div class="admin-assist-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                class="btn btn-sm"
                disabled={submitting}
                onClick={() => submit(p.prompt)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
