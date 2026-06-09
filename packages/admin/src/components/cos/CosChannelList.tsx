import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import {
  selectedAppId,
  applications,
  channelsByApp,
  unsortedCountByApp,
  loadChannels,
  activeChannelSlug,
  type ChannelKind,
} from '../../lib/state.js';
import { api } from '../../lib/api.js';
import { loadChannelThreads, channelThreads, type ThreadRow } from '../../pages/ChannelPage.js';
import { type ChiefOfStaffAgent, COS_WORKSPACE_ID, loadChiefOfStaffHistory, chiefOfStaffAgents, chiefOfStaffActiveId, ensureChiefOfStaffAgent, setChiefOfStaffOpen } from '../../lib/chief-of-staff.js';
import { cosActiveThread } from '../../lib/cos-popout-tree.js';
import { openSession, loadAllSessions } from '../../lib/sessions.js';

const KIND_DOT: Record<ChannelKind, string> = {
  prod: 'var(--pw-danger)',
  staging: 'var(--pw-warning)',
  exploratory: 'var(--pw-primary)',
};

const SPLIT_RATIO_KEY = 'pw-cos-channel-list-split-ratio';
const DEFAULT_SPLIT_RATIO = 0.6;
function readSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= 0.1 && n <= 0.9) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_SPLIT_RATIO;
}

