import { getAllShortcuts } from '../lib/shortcuts.js';

interface Props {
  onClose: () => void;
}

export function ShortcutHelpModal({ onClose }: Props) {
  const shortcuts = getAllShortcuts();

  const categories = ['Navigation', 'Panels', 'General'] as const;
  const grouped = new Map<string, typeof shortcuts>();
  for (const cat of categories) {
    grouped.set(cat, shortcuts.filter((s) => s.category === cat));
  }

  function formatKey(s: (typeof shortcuts)[0]): string {
    const parts: string[] = [];
    if (s.modifiers?.ctrl) parts.push('Ctrl');
    // Skip showing Shift for keys that inherently require it (e.g. ?, !, @)
    if (s.modifiers?.shift && /^[a-zA-Z0-9 ]$/.test(s.key)) parts.push('Shift');
    if (s.modifiers?.alt) parts.push('Alt');
    if (s.modifiers?.meta) parts.push('Cmd');
    if (s.sequence) return s.sequence;
    parts.push(s.key === ' ' ? 'Space' : s.key);
    return parts.join('+');
  }

  return (
    <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal shortcut-help-modal">
        <h3>Keyboard Shortcuts</h3>
        {categories.map((cat) => {
          const items = grouped.get(cat);
          if (!items || items.length === 0) return null;
          return (
            <div key={cat} class="shortcut-section">
              <h4>{cat}</h4>
              {items.map((s) => {
                const keyStr = formatKey(s);
                const parts = keyStr.split(' ');
                return (
                  <div key={keyStr + s.label} class="shortcut-row">
                    <span class="shortcut-label">{s.label}</span>
                    <span class="shortcut-keys">
                      {parts.map((p, i) => (
                        <>
                          {i > 0 && <span class="then">then</span>}
                          <kbd>{p}</kbd>
                        </>
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
        <div class="modal-actions">
          <button class="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
