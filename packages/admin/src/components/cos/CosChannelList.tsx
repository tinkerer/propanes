import { useState, useEffect } from 'preact/hooks';
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
import { type ChiefOfStaffAgent, COS_WORKSPACE_ID, loadChiefOfStaffHistory, chiefOfStaffAgents, chiefOfStaffActiveId, setChiefOfStaffOpen } from '../../lib/chief-of-staff.js';
import { cosActiveThread } from '../../lib/cos-popout-tree.js';

const KIND_DOT: Record<ChannelKind, string> = {
  prod: '#ef4444',
  staging: '#eab308',
  exploratory: '#22c55e',
};

export function CosChannelList({
  onClose,
  agents,
  activeAgentId,
  onSelectAgent,
}: {
  onClose?: () => void;
  agents?: ChiefOfStaffAgent[];
  activeAgentId?: string;
  onSelectAgent?: (id: string) => void;
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
  const isCosWorkspace = appId === COS_WORKSPACE_ID;
  const allThreads = channelThreads.value;

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
    chiefOfStaffActiveId.value = t.agentId;
    cosActiveThread.value = { agentId: t.agentId, threadKey: t.id };
    setChiefOfStaffOpen(true);
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
        <button
          class="cos-channel-list-app-name cos-workspace-picker-btn"
          onClick={() => setWorkspacePickerOpen((v) => !v)}
          title={workspaceName}
        >
          {isCosWorkspace ? '\u{2726} ' : ''}{workspaceName}
          <span class="cos-workspace-caret">{workspacePickerOpen ? '\u25B4' : '\u25BE'}</span>
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

      <button
        class="cos-channel-list-section-toggle"
        onClick={() => setChannelsExpanded((v) => !v)}
      >
        <span class="cos-channel-list-section-caret">{channelsExpanded ? '\u25BE' : '\u25B8'}</span>
        <span class="cos-channel-list-section-label">Channels</span>
      </button>

      {channelsExpanded && (
        <div class="cos-channel-list-items">
          <button
            class={`cos-channel-item${!currentSlug ? ' cos-channel-item-active' : ''}`}
            onClick={() => { activeChannelSlug.value = null; toggleChannelThreads('_all'); }}
          >
            <span class="cos-channel-item-expand">{expandedChannels.has('_all') ? '\u25BE' : '\u25B8'}</span>
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
                <span class="cos-channel-item-expand">{expandedChannels.has('_unsorted') ? '\u25BE' : '\u25B8'}</span>
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
                  title={`${ch.name} (${ch.kind})${ch.description ? ' \u2014 ' + ch.description : ''}`}
                >
                  <span class="cos-channel-item-expand">{isExpanded ? '\u25BE' : '\u25B8'}</span>
                  <span
                    class="cos-channel-item-dot"
                    style={{ background: KIND_DOT[ch.kind] || '#6b7280' }}
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
                  const result = await api.autoOrganizeChannels(appId);
                  if (result?.id) {
                    await api.applyOrgProposal(result.id);
                    await loadChannels(appId);
                    // Refresh thread channel assignments
                    for (const a of chiefOfStaffAgents.value) {
                      void loadChiefOfStaffHistory(a.id, appId);
                    }
                  }
                } catch { /* toast could go here */ }
              }}
              title="Auto-sort unsorted threads into channels using AI"
            >
              <span class="cos-channel-item-icon">{'\u{2728}'}</span>
              <span class="cos-channel-item-name">Auto-sort threads</span>
            </button>
          )}
        </div>
      )}

      {/* Direct Messages — agents listed as DMs */}
      {agents && agents.length > 0 && (
        <>
          <button
            class="cos-channel-list-section-toggle"
            onClick={() => setDmsExpanded((v) => !v)}
          >
            <span class="cos-channel-list-section-caret">{dmsExpanded ? '\u25BE' : '\u25B8'}</span>
            <span class="cos-channel-list-section-label">Direct Messages</span>
          </button>
          {dmsExpanded && (
            <div class="cos-channel-list-items">
              {agents.map((a) => (
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
          )}
        </>
      )}
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  running: '#22c55e',
  failed: '#ef4444',
  completed: '#6b7280',
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
        const isActive = activeThread?.threadKey === t.id;
        const dotColor = t.sessionStatus ? (STATUS_DOT[t.sessionStatus] || '#3b82f6') : '#3b82f6';
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
