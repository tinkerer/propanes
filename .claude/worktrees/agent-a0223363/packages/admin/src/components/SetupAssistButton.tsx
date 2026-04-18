import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openSession, loadAllSessions } from '../lib/sessions.js';

interface SetupAssistButtonProps {
  entityType: 'machine' | 'harness' | 'agent' | 'sprite';
  entityId?: string;
  entityLabel: string;
}

const PRESETS: Record<string, { label: string; request: string }[]> = {
  machine: [
    { label: 'Full machine setup', request: 'Run the full machine provisioning flow: verify SSH, install prerequisites, deploy the launcher daemon, launch a terminal to verify it works, install Claude CLI if missing, run hardware investigation, and tag this machine with its specs.' },
    { label: 'Deploy launcher daemon', request: 'Deploy the launcher daemon to this machine: build the bundle, SCP it over, install node-pty, start the daemon, and verify it connects to the server.' },
    { label: 'Investigate & tag', request: 'Investigate this machine\'s hardware (CPU, RAM, GPUs, PCIe devices, disks, OS) using Claude CLI on the remote machine, then tag the machine with the discovered specs.' },
  ],
  harness: [
    { label: 'Verify Docker setup', request: 'Verify Docker is available on the assigned machine and check if the configured app image exists. Report any issues.' },
    { label: 'Help configure ports & image', request: 'Help me configure the Docker image, ports, and target app URL for this harness. Check for port conflicts on the machine.' },
    { label: 'Setup Claude auth', request: 'Help me configure Claude authentication for this harness. Check if ~/.claude exists on the remote machine, verify credentials, and set the claudeHomePath and anthropicApiKey fields.' },
    { label: 'Check launcher health', request: 'Check the health of the launcher connected to this harness machine. Report uptime, installed tools (Docker, tmux, Claude CLI), system resources, and any issues.' },
  ],
  agent: [
    { label: 'Help me configure an agent', request: 'Walk me through setting up a new agent endpoint. Help me decide between interactive, headless, and webhook modes, and configure the right permission level for my use case.' },
    { label: 'Set up auto-dispatch', request: 'Help me configure an agent for automatic feedback dispatch. Set up appropriate permissions, allowed tools, and prompt template.' },
  ],
  sprite: [
    { label: 'Check status & health', request: 'Check the status and health of this sprite. Verify it\'s running, check resource usage, and report any issues.' },
    { label: 'Configure workspace', request: 'Help me configure the default working directory, install tools, and set up the development environment on this sprite.' },
    { label: 'Launch a session', request: 'Launch an interactive Claude session on this sprite and help me get started with development.' },
  ],
};

const NEW_ENTITY_PRESETS: Record<string, { label: string; request: string }[]> = {
  machine: [
    { label: 'Full machine provisioning', request: 'Walk me through adding a new remote machine with the full provisioning flow: create the machine entry, verify SSH, deploy the launcher daemon, launch a terminal to verify it works, install Claude CLI if missing, run hardware investigation, and tag it with specs. Get the machine fully online.' },
    { label: 'Add & setup remote machine', request: 'Help me add a new remote machine. Walk me through the hostname, address, and type fields, then run the full setup: verify SSH, install prerequisites, deploy the launcher daemon and get it connected, install Claude CLI, investigate hardware, and tag it. Get it fully online and ready to use.' },
    { label: 'Add local machine', request: 'Help me register the local machine for running harnesses and agent sessions locally.' },
  ],
  harness: [
    { label: 'Create a Docker harness', request: 'Help me create a new Docker harness configuration. Walk me through choosing an application, machine, Docker image, and configuring ports.' },
    { label: 'Quick harness setup', request: 'Help me quickly set up a harness for testing. Auto-detect available machines and applications, suggest reasonable port defaults.' },
    { label: 'Full provisioning flow', request: 'Walk me through the full harness provisioning flow: select a machine, verify Docker and tmux are installed, deploy the launcher daemon, wait for it to connect, configure the harness with Claude auth, and start it.' },
  ],
  agent: [
    { label: 'Help me configure an agent', request: 'Walk me through setting up a new agent endpoint. Help me decide between interactive, headless, and webhook modes, and configure the right permission level for my use case.' },
    { label: 'Set up auto-dispatch', request: 'Help me configure an agent for automatic feedback dispatch. Set up appropriate permissions, allowed tools, and prompt template.' },
  ],
  sprite: [
    { label: 'Create a sprite', request: 'Help me create a new sprite configuration. Walk me through choosing a name, setting up a token, configuring max sessions, and provisioning the sprite on Fly.io.' },
    { label: 'Quick sprite setup', request: 'Help me quickly set up a sprite for development. Choose reasonable defaults, provision it, and launch a test session to verify it works.' },
  ],
};

export function SetupAssistButton({ entityType, entityId, entityLabel }: SetupAssistButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <span class="ai-assist-wrapper">
      <button
        ref={btnRef}
        class="ai-assist-btn"
        onClick={() => setOpen(!open)}
        title="Admin Assist"
      >
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>
        </svg>
      </button>
      {open && (
        <SetupAssistPopover
          entityType={entityType}
          entityId={entityId}
          entityLabel={entityLabel}
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

function SetupAssistPopover({ entityType, entityId, entityLabel, onClose, triggerRef }: SetupAssistButtonProps & { onClose: () => void; triggerRef: preact.RefObject<HTMLElement> }) {
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
    // Try to center horizontally on trigger, prefer above
    let x = trigger.left + trigger.width / 2 - pw / 2;
    let y = trigger.top - ph - 8;
    // If no room above, go below
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
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  function submit(requestText?: string) {
    const finalText = requestText || text.trim();
    if (!finalText || submitting) return;
    onClose();
    // Fire-and-forget: close modal immediately, open session tab when ready
    (async () => {
      try {
        const { sessionId } = await api.setupAssist({
          request: finalText,
          entityType,
          ...(entityId ? { entityId } : {}),
        });
        await loadAllSessions();
        openSession(sessionId);
      } catch (err: any) {
        console.error('Admin Assist failed:', err.message);
      }
    })();
  }

  const presets = entityId
    ? (PRESETS[entityType] || [])
    : (NEW_ENTITY_PRESETS[entityType] || []);
  const isNew = !entityId;
  const placeholder = isNew
    ? `How can I help set up a new ${entityType}?`
    : entityType === 'machine'
      ? 'How can I help set up this machine?'
      : entityType === 'harness'
        ? 'How can I help configure this harness?'
        : entityType === 'sprite'
          ? 'How can I help with this sprite?'
          : 'How can I help configure this agent?';

  return (
    <div
      class="ai-assist-popover"
      ref={panelRef}
      style="visibility:hidden"
    >
      <div class="ai-assist-header" onMouseDown={onDragStart}>
        <span style="font-weight:600;font-size:13px">Admin Assist</span>
        <span style="font-size:11px;color:var(--pw-text-muted)">{entityLabel}</span>
        <button class="ai-assist-close" onClick={onClose}>{'\u2715'}</button>
      </div>
      {presets.length > 0 && (
        <div class="ai-assist-body">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
            {presets.map((p) => (
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
      )}
      <div class="ai-assist-body" style="padding-top:0">
        <textarea
          ref={textareaRef}
          class="request-panel-textarea"
          placeholder={placeholder}
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
        <span class="request-panel-hint">{'\u2318'}+Enter</span>
      </div>
    </div>
  );
}