export function CosChannelList({
  onClose,
  agents,
  activeAgentId,
  onSelectAgent,
  onToggleVisible,
}: {
  onClose?: () => void;
  agents?: ChiefOfStaffAgent[];
  activeAgentId?: string;
  onSelectAgent?: (id: string) => void;
  /** Hide the drawer entirely. Lives on the hamburger inside the channel
   *  header (next to the workspace picker). The inverse "show" affordance
   *  is rendered by the parent on the chat pane when the drawer is hidden. */
  onToggleVisible?: () => void;
}) {
  const appId = selectedAppId.value;
  const apps = applications.value;
  const channels = appId ? (channelsByApp.value[appId] || []) : [];
  const unsorted = appId ? unsortedCountByApp.value[appId] : undefined;
  const hasUnsorted = (unsorted?.threadCount ?? 0) > 0;
  const currentSlug = activeChannelSlug.value;
  const currentApp = apps.find((a) => a.id === appId);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const [dmsExpanded, setDmsExpanded] = useState(true);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [splitRatio, setSplitRatio] = useState<number>(readSplitRatio);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isCosWorkspace = appId === COS_WORKSPACE_ID;
  const allThreads = channelThreads.value;

  useEffect(() => {
    try { localStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio)); } catch { /* ignore */ }
  }, [splitRatio]);

  const onSplitDividerMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    document.body.classList.add('cos-channel-list-resizing');
    const onMove = (ev: MouseEvent) => {
      const b = bodyRef.current;
      if (!b) return;
      const rect = b.getBoundingClientRect();
      if (rect.height <= 0) return;
      const r = (ev.clientY - rect.top) / rect.height;
      setSplitRatio(Math.max(0.1, Math.min(0.9, r)));
    };
    const onUp = () => {
      document.body.classList.remove('cos-channel-list-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Fetch threads when appId changes
  useEffect(() => {
    if (appId && appId !== COS_WORKSPACE_ID) {
      loadChannelThreads(appId);
    }
  }, [appId]);

  function toggleChannelThreads(channelId: string) {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  function openThread(t: ThreadRow) {
    ensureChiefOfStaffAgent(t.agentId);
    chiefOfStaffActiveId.value = t.agentId;
    // threadKey carries a `tid:` prefix everywhere else (see threadKeyOf in
    // CosThread.tsx) — chat uses raw `idx:` keys for legacy unsaved threads.
    // Drop the prefix and the chat's `isActiveInPanel` comparison misses.
    cosActiveThread.value = { agentId: t.agentId, threadKey: `tid:${t.id}` };
    setChiefOfStaffOpen(true);
    // Hand off to ChiefOfStaffBubble — it scrolls + highlights the anchor row.
    void loadChiefOfStaffHistory(t.agentId, selectedAppId.value).finally(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('cos-jump-to-thread', {
          detail: { agentId: t.agentId, threadId: t.id },
        }));
      });
    });
  }

  function getThreadsForChannel(channelId: string): ThreadRow[] {
    return (allThreads[channelId] || [])
      .filter((t) => !t.archivedAt && !t.resolvedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function goToChannel(slug: string) {
    if (!appId) return;
    // If already on this channel, deselect it (show all threads)
    if (currentSlug === slug) {
      activeChannelSlug.value = null;
      return;
    }
    activeChannelSlug.value = slug;
  }

  async function handleDrop(e: DragEvent, channelId: string) {
    const threadId = e.dataTransfer?.getData('application/x-cos-thread');
    if (!threadId || !appId) return;
    e.preventDefault();
    await api.moveThreadToChannel(channelId, threadId);
    await Promise.all([loadChannels(appId), loadChannelThreads(appId)]);
  }

  const workspaceName = isCosWorkspace
    ? 'Chief of Staff'
    : (currentApp?.name || 'App');

  function selectWorkspace(id: string) {
    selectedAppId.value = id;
    activeChannelSlug.value = null;
    setWorkspacePickerOpen(false);
  }

  if (!appId) {
    // Auto-select CoS workspace when no app is selected
    selectedAppId.value = COS_WORKSPACE_ID;
    return (
      <div class="cos-channel-list">
        <div class="cos-channel-list-empty">Loading...</div>
      </div>
    );
  }

  return (
    <div class="cos-channel-list">
      <div class="cos-channel-list-header">
        {onToggleVisible && (
          <button
            class="cos-channel-list-hamburger"
            onClick={onToggleVisible}
            title="Hide channels"
            aria-label="Hide channels"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        )}
        <button
          class="cos-channel-list-app-name cos-workspace-picker-btn"
          onClick={() => setWorkspacePickerOpen((v) => !v)}
          title={workspaceName}
        >
          {isCosWorkspace ? '\u{2726} ' : ''}{workspaceName}
          <span class="cos-workspace-caret">{workspacePickerOpen ? '▴' : '▾'}</span>
        </button>
        <div class="cos-channel-list-actions">
          <button
            class="cos-channel-list-add-btn"
            onClick={() => { setCreating(true); setDraft(''); }}
            title="Create channel"
          >+</button>
        </div>
      </div>

      {workspacePickerOpen && (
        <div class="cos-workspace-picker">
          <button
            class={`cos-workspace-item${isCosWorkspace ? ' cos-workspace-item-active' : ''}`}
            onClick={() => selectWorkspace(COS_WORKSPACE_ID)}
          >
            <span class="cos-workspace-item-icon">{'\u{2726}'}</span>
            Chief of Staff
          </button>
          {apps.map((a: any) => (
            <button
              key={a.id}
              class={`cos-workspace-item${a.id === appId && !isCosWorkspace ? ' cos-workspace-item-active' : ''}`}
              onClick={() => selectWorkspace(a.id)}
            >
              <span class="cos-workspace-item-icon">{'\u{1F4E6}'}</span>
              {a.name}
            </button>
          ))}
        </div>
      )}

      {creating && (
        <div class="cos-channel-list-create">
          <input
            value={draft}
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
            placeholder="channel name..."
            autoFocus
            class="cos-channel-list-create-input"
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && draft.trim()) {
                await api.createChannel({ appId, name: draft.trim() });
                setCreating(false);
                setDraft('');
                await loadChannels(appId);
              } else if (e.key === 'Escape') {
                setCreating(false);
                setDraft('');
              }
            }}
            onBlur={() => { if (!draft.trim()) setCreating(false); }}
          />
        </div>
      )}

      {(() => {
        const hasDms = !!(agents && agents.length > 0);
        const showSplit = hasDms && channelsExpanded && dmsExpanded;
        const channelsFlex = showSplit
          ? { flexGrow: splitRatio, flexBasis: 0, flexShrink: 1 }
          : (channelsExpanded ? { flex: 1 } : { flex: '0 0 auto' });
        const dmsFlex = showSplit
          ? { flexGrow: 1 - splitRatio, flexBasis: 0, flexShrink: 1 }
          : (dmsExpanded ? { flex: 1 } : { flex: '0 0 auto' });

        return (
          <div class="cos-channel-list-body" ref={bodyRef}>
            <div class="cos-channel-list-section" style={channelsFlex as any}>
              <button
                class="cos-channel-list-section-toggle"
                onClick={() => setChannelsExpanded((v) => !v)}
              >
                <span class="cos-channel-list-section-caret">{channelsExpanded ? '▾' : '▸'}</span>
                <span class="cos-channel-list-section-label">Channels</span>
              </button>
              {channelsExpanded && (
                <div class="cos-channel-list-section-scroll">
                  {renderChannelsItems()}
                </div>
              )}
            </div>

            {showSplit && (
              <div
                class="cos-channel-list-split-divider"
                onMouseDown={onSplitDividerMouseDown}
                title="Drag to resize"
              />
            )}

            {hasDms && (
              <div class="cos-channel-list-section" style={dmsFlex as any}>
                <button
                  class="cos-channel-list-section-toggle"
                  onClick={() => setDmsExpanded((v) => !v)}
                >
                  <span class="cos-channel-list-section-caret">{dmsExpanded ? '▾' : '▸'}</span>
                  <span class="cos-channel-list-section-label">Direct Messages</span>
                </button>
                {dmsExpanded && (
                  <div class="cos-channel-list-section-scroll">
                    <div class="cos-channel-list-items">
                      {agents!.map((a) => (
                        <button
                          key={a.id}
                          class={`cos-channel-item cos-channel-item-dm${a.id === activeAgentId ? ' cos-channel-item-active' : ''}`}
                          onClick={() => onSelectAgent?.(a.id)}
                          title={a.name}
                        >
                          <span class="cos-channel-item-dm-avatar">
                            {a.name.charAt(0).toUpperCase()}
                          </span>
                          <span class="cos-channel-item-name">{a.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );

  function renderChannelsItems() {
    return (
      <div class="cos-channel-list-items">
          <button
            class={`cos-channel-item${!currentSlug ? ' cos-channel-item-active' : ''}`}
            onClick={() => { activeChannelSlug.value = null; toggleChannelThreads('_all'); }}
          >
            <span class="cos-channel-item-expand">{expandedChannels.has('_all') ? '▾' : '▸'}</span>
            <span class="cos-channel-item-icon">{'\u{1F4AC}'}</span>
            <span class="cos-channel-item-name">All threads</span>
          </button>
          {expandedChannels.has('_all') && (
            <ChannelThreadList
              threads={Object.values(allThreads).flat()
                .filter((t) => !t.archivedAt && !t.resolvedAt)
                .sort((a, b) => b.updatedAt - a.updatedAt)}
              onOpen={openThread}
            />
          )}

          {hasUnsorted && (
            <>
              <button
                class={`cos-channel-item${currentSlug === '_unsorted' ? ' cos-channel-item-active' : ''}`}
                onClick={() => { goToChannel('_unsorted'); toggleChannelThreads('_unsorted'); }}
                onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => handleDrop(e as any, '_unsorted')}
              >
                <span class="cos-channel-item-expand">{expandedChannels.has('_unsorted') ? '▾' : '▸'}</span>
                <span class="cos-channel-item-icon">{'\u{1F4E5}'}</span>
                <span class="cos-channel-item-name">Unsorted</span>
                <span class="cos-channel-item-count">{unsorted?.openCount ?? unsorted?.threadCount ?? 0}</span>
              </button>
              {expandedChannels.has('_unsorted') && (
                <ChannelThreadList threads={getThreadsForChannel('_unsorted')} onOpen={openThread} />
              )}
            </>
          )}

          {channels.map((ch) => {
            const chThreads = getThreadsForChannel(ch.id);
            const isExpanded = expandedChannels.has(ch.id);
            return (
              <div key={ch.id}>
                <button
                  class={`cos-channel-item${currentSlug === ch.slug ? ' cos-channel-item-active' : ''}`}
                  onClick={() => { goToChannel(ch.slug); toggleChannelThreads(ch.id); }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.15)';
                  }}
                  onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
                  onDrop={(e) => {
                    (e.currentTarget as HTMLElement).style.background = '';
                    handleDrop(e as any, ch.id);
                  }}
                  title={`${ch.name} (${ch.kind})${ch.description ? ' — ' + ch.description : ''}`}
                >
                  <span class="cos-channel-item-expand">{isExpanded ? '▾' : '▸'}</span>
                  <span
                    class="cos-channel-item-dot"
                    style={{ background: KIND_DOT[ch.kind] || 'var(--pw-text-muted)' }}
                  />
                  <span class="cos-channel-item-name">#{ch.slug}</span>
                  {ch.openCount > 0 && (
                    <span class="cos-channel-item-count">{ch.openCount}</span>
                  )}
                </button>
                {isExpanded && (
                  <ChannelThreadList threads={chThreads} onOpen={openThread} />
                )}
              </div>
            );
          })}

          {channels.length === 0 && !hasUnsorted && (
            <div class="cos-channel-list-empty">No channels yet</div>
          )}

          {hasUnsorted && !isCosWorkspace && (
            <button
              class="cos-channel-item cos-channel-sort-btn"
              onClick={async () => {
                if (!appId) return;
                try {
                  const result = await api.autoOrganizeChannelsSession(appId);
                  if (result?.sessionId) {
                    await loadAllSessions();
                    openSession(result.sessionId);
                  }
                } catch { /* toast could go here */ }
              }}
              title="Launch an agent session that sorts unsorted threads into channels"
            >
              <span class="cos-channel-item-icon">{'\u{2728}'}</span>
              <span class="cos-channel-item-name">Auto-sort threads</span>
            </button>
          )}
        </div>
    );
  }
}

const STATUS_DOT: Record<string, string> = {
  running: 'var(--pw-warning)',
  failed: 'var(--pw-danger)',
  completed: 'var(--pw-text-muted)',
};

function ChannelThreadList({
  threads,
  onOpen,
}: {
  threads: ThreadRow[];
  onOpen: (t: ThreadRow) => void;
}) {
  if (threads.length === 0) {
    return <div class="cos-channel-thread-list-empty">No open threads</div>;
  }
  const activeThread = cosActiveThread.value;
  return (
    <div class="cos-channel-thread-list">
      {threads.map((t) => {
        const isActive = activeThread?.agentId === t.agentId && activeThread?.threadKey === `tid:${t.id}`;
        const dotColor = t.sessionStatus ? (STATUS_DOT[t.sessionStatus] || 'var(--pw-primary)') : 'var(--pw-primary)';
        return (
          <button
            key={t.id}
            class={`cos-channel-thread-item${isActive ? ' cos-channel-thread-item-active' : ''}`}
            onClick={() => onOpen(t)}
            title={t.name}
            draggable
            onDragStart={(e) => {
              e.dataTransfer?.setData('application/x-cos-thread', t.id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <span
              class="cos-channel-thread-dot"
              style={{ background: dotColor }}
            />
            <span class="cos-channel-thread-name">{t.name}</span>
          </button>
        );
      })}
    </div>
  );
}
