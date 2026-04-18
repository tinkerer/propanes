import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';

interface DirPickerProps {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
}

export function DirPicker({ value, onInput, placeholder }: DirPickerProps) {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function browse(path?: string) {
    setLoading(true);
    setError('');
    try {
      const res = await api.browseDirs(path);
      setBrowsePath(res.path);
      setParent(res.parent);
      setDirs(res.dirs);
    } catch (err: any) {
      setError(err.message || 'Failed to browse');
    } finally {
      setLoading(false);
    }
  }

  function handleOpen() {
    setOpen(true);
    browse(value || undefined);
  }

  function selectDir(name: string) {
    const full = browsePath + '/' + name;
    onInput(full);
    setOpen(false);
  }

  function selectCurrent() {
    onInput(browsePath);
    setOpen(false);
  }

  function goUp() {
    if (parent) browse(parent);
  }

  return (
    <div class="dir-picker" ref={containerRef}>
      <div class="dir-picker-input-row">
        <input
          type="text"
          value={value}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)}
          placeholder={placeholder}
          style={{ flex: 1 }}
        />
        <button type="button" class="btn btn-small" onClick={handleOpen} title="Browse directories">
          ...
        </button>
      </div>
      {open && (
        <div class="dir-picker-dropdown">
          <div class="dir-picker-path">
            {parent && (
              <button type="button" class="dir-picker-up" onClick={goUp} title="Go up">
                ..
              </button>
            )}
            <span class="dir-picker-current" title={browsePath}>{browsePath}</span>
            <button type="button" class="btn btn-small btn-primary" onClick={selectCurrent} style={{ marginLeft: 'auto', flexShrink: 0 }}>
              Select
            </button>
          </div>
          {loading && <div class="dir-picker-status">Loading...</div>}
          {error && <div class="dir-picker-status" style={{ color: 'var(--pw-danger)' }}>{error}</div>}
          {!loading && !error && dirs.length === 0 && (
            <div class="dir-picker-status">No subdirectories</div>
          )}
          {!loading && !error && (
            <div class="dir-picker-list">
              {dirs.map((d) => (
                <div class="dir-picker-item" key={d}>
                  <button
                    type="button"
                    class="dir-picker-name"
                    onClick={() => selectDir(d)}
                    title={`Select ${browsePath}/${d}`}
                  >
                    {d}
                  </button>
                  <button
                    type="button"
                    class="dir-picker-enter"
                    onClick={() => browse(browsePath + '/' + d)}
                    title={`Browse into ${d}`}
                  >
                    &rarr;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
