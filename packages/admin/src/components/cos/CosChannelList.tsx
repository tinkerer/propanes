import { useState } from 'preact/hooks';
import {
  selectedAppId,
  applications,
  channelsByApp,
  unsortedCountByApp,
  loadChannels,
  navigate,
  activeChannelSlug,
  type ChannelKind,
} from '../../lib/state.js';
import { api } from '../../lib/api.js';
import { openPageView } from '../../lib/sessions.js';
import { loadChannelThreads } from '../../pages/ChannelPage.js';

const KIND_DOT: Record<ChannelKind, string> = {
  prod: '#ef4444',
  staging: '#eab308',
  exploratory: '#22c55e',
};

export function CosChannelList({ onClose }: { onClose?: () => void }) {
  const appId = selectedAppId.value;
  const apps = applications.value;
  const channels = appId ? (channelsByApp.value[appId] || []) : [];
  const unsorted = appId ? unsortedCountByApp.value[appId] : undefined;
  const hasUnsorted = (unsorted?.threadCount ?? 0) > 0;
  const currentSlug = activeChannelSlug.value;
  const currentApp = apps.find((a) => a.id === appId);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');

  function goToChannel(slug: string) {
    if (!appId) return;
    navigate(`/app/${appId}/c/${slug}`);
    openPageView('view:channel');
  }

  async function handleDrop(e: DragEvent, channelId: string) {
    const threadId = e.dataTransfer?.getData('application/x-cos-thread');
    if (!threadId || !appId) return;
    e.preventDefault();
    await api.moveThreadToChannel(channelId, threadId);
    await Promise.all([loadChannels(appId), loadChannelThreads(appId)]);
  }

  if (!appId) {
    return (
      <div class="cos-channel-list">
        <div class="cos-channel-list-empty">No app selected</div>
      </div>
    );
  }

  return (
    <div class="cos-channel-list">
      <div class="cos-channel-list-header">
        <span class="cos-channel-list-app-name" title={currentApp?.name || appId}>
          {currentApp?.name || 'App'}
        </span>
        <div class="cos-channel-list-actions">
          <button
            class="cos-channel-list-add-btn"
            onClick={() => { setCreating(true); setDraft(''); }}
            title="Create channel"
          >+</button>
        </div>
      </div>

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

      <div class="cos-channel-list-section-label">Channels</div>

      <div class="cos-channel-list-items">
        {hasUnsorted && (
          <button
            class={`cos-channel-item${currentSlug === '_unsorted' ? ' cos-channel-item-active' : ''}`}
            onClick={() => goToChannel('_unsorted')}
            onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => handleDrop(e as any, '_unsorted')}
          >
            <span class="cos-channel-item-icon">{'\u{1F4E5}'}</span>
            <span class="cos-channel-item-name">Unsorted</span>
            <span class="cos-channel-item-count">{unsorted?.openCount ?? unsorted?.threadCount ?? 0}</span>
          </button>
        )}

        {channels.map((ch) => (
          <button
            key={ch.id}
            class={`cos-channel-item${currentSlug === ch.slug ? ' cos-channel-item-active' : ''}`}
            onClick={() => goToChannel(ch.slug)}
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
            <span
              class="cos-channel-item-dot"
              style={{ background: KIND_DOT[ch.kind] || '#6b7280' }}
            />
            <span class="cos-channel-item-name">#{ch.slug}</span>
            {ch.openCount > 0 && (
              <span class="cos-channel-item-count">{ch.openCount}</span>
            )}
          </button>
        ))}

        {channels.length === 0 && !hasUnsorted && (
          <div class="cos-channel-list-empty">No channels yet</div>
        )}
      </div>
    </div>
  );
}
