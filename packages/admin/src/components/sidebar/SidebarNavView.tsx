import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  currentRoute, clearToken, navigate, selectedAppId, applications, unlinkedCount,
  appFeedbackCounts, addAppModalOpen,
  channelsByApp, unsortedCountByApp, channelOrgProposalOpen, loadChannels,
  pendingApprovalCountByApp, loadApprovals,
  type ChannelKind,
} from '../lib/state.js';
import { api } from '../lib/api.js';
import { subscribeAdmin } from '../lib/admin-ws.js';
import { sidebarCollapsed, sidebarAnimating, toggleSidebar, sidebarWidth, openSettingsPanel, openPageView } from '../lib/sessions.js';
import { loadChannelThreads } from '../pages/ChannelPage.js';
import { Tooltip } from './Tooltip.js';

const KIND_DOT: Record<ChannelKind, string> = {
  prod: '#ef4444',
  staging: '#eab308',
  exploratory: '#22c55e',
};

interface LiveConnection {
  sessionId: string;
  connectedAt: string;
  lastActivity: string;
  url: string | null;
  appId: string | null;
}

const liveConnectionCounts = signal<Record<string, number>>({});
const liveSites = signal<{ origin: string; hostname: string; count: number }[]>([]);

function processLiveConnections(conns: LiveConnection[]) {
  const counts: Record<string, number> = {};
  const siteMap = new Map<string, number>();
  const serverOrigin = window.location.origin;
  for (const c of conns) {
    const key = c.appId || '__unlinked__';
    counts[key] = (counts[key] || 0) + 1;
    if (c.url) {
      try {
        const u = new URL(c.url);
        if (u.origin !== serverOrigin) {
          siteMap.set(u.origin, (siteMap.get(u.origin) || 0) + 1);
        }
      } catch { /* invalid url */ }
    }
  }
  liveConnectionCounts.value = counts;
  liveSites.value = [...siteMap.entries()]
    .map(([origin, count]) => ({ origin, hostname: new URL(origin).hostname, count }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

async function pollLiveConnections() {
  try {
    const conns: LiveConnection[] = await api.getLiveConnections();
    processLiveConnections(conns);
  } catch {
    // ignore
  }
}

const settingsItems = [
  { path: '/settings/agents', label: 'Agents', icon: '\u{1F916}' },
  { path: '/settings/infrastructure', label: 'Infrastructure', icon: '\u{1F3D7}' },
  { path: '/settings/wiggum', label: 'Wiggum', icon: '\u{1F575}' },
  { path: '/settings/user-guide', label: 'User Guide', icon: '\u{1F4D6}' },
  { path: '/settings/getting-started', label: 'Getting Started', icon: '\u{1F680}' },
  { path: '/settings/preferences', label: 'Preferences', icon: '\u2699' },
];

function ChannelSubsection({ appId, route }: { appId: string; route: string }) {
  const channels = channelsByApp.value[appId] || [];
  const unsorted = unsortedCountByApp.value[appId];
  const hasUnsorted = (unsorted?.threadCount ?? 0) > 0;
  const [creating, setCreating] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>('');

  return (
    <div class="sidebar-channels">
      <div class="sidebar-channels-header" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 12px 2px', fontSize: 10, textTransform: 'uppercase',
        color: 'var(--pw-text-muted)', letterSpacing: 0.5,
      }}>
        <span>Channels</span>
        <button
          onClick={(e) => { e.stopPropagation(); setCreating(appId); setDraft(''); }}
          title="Create channel"
          style={{ background: 'transparent', border: 'none', color: 'var(--pw-text-muted)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
        >+</button>
      </div>
      {creating === appId && (
        <input
          value={draft}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          placeholder="channel name…"
          autoFocus
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && draft.trim()) {
              await api.createChannel({ appId, name: draft.trim() });
              setCreating(null); setDraft('');
              await loadChannels(appId);
            } else if (e.key === 'Escape') {
              setCreating(null); setDraft('');
            }
          }}
          onBlur={() => { if (!draft.trim()) setCreating(null); }}
          style={{
            margin: '0 8px 4px 16px',
            padding: '3px 6px', fontSize: 12,
            background: 'rgba(0,0,0,0.3)', border: '1px solid var(--pw-border)',
            borderRadius: 3, color: 'var(--pw-text)', width: 'calc(100% - 24px)',
            boxSizing: 'border-box',
          }}
        />
      )}
      {hasUnsorted && (
        <a
          href={`#/app/${appId}/c/_unsorted`}
          class={route === `/app/${appId}/c/_unsorted` ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); navigate(`/app/${appId}/c/_unsorted`); openPageView('view:channel'); }}
          onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
          onDrop={async (e) => {
            const threadId = e.dataTransfer?.getData('application/x-cos-thread');
            if (!threadId) return;
            e.preventDefault();
            await api.moveThreadToChannel('_unsorted', threadId);
            await Promise.all([loadChannels(appId), loadChannelThreads(appId)]);
          }}
          style={{ paddingLeft: 16 }}
        >
          {'\u{1F4E5}'} Unsorted
          <span class="sidebar-count">{unsorted?.openCount ?? unsorted?.threadCount ?? 0}</span>
        </a>
      )}
      {channels.map((ch) => (
        <a
          key={ch.id}
          href={`#/app/${appId}/c/${ch.slug}`}
          class={route === `/app/${appId}/c/${ch.slug}` || route.startsWith(`/app/${appId}/c/${ch.slug}/`) ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); navigate(`/app/${appId}/c/${ch.slug}`); openPageView('view:channel'); }}
          onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; (e.currentTarget as HTMLElement).style.background = 'rgba(59,130,246,0.15)'; }}
          onDragLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
          onDrop={async (e) => {
            (e.currentTarget as HTMLElement).style.background = '';
            const threadId = e.dataTransfer?.getData('application/x-cos-thread');
            if (!threadId) return;
            e.preventDefault();
            await api.moveThreadToChannel(ch.id, threadId);
            await Promise.all([loadChannels(appId), loadChannelThreads(appId)]);
          }}
          title={`${ch.name} (${ch.kind})${ch.description ? ' — ' + ch.description : ''}`}
          style={{ paddingLeft: 16, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: KIND_DOT[ch.kind] || '#6b7280', flexShrink: 0 }} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{ch.slug}</span>
          {ch.openCount > 0 && <span class="sidebar-count">{ch.openCount}</span>}
        </a>
      ))}
      {channels.length === 0 && hasUnsorted && (
        <button
          onClick={async (e) => {
            e.stopPropagation();
            channelOrgProposalOpen.value = true;
            try { await api.autoOrganizeChannels(appId); } catch { /* error surfaced inside modal */ }
          }}
          style={{
            margin: '4px 8px 4px 16px', padding: '4px 8px', fontSize: 11,
            background: 'rgba(59,130,246,0.15)', color: '#93c5fd',
            border: '1px solid rgba(59,130,246,0.3)', borderRadius: 3,
            cursor: 'pointer', textAlign: 'left',
          }}
          title="Ask Claude to organize threads into channels"
        >✨ Auto-organize</button>
      )}
    </div>
  );
}

