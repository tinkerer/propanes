import { useState, useEffect, useRef } from 'preact/hooks';
import { allSessions, paneMruHistory, spawnTerminal, attachTmuxSession, setTerminalCompanionAndOpen, loadAllSessions, openSession, openIsolateCompanion } from '../lib/sessions.js';
import { selectedAppId } from '../lib/state.js';
import { getIsolateNames, getIsolateEntry } from '../lib/isolate.js';
import { cachedTargets, ensureTargetsLoaded } from './DispatchTargetSelect.js';
import { api } from '../lib/api.js';

export type TerminalPickerMode =
  | { kind: 'companion'; sessionId: string }
  | { kind: 'new' };

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
}

export function TerminalPicker({ mode, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tmuxSessions, setTmuxSessions] = useState<{ name: string; windows: number; created: string; attached: boolean }[]>([]);
  const [tmuxLoading, setTmuxLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    ensureTargetsLoaded();
    setTmuxLoading(true);
    api.listTmuxSessions()
      .then((r) => setTmuxSessions(r.sessions))
      .catch(() => setTmuxSessions([]))
      .finally(() => setTmuxLoading(false));
  }, []);

  const parentSessionId = mode.kind === 'companion' ? mode.sessionId : null;
  const appId = selectedAppId.value;

  async function pickNew(launcherId?: string, harnessConfigId?: string) {
    const newId = await spawnTerminal(appId, launcherId, harnessConfigId);
    if (newId && parentSessionId) {
      await loadAllSessions();
      setTerminalCompanionAndOpen(parentSessionId, newId);
    }
    onClose();
  }

  async function pickExisting(termSessionId: string) {
    if (parentSessionId) {
      setTerminalCompanionAndOpen(parentSessionId, termSessionId);
    } else {
      openSession(termSessionId);
    }
    onClose();
  }

  async function pickTmux(tmuxName: string) {
    const newId = await attachTmuxSession(tmuxName, appId ?? undefined);
    if (newId && parentSessionId) {
      await loadAllSessions();
      setTerminalCompanionAndOpen(parentSessionId, newId);
    }
    onClose();
  }

  // Build items
  const items: PickerItem[] = [];
  const targets = cachedTargets.value;
  const machines = targets.filter(t => !t.isHarness);
  const harnesses = targets.filter(t => t.isHarness);
  const sessions = allSessions.value;
  const existingTerminals = sessions.filter(
    (s) => s.permissionProfile === 'plain' && s.id !== parentSessionId && s.status !== 'failed'
  );

  // 1. New terminal (always first)
  items.push({
    id: '__new_local__',
    category: 'New',
    icon: '\u{1F4BB}',
    title: 'New terminal',
    subtitle: 'Local',
    action: () => pickNew(),
  });

  // 2. Recent — terminals from MRU that are still alive
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
      const label = s.paneCommand
        ? `${s.paneCommand}:${s.panePath || ''}`
        : (s.paneTitle || `pw-${s.id.slice(-6)}`);
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

  // 3. Remote machines
  for (const t of machines) {
    items.push({
      id: `machine:${t.launcherId}`,
      category: 'Remote Machines',
      icon: '\u{1F5A5}\uFE0F',
      title: t.machineName || t.name,
      subtitle: `${t.activeSessions}/${t.maxSessions} sessions`,
      action: () => pickNew(t.launcherId),
    });
  }

  // 4. Harnesses
  for (const t of harnesses) {
    items.push({
      id: `harness:${t.harnessConfigId || t.launcherId}`,
      category: 'Harnesses',
      icon: '\u{1F9EA}',
      title: t.name,
      subtitle: `${t.activeSessions}/${t.maxSessions} sessions`,
      action: () => pickNew(t.launcherId, t.harnessConfigId || undefined),
    });
  }

  // 5. Open terminals (excludes parent in companion mode)
  {
    const recentSet = new Set(items.filter(i => i.category === 'Recent').map(i => i.id.replace('recent:', '')));
    for (const s of existingTerminals) {
      if (recentSet.has(s.id)) continue;
      const label = s.paneCommand
        ? `${s.paneCommand}:${s.panePath || ''}`
        : (s.paneTitle || `pw-${s.id.slice(-6)}`);
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

  // 6. Tmux sessions
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

  // Filter by query
  const lower = query.toLowerCase();
  const filtered = lower
    ? items.filter(i => i.title.toLowerCase().includes(lower) || (i.subtitle?.toLowerCase().includes(lower)))
    : items;

  // Group by category
  const grouped: [string, PickerItem[]][] = [];
  const categoryOrder = ['New', 'Recent', 'Remote Machines', 'Harnesses', 'Open Terminals', 'Tmux Sessions', 'Isolated Components'];
  for (const cat of categoryOrder) {
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
            placeholder={mode.kind === 'companion' ? 'Pick a terminal companion...' : 'Open a terminal...'}
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
                      onClick={() => item.action()}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                    >
                      <span class="spotlight-result-icon">{item.icon}</span>
                      <div class="spotlight-result-text">
                        <span class="spotlight-result-title">{item.title}</span>
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
