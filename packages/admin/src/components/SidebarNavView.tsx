import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import { currentRoute, clearToken, navigate, selectedAppId, applications, unlinkedCount, appFeedbackCounts, addAppModalOpen } from '../lib/state.js';
import { api } from '../lib/api.js';
import { sidebarCollapsed, sidebarAnimating, toggleSidebar, sidebarWidth, openSettingsPanel } from '../lib/sessions.js';
import { Tooltip } from './Tooltip.js';

interface LiveConnection {
  sessionId: string;
  connectedAt: string;
  lastActivity: string;
  url: string | null;
  appId: string | null;
}

const liveConnectionCounts = signal<Record<string, number>>({});
const liveSites = signal<{ origin: string; hostname: string; count: number }[]>([]);

async function pollLiveConnections() {
  try {
    const conns: LiveConnection[] = await api.getLiveConnections();
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

export function SidebarNavView() {
  const route = currentRoute.value;
  const collapsed = sidebarCollapsed.value;
  const apps = applications.value;
  const selAppId = selectedAppId.value;
  const hasUnlinked = unlinkedCount.value > 0;
  const fbCounts = appFeedbackCounts.value;

  useEffect(() => {
    pollLiveConnections();
    const interval = setInterval(pollLiveConnections, 5_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div class="sidebar-nav-view" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <div class="sidebar-header">
        <Tooltip text={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} shortcut="Ctrl+\" position="right">
          <button class="sidebar-toggle" onClick={toggleSidebar}>
            &#9776;
          </button>
        </Tooltip>
        <span class="sidebar-title">Prompt Widget</span>
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
                href={`#/app/${app.id}/feedback`}
                class={`sidebar-app-item ${isSelected ? 'active' : ''}`}
                onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/feedback`); }}
                title={collapsed ? app.name : undefined}
              >
                <span class="nav-icon">{'\u{1F4BB}'}</span>
                <span class="nav-label">{app.name}</span>
              </a>
              {isSelected && !collapsed && (
                <div class="sidebar-subnav">
                  <a
                    href={`#/app/${app.id}/feedback`}
                    class={route === `/app/${app.id}/feedback` || route.startsWith(`/app/${app.id}/feedback/`) ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/feedback`); }}
                  >
                    {'\u{1F4CB}'} Feedback
                    {fbCounts[app.id]?.total > 0 && <span class="sidebar-count">{fbCounts[app.id].total}</span>}
                  </a>
                  <a
                    href={`#/app/${app.id}/aggregate`}
                    class={route === `/app/${app.id}/aggregate` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/aggregate`); }}
                  >
                    {'\u{1F4CA}'} Aggregate
                  </a>
                  <a
                    href={`#/app/${app.id}/sessions`}
                    class={route === `/app/${app.id}/sessions` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/sessions`); }}
                  >
                    {'\u26A1'} Sessions
                  </a>
                  <a
                    href={`#/app/${app.id}/live`}
                    class={route === `/app/${app.id}/live` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/live`); }}
                  >
                    {'\u{1F310}'} Live
                    {(liveConnectionCounts.value[app.id] || 0) > 0 && (
                      <span class="sidebar-count">{liveConnectionCounts.value[app.id]}</span>
                    )}
                  </a>
                  <a
                    href={`#/app/${app.id}/settings`}
                    class={route === `/app/${app.id}/settings` ? 'active' : ''}
                    onClick={(e) => { e.preventDefault(); navigate(`/app/${app.id}/settings`); }}
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
              href="#/app/__unlinked__/feedback"
              class={`sidebar-app-item ${selAppId === '__unlinked__' ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); navigate('/app/__unlinked__/feedback'); }}
              title={collapsed ? 'Unlinked' : undefined}
            >
              <span class="nav-icon">{'\u{1F517}'}</span>
              <span class="nav-label">Unlinked</span>
              {!collapsed && unlinkedCount.value > 0 && <span class="sidebar-count">{unlinkedCount.value}</span>}
            </a>
            {selAppId === '__unlinked__' && !collapsed && (
              <div class="sidebar-subnav">
                <a
                  href="#/app/__unlinked__/feedback"
                  class={route.startsWith('/app/__unlinked__/feedback') ? 'active' : ''}
                  onClick={(e) => { e.preventDefault(); navigate('/app/__unlinked__/feedback'); }}
                >
                  {'\u{1F4CB}'} Feedback
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