export function SidebarNavView() {
  const route = currentRoute.value;
  const collapsed = sidebarCollapsed.value;
  const apps = applications.value;
  const selAppId = selectedAppId.value;
  const hasUnlinked = unlinkedCount.value > 0;
  const fbCounts = appFeedbackCounts.value;

  useEffect(() => {
    pollLiveConnections(); // initial load
    return subscribeAdmin('live-connections', (conns: LiveConnection[]) => {
      processLiveConnections(conns);
    });
  }, []);

  // Refresh approval-pending counts per app (sidebar badge) every 30s.
  useEffect(() => {
    const refresh = () => { for (const app of apps) loadApprovals(app.id); };
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
    return () => clearInterval(id);
  }, [apps.length]);

  return (
    <div class="sidebar-nav-view" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <div class="sidebar-header">
        <Tooltip text={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} shortcut="Ctrl+\" position="right">
          <button class="sidebar-toggle" onClick={toggleSidebar}>
            &#9776;
          </button>
        </Tooltip>
        <div class="sidebar-brand">
          <span class="sidebar-title">ProPanes</span>
          <span class="sidebar-tagline">Now you&apos;re cooking with gases</span>
        </div>
        {!collapsed && (
          <a
            class="bookmarklet-link"
            href={`javascript:void((function(){var e=document.getElementById('pw-bookmarklet-frame');if(e){e.remove();return}var f=document.createElement('iframe');f.id='pw-bookmarklet-frame';f.src='${window.location.origin}/widget/bookmarklet.html?host='+encodeURIComponent(location.href);f.style.cssText='position:fixed;bottom:0;right:0;width:420px;height:100%;border:none;z-index:2147483647;pointer-events:none;';f.allow='clipboard-write';window.addEventListener('message',function(m){if(m.data&&m.data.type==='pw-bookmarklet-remove'){var el=document.getElementById('pw-bookmarklet-frame');if(el)el.remove()}});document.body.appendChild(f)})())`}
            title="Drag to bookmarks bar to load widget on any site"
            onClick={(e) => e.preventDefault()}
          >
            {'\u{1F516}'}
          </a>
        )}
      </div>
      <nav>
        {!collapsed && (
          <div class="sidebar-section-header">
            Apps
            <button
              class="sidebar-new-terminal-btn"
              onClick={(e) => { e.stopPropagation(); addAppModalOpen.value = true; }}
              title="Add app"
            >+</button>
          </div>
        )}
        {apps.map((app) => {
          const isSelected = selAppId === app.id;
          return (
            <div key={app.id}>
              <a
                href={`#/app/${app.id}/tickets`}
                class={`sidebar-app-item ${isSelected ? 'active' : ''}`}
                onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/tickets`); }}
                title={collapsed ? app.name : undefined}
              >
                <span class="nav-icon">{'\u{1F4BB}'}</span>
                <span class="nav-label">{app.name}</span>
              </a>
              {isSelected && !collapsed && (
                <div class="sidebar-subnav">
                  <a
                    href={`#/app/${app.id}/tickets`}
                    class={route === `/app/${app.id}/tickets` || route.startsWith(`/app/${app.id}/tickets/`) || route === `/app/${app.id}/feedback` || route.startsWith(`/app/${app.id}/feedback/`) ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/tickets`); openPageView('view:feedback'); }}
                  >
                    {'\u{1F4CB}'} Tickets
                    {fbCounts[app.id]?.total > 0 && <span class="sidebar-count">{fbCounts[app.id].total}</span>}
                  </a>
                  <a
                    href={`#/app/${app.id}/sessions`}
                    class={route === `/app/${app.id}/sessions` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/sessions`); openPageView('view:sessions-page'); }}
                  >
                    {'\u26A1'} Sessions
                  </a>
                  <a
                    href={`#/app/${app.id}/live`}
                    class={route === `/app/${app.id}/live` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/live`); openPageView('view:live'); }}
                  >
                    {'\u{1F310}'} Live
                    {(liveConnectionCounts.value[app.id] || 0) > 0 && (
                      <span class="sidebar-count">{liveConnectionCounts.value[app.id]}</span>
                    )}
                  </a>
                  <a
                    href={`#/app/${app.id}/wiggum`}
                    class={route === `/app/${app.id}/wiggum` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/wiggum`); openPageView('view:wiggum'); }}
                  >
                    {'\u{1F9EC}'} FAFO / Wiggum
                  </a>
                  <a
                    href={`#/app/${app.id}/approvals`}
                    class={route === `/app/${app.id}/approvals` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/approvals`); openPageView('view:approvals'); }}
                  >
                    {'\u{1F512}'} Approvals
                    {(pendingApprovalCountByApp.value[app.id] || 0) > 0 && (
                      <span class="sidebar-count">{pendingApprovalCountByApp.value[app.id]}</span>
                    )}
                  </a>
                  <ChannelSubsection appId={app.id} route={route} />
                  <a
                    href={`#/app/${app.id}/settings`}
                    class={route === `/app/${app.id}/settings` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/settings`); openPageView('view:app-settings'); }}
                  >
                    {'\u2699'} Settings
                  </a>
                </div>
              )}
            </div>
          );
        })}
        {hasUnlinked && (
          <div>
            <a
              href="#/app/__unlinked__/tickets"
              class={`sidebar-app-item ${selAppId === '__unlinked__' ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); navigate('/app/__unlinked__/tickets'); }}
              title={collapsed ? 'Unlinked' : undefined}
            >
              <span class="nav-icon">{'\u{1F517}'}</span>
              <span class="nav-label">Unlinked</span>
              {!collapsed && unlinkedCount.value > 0 && <span class="sidebar-count">{unlinkedCount.value}</span>}
            </a>
            {selAppId === '__unlinked__' && !collapsed && (
              <div class="sidebar-subnav">
                <a
                  href="#/app/__unlinked__/tickets"
                  class={route.startsWith('/app/__unlinked__/tickets') || route.startsWith('/app/__unlinked__/feedback') ? 'active' : ''}
                  onClick={(e) => { e.preventDefault(); navigate('/app/__unlinked__/tickets'); }}
                >
                  {'\u{1F4CB}'} Tickets
                </a>
              </div>
            )}
          </div>
        )}

        {!collapsed && liveSites.value.length > 0 && (
          <>
            <div class="sidebar-divider" />
            <div class="sidebar-section-header">Sites</div>
            {liveSites.value.map((site) => (
              <div key={site.origin} class="sidebar-site-item" title={site.origin}>
                <span class="nav-icon">{'\u{1F310}'}</span>
                <span class="nav-label">{site.hostname}</span>
                <span class="sidebar-count">{site.count}</span>
              </div>
            ))}
          </>
        )}

        <div class="sidebar-divider" />

        {!collapsed && (
          <div class="sidebar-section-header">Settings</div>
        )}
        {settingsItems.map((item) => {
          const key = item.path.replace('/settings/', '');
          return (
            <a
              key={item.path}
              href={`#${item.path}`}
              class={`sidebar-app-item ${route === item.path ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); openSettingsPanel(key); }}
              title={collapsed ? item.label : undefined}
            >
              <span class="nav-icon">{item.icon}</span>
              <span class="nav-label">{item.label}</span>
            </a>
          );
        })}
        <a
          href="#"
          class="sidebar-app-item"
          onClick={(e) => {
            e.preventDefault();
            clearToken();
            navigate('/login');
          }}
          title={collapsed ? 'Logout' : undefined}
        >
          <span class="nav-icon">{'\u21A9'}</span>
          <span class="nav-label">Logout</span>
        </a>
      </nav>
    </div>
  );
}
