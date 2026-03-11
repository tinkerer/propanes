import { useState, useEffect, useRef } from 'preact/hooks';
import { allSessions, paneMruHistory, spawnTerminal, attachTmuxSession, setTerminalCompanionAndOpen, setTerminalCompanion, togglePanelCompanion, loadAllSessions, openSession, openIsolateCompanion, openUrlCompanion } from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';
import { getIsolateNames, getIsolateEntry } from '../lib/isolate.js';
import { cachedTargets, ensureTargetsLoaded } from './DispatchTargetSelect.js';
import { api } from '../lib/api.js';

export type TerminalPickerMode =
  | { kind: 'companion'; sessionId: string; panelId?: string }
  | { kind: 'new' }
  | { kind: 'claude' }
  | { kind: 'url' };

interface Props {
  mode: TerminalPickerMode;
  onClose: () => void;
}

interface PickerItem {
  id: string;
  category: string;
  icon: string;
  title: string;
  subtitle?: string;
  action: () => Promise<void> | void;
  disabled?: boolean;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function TerminalPicker({ mode, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tmuxSessions, setTmuxSessions] = useState<{ name: string; windows: number; created: string; attached: boolean }[]>([]);
  const [tmuxLoading, setTmuxLoading] = useState(true);
  const [internalUrlMode, setInternalUrlMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isUrlMode = mode.kind === 'url' || internalUrlMode;

  useEffect(() => {
    inputRef.current?.focus();
  }, [internalUrlMode]);

  useEffect(() => {
    if (isUrlMode) return;
    ensureTargetsLoaded();
    setTmuxLoading(true);
    api.listTmuxSessions()
      .then((r) => setTmuxSessions(r.sessions))
      .catch(() => setTmuxSessions([]))
      .finally(() => setTmuxLoading(false));
  }, []);

  const parentSessionId = mode.kind === 'companion' ? mode.sessionId : null;
  const panelId = mode.kind === 'companion' ? mode.panelId : undefined;
  const appId = selectedAppId.value;

  const isClaudeMode = mode.kind === 'claude';

  /** Open the companion split pane immediately (with whatever is in the companion map) */
  function openCompanionPane(termSessionId: string) {
    if (!parentSessionId) return;
    setTerminalCompanion(parentSessionId, termSessionId);
    if (panelId) {
      togglePanelCompanion(panelId, parentSessionId, 'terminal');
    } else {
      setTerminalCompanionAndOpen(parentSessionId, termSessionId);
    }
  }

  async function pickNew(launcherId?: string, harnessConfigId?: string) {
    onClose();
    const isCompanion = !!parentSessionId;
    if (isCompanion) openCompanionPane('__loading__');
    const newId = await spawnTerminal(appId, launcherId, harnessConfigId, isClaudeMode ? 'interactive' : undefined, isCompanion);
    if (newId && parentSessionId) {
      await loadAllSessions();
      setTerminalCompanion(parentSessionId, newId);
    }
  }

  async function pickExisting(termSessionId: string) {
    onClose();
    if (parentSessionId) {
      openCompanionPane(termSessionId);
    } else {
      openSession(termSessionId);
    }
  }

  async function pickTmux(tmuxName: string) {
    onClose();
    const isCompanion = !!parentSessionId;
    if (isCompanion) openCompanionPane('__loading__');
    const newId = await attachTmuxSession(tmuxName, appId ?? undefined, isCompanion);
    if (newId && parentSessionId) {
      await loadAllSessions();
      setTerminalCompanion(parentSessionId, newId);
    }
  }

  function submitUrl(url: string) {
    const trimmed = url.trim();
    if (trimmed) {
      openUrlCompanion(trimmed);
      onClose();
    }
  }

  // URL mode: simple input for entering a URL
  if (isUrlMode) {
    return (
      <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div class="spotlight-container">
          <div class="spotlight-input-row">
            <span class="spotlight-search-icon">{'\u{1F310}'}</span>
            <input
              ref={inputRef}
              type="text"
              class="spotlight-input"
              placeholder="Enter URL to open in iframe..."
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                else if (e.key === 'Enter') { e.preventDefault(); submitUrl(query); }
              }}
            />
            <kbd class="spotlight-esc">esc</kbd>
          </div>
          {query.trim() && (
            <div class="spotlight-results" ref={listRef}>
              <div class="spotlight-category">Open</div>
              <div
                class="spotlight-result selected"
                onClick={() => submitUrl(query)}
              >
                <span class="spotlight-result-icon">{'\u{1F310}'}</span>
                <div class="spotlight-result-text">
                  <span class="spotlight-result-title">Open in iframe</span>
                  <span class="spotlight-result-subtitle">{query.trim()}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Build items
  const items: PickerItem[] = [];
  const targets = cachedTargets.value;
  const machines = targets.filter(t => !t.isHarness && !t.isSprite);
  const harnesses = targets.filter(t => t.isHarness);
  const sprites = targets.filter(t => t.isSprite);
  const sessions = allSessions.value;
  const existingTerminals = sessions.filter(
    (s) => s.permissionProfile === 'plain' && s.id !== parentSessionId && s.status !== 'failed'
  );

  // 1. New session (always first)
  items.push({
    id: '__new_local__',
    category: 'New',
    icon: isClaudeMode ? '\u{1F916}' : '\u{1F4BB}',
    title: isClaudeMode ? 'New Claude session' : 'New terminal',
    subtitle: 'Local',
    action: () => pickNew(),
  });

  // 2. Remote machines
  for (const t of machines) {
    items.push({
      id: `machine:${t.launcherId}`,
      category: 'Remote Machines',
      icon: '\u{1F5A5}\uFE0F',
      title: t.machineName || t.name,
      subtitle: t.online
        ? `${t.activeSessions}/${t.maxSessions} sessions`
        : 'offline',
      action: t.online ? () => pickNew(t.launcherId) : () => {},
      disabled: !t.online,
    });
  }

  // 3. Harnesses
  for (const t of harnesses) {
    items.push({
      id: `harness:${t.harnessConfigId || t.launcherId}`,
      category: 'Harnesses',
      icon: '\u{1F9EA}',
      title: t.name,
      subtitle: t.online
        ? `${t.activeSessions}/${t.maxSessions} sessions`
        : 'offline',
      action: t.online ? () => pickNew(t.launcherId, t.harnessConfigId || undefined) : () => {},
      disabled: !t.online,
    });
  }

  // 4. Sprites
  for (const t of sprites) {
    items.push({
      id: `sprite:${t.spriteConfigId || t.launcherId}`,
      category: 'Sprites',
      icon: '\u{2601}\uFE0F',
      title: t.name,
      subtitle: t.online
        ? `${t.hostname} \u00b7 ${t.activeSessions}/${t.maxSessions} sessions`
        : `${t.hostname} \u00b7 offline`,
      action: t.online ? () => pickNew(t.launcherId) : () => {},
      disabled: !t.online,
    });
  }

  // 5. Recent — terminals from MRU that are still alive
  {
    const mru = paneMruHistory.value;
    const aliveIds = new Set(existingTerminals.map(s => s.id));
    const recentIds: string[] = [];
    for (const entry of mru) {
      if (entry.type === 'tab' && aliveIds.has(entry.sessionId) && recentIds.length < 5) {
        recentIds.push(entry.sessionId);
      }
    }
    for (const rid of recentIds) {
      const s = sessions.find(x => x.id === rid);
      if (!s) continue;
      const label = s.feedbackTitle || (s.paneCommand
        ? `${s.paneCommand}:${s.panePath || ''}`
        : (s.paneTitle || `pw-${s.id.slice(-6)}`));
      items.push({
        id: `recent:${rid}`,
        category: 'Recent',
        icon: '\u{1F552}',
        title: label,
        subtitle: s.id.slice(-8),
        action: () => pickExisting(rid),
      });
    }
  }

  // 6. Open terminals (excludes parent in companion mode)
  {
    const recentSet = new Set(items.filter(i => i.category === 'Recent').map(i => i.id.replace('recent:', '')));
    for (const s of existingTerminals) {
      if (recentSet.has(s.id)) continue;
      const label = s.feedbackTitle || (s.paneCommand
        ? `${s.paneCommand}:${s.panePath || ''}`
        : (s.paneTitle || `pw-${s.id.slice(-6)}`));
      items.push({
        id: `open:${s.id}`,
        category: 'Open Terminals',
        icon: '\u{1F4BB}',
        title: label,
        subtitle: s.id.slice(-8),
        action: () => pickExisting(s.id),
      });
    }
  }

  // 7. Tmux sessions
  for (const s of tmuxSessions) {
    items.push({
      id: `tmux:${s.name}`,
      category: 'Tmux Sessions',
      icon: '\u{1F4DF}',
      title: s.name,
      subtitle: `${s.windows} window${s.windows !== 1 ? 's' : ''}${s.attached ? ', attached' : ''}`,
      action: () => pickTmux(s.name),
    });
  }

  // 7. Isolated components
  for (const name of getIsolateNames()) {
    const entry = getIsolateEntry(name);
    items.push({
      id: `isolate:${name}`,
      category: 'Isolated Components',
      icon: '\u{1F9CA}',
      title: entry?.label || name,
      subtitle: 'Component isolation',
      action: () => { openIsolateCompanion(name); onClose(); },
    });
  }

  // 8. Open URL iframe
  items.push({
    id: '__open_url__',
    category: 'Iframe',
    icon: '\u{1F310}',
    title: 'Open URL...',
    subtitle: 'Load any URL in an iframe tab',
    action: () => { setQuery(''); setInternalUrlMode(true); },
  });

  // Filter by query
  const lower = query.toLowerCase();
  const filtered = lower
    ? items.filter(i => i.title.toLowerCase().includes(lower) || (i.subtitle?.toLowerCase().includes(lower)))
    : items;

  // If query looks like a URL, prepend an "Open in iframe" result
  const queryIsUrl = looksLikeUrl(query);
  const urlItem: PickerItem | null = queryIsUrl ? {
    id: '__url_query__',
    category: 'Iframe',
    icon: '\u{1F310}',
    title: 'Open in iframe',
    subtitle: query.trim(),
    action: () => submitUrl(query),
  } : null;

  // Group by category
  const grouped: [string, PickerItem[]][] = [];
  if (urlItem) grouped.push(['Iframe', [urlItem]]);
  const categoryOrder = ['New', 'Remote Machines', 'Harnesses', 'Sprites', 'Recent', 'Open Terminals', 'Tmux Sessions', 'Isolated Components', 'Iframe'];
  for (const cat of categoryOrder) {
    if (cat === 'Iframe' && urlItem) continue;
    const catItems = filtered.filter(i => i.category === cat);
    if (catItems.length > 0) grouped.push([cat, catItems]);
  }

  // Flat list for keyboard nav
  const flatFiltered = grouped.flatMap(([, items]) => items);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector('.spotlight-result.selected') as HTMLElement;
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flatFiltered[selectedIndex]) {
        flatFiltered[selectedIndex].action();
      }
    }
  }

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spotlight-container">
        <div class="spotlight-input-row">
          <span class="spotlight-search-icon">{'\u{1F50D}'}</span>
          <input
            ref={inputRef}
            type="text"
            class="spotlight-input"
            placeholder={mode.kind === 'companion' ? 'Pick a terminal companion...' : isClaudeMode ? 'Start a Claude session...' : 'Open a terminal or paste a URL...'}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
          />
          {tmuxLoading && <span class="spotlight-spinner" />}
          <kbd class="spotlight-esc">esc</kbd>
        </div>
        {flatFiltered.length > 0 && (
          <div class="spotlight-results" ref={listRef}>
            {grouped.map(([category, catItems]) => (
              <div key={category}>
                <div class="spotlight-category">{category}</div>
                {catItems.map((item) => {
                  const globalIdx = flatFiltered.indexOf(item);
                  return (
                    <div
                      key={item.id}
                      class={`spotlight-result ${globalIdx === selectedIndex ? 'selected' : ''}`}
                      style={item.disabled ? 'opacity:0.5;cursor:default' : undefined}
                      onClick={() => item.action()}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                    >
                      <span class="spotlight-result-icon">{item.icon}</span>
                      <div class="spotlight-result-text">
                        <span class="spotlight-result-title">
                          {item.title}
                          {item.disabled && <span style="margin-left:6px;color:var(--pw-text-muted);font-size:11px">(offline)</span>}
                        </span>
                        {item.subtitle && <span class="spotlight-result-subtitle">{item.subtitle}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {query && flatFiltered.length === 0 && (
          <div class="spotlight-empty">No matching terminals</div>
        )}
      </div>
    </div>
  );
}
