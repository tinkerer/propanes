import { useState, useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { cachedTargets, ensureTargetsLoaded, type DispatchTarget } from './DispatchTargetSelect.js';
import { navigate } from '../lib/state.js';

export const dispatchPickerOpen = signal(false);
export const dispatchPickerResult = signal<string>('');

interface PickerItem {
  id: string;
  category: string;
  icon: string;
  title: string;
  subtitle?: string;
  launcherId: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  onSelect: (launcherId: string) => void;
  onClose: () => void;
}

export function DispatchPicker({ value, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    ensureTargetsLoaded();
  }, []);

  const targets = cachedTargets.value;
  const machines = targets.filter(t => !t.isHarness && !t.isSprite);
  const harnesses = targets.filter(t => t.isHarness);
  const sprites = targets.filter(t => t.isSprite);

  const items: PickerItem[] = [];

  items.push({
    id: '__local__',
    category: 'Targets',
    icon: '\u{1F4BB}',
    title: 'Local',
    subtitle: 'Run on this machine',
    launcherId: '',
  });

  for (const t of machines) {
    items.push({
      id: `machine:${t.launcherId}`,
      category: 'Remote Machines',
      icon: '\u{1F5A5}\uFE0F',
      title: t.machineName || t.name,
      subtitle: t.online
        ? `${t.hostname} \u00b7 ${t.activeSessions}/${t.maxSessions} sessions`
        : `${t.hostname} \u00b7 offline`,
      launcherId: t.launcherId,
      disabled: !t.online,
    });
  }

  for (const t of harnesses) {
    items.push({
      id: `harness:${t.harnessConfigId || t.launcherId}`,
      category: 'Harnesses',
      icon: '\u{1F9EA}',
      title: t.name,
      subtitle: t.online
        ? `${t.activeSessions}/${t.maxSessions} sessions`
        : 'offline',
      launcherId: t.launcherId,
      disabled: !t.online,
    });
  }

  for (const t of sprites) {
    items.push({
      id: `sprite:${t.spriteConfigId || t.launcherId}`,
      category: 'Sprites',
      icon: '\u{2601}\uFE0F',
      title: t.name,
      subtitle: t.online
        ? `${t.hostname} \u00b7 ${t.activeSessions}/${t.maxSessions} sessions`
        : `${t.hostname} \u00b7 offline`,
      launcherId: t.launcherId,
      disabled: !t.online,
    });
  }

  // Setup options
  items.push({
    id: '__setup_machine__',
    category: 'Setup',
    icon: '\u{2795}',
    title: 'Add remote machine...',
    subtitle: 'Register a new machine for dispatch',
    launcherId: '__nav_machines__',
  });
  items.push({
    id: '__setup_harness__',
    category: 'Setup',
    icon: '\u{2795}',
    title: 'Add harness config...',
    subtitle: 'Create a Docker harness for isolated testing',
    launcherId: '__nav_harnesses__',
  });
  items.push({
    id: '__setup_sprite__',
    category: 'Setup',
    icon: '\u{2795}',
    title: 'Add sprite config...',
    subtitle: 'Create a Fly.io Sprite for cloud dispatch',
    launcherId: '__nav_sprites__',
  });

  const lower = query.toLowerCase();
  const filtered = lower
    ? items.filter(i => i.title.toLowerCase().includes(lower) || (i.subtitle?.toLowerCase().includes(lower)))
    : items;

  const categoryOrder = ['Targets', 'Remote Machines', 'Harnesses', 'Sprites', 'Setup'];
  const grouped: [string, PickerItem[]][] = [];
  for (const cat of categoryOrder) {
    const catItems = filtered.filter(i => i.category === cat);
    if (catItems.length > 0) grouped.push([cat, catItems]);
  }

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

  function pick(item: PickerItem) {
    if (item.disabled) return;
    if (item.launcherId === '__nav_machines__') {
      navigate('/settings/machines');
      onClose();
      return;
    }
    if (item.launcherId === '__nav_harnesses__') {
      navigate('/settings/harnesses');
      onClose();
      return;
    }
    if (item.launcherId === '__nav_sprites__') {
      navigate('/settings/sprites');
      onClose();
      return;
    }
    onSelect(item.launcherId);
    onClose();
  }

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
      if (flatFiltered[selectedIndex]) pick(flatFiltered[selectedIndex]);
    }
  }

  // Mark the currently selected target
  function isCurrentTarget(item: PickerItem): boolean {
    return item.launcherId === value;
  }

  return (
    <div class="spotlight-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spotlight-container">
        <div class="spotlight-input-row">
          <span class="spotlight-search-icon">{'\u{1F3AF}'}</span>
          <input
            ref={inputRef}
            type="text"
            class="spotlight-input"
            placeholder="Pick a dispatch target..."
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
          />
          <kbd class="spotlight-esc">esc</kbd>
        </div>
        {flatFiltered.length > 0 && (
          <div class="spotlight-results" ref={listRef}>
            {grouped.map(([category, catItems]) => (
              <div key={category}>
                <div class="spotlight-category">{category}</div>
                {catItems.map((item) => {
                  const globalIdx = flatFiltered.indexOf(item);
                  const current = isCurrentTarget(item);
                  return (
                    <div
                      key={item.id}
                      class={`spotlight-result ${globalIdx === selectedIndex ? 'selected' : ''}`}
                      style={item.disabled ? 'opacity:0.5;cursor:default' : undefined}
                      onClick={() => pick(item)}
                      onMouseEnter={() => setSelectedIndex(globalIdx)}
                    >
                      <span class="spotlight-result-icon">{item.icon}</span>
                      <div class="spotlight-result-text">
                        <span class="spotlight-result-title">
                          {item.title}
                          {current && <span style="margin-left:6px;color:var(--pw-accent);font-size:11px">(current)</span>}
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
          <div class="spotlight-empty">No matching targets</div>
        )}
      </div>
    </div>
  );
}

export function DispatchTargetButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (launcherId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const targets = cachedTargets.value;

  useEffect(() => {
    ensureTargetsLoaded();
  }, []);

  const selectedTarget = value ? targets.find(t => t.launcherId === value) : null;
  const label = selectedTarget
    ? (selectedTarget.machineName || selectedTarget.name)
    : 'Local';

  return (
    <>
      <button
        class="btn dispatch-target-btn"
        onClick={() => setOpen(true)}
        title="Select dispatch target"
      >
        <span class="dispatch-target-icon">{selectedTarget?.isSprite ? '\u{2601}\uFE0F' : selectedTarget?.isHarness ? '\u{1F9EA}' : selectedTarget ? '\u{1F5A5}\uFE0F' : '\u{1F4BB}'}</span>
        <span class="dispatch-target-label">{label}</span>
        <span class="dispatch-target-chevron">{'\u25BE'}</span>
      </button>
      {open && (
        <DispatchPicker
          value={value}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
