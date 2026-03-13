import { useState, useCallback, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openFileCompanion } from '../lib/sessions.js';

type Entry = { name: string; type: 'file' | 'dir'; size?: number; ext?: string };

const FILE_ICONS: Record<string, string> = {
  ts: '\u{1F1F9}', tsx: '\u{1F1F9}', js: '\u{1F1EF}', jsx: '\u{1F1EF}',
  py: '\u{1F40D}', rs: '\u{1F980}', go: '\u{1F439}',
  json: '{}', yaml: '\u2699', yml: '\u2699', toml: '\u2699',
  md: '\u{1F4DD}', txt: '\u{1F4C4}',
  css: '\u{1F3A8}', scss: '\u{1F3A8}', html: '\u{1F310}',
  png: '\u{1F5BC}', jpg: '\u{1F5BC}', jpeg: '\u{1F5BC}', gif: '\u{1F5BC}', svg: '\u{1F5BC}', webp: '\u{1F5BC}',
  sh: '\u{1F4BB}', bash: '\u{1F4BB}',
};

function getFileIcon(entry: Entry): string {
  if (entry.type === 'dir') return '\u{1F4C1}';
  return FILE_ICONS[entry.ext || ''] || '\u{1F4C4}';
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  appId: string;
  projectDir: string;
}

export function FileTree({ appId, projectDir }: Props) {
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Map<string, Entry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>(['.']);
  const cache = useRef<Map<string, { entries: Entry[]; parent: string | null }>>(new Map());
  const [rootLoaded, setRootLoaded] = useState(false);

  const loadDir = useCallback(async (path: string) => {
    if (cache.current.has(path)) {
      const cached = cache.current.get(path)!;
      return cached;
    }
    const result = await api.browseFiles(appId, path === '.' ? undefined : path);
    const data = { entries: result.entries, parent: result.parent };
    cache.current.set(path, data);
    return data;
  }, [appId]);

  const navigateTo = useCallback(async (path: string) => {
    setError(null);
    setLoading((prev) => new Set([...prev, '__root__']));
    try {
      const data = await loadDir(path);
      setEntries(data.entries);
      setCurrentPath(path);
      setExpandedDirs(new Map());

      const parts = path === '.' ? ['.'] : ['.', ...path.split('/').reduce<string[]>((acc, part) => {
        const prev = acc.length > 0 ? acc[acc.length - 1] : '.';
        acc.push(prev === '.' ? part : `${prev}/${part}`);
        return acc;
      }, [])];
      setBreadcrumbs(parts);
    } catch (err: any) {
      setError(err.message || 'Failed to load directory');
    } finally {
      setLoading((prev) => { const next = new Set(prev); next.delete('__root__'); return next; });
    }
  }, [loadDir]);

  if (!rootLoaded) {
    setRootLoaded(true);
    navigateTo('.');
  }

  async function toggleDir(dirPath: string) {
    if (expandedDirs.has(dirPath)) {
      setExpandedDirs((prev) => { const next = new Map(prev); next.delete(dirPath); return next; });
      return;
    }
    setLoading((prev) => new Set([...prev, dirPath]));
    try {
      const data = await loadDir(dirPath);
      setExpandedDirs((prev) => new Map(prev).set(dirPath, data.entries));
    } catch (err: any) {
      setError(err.message || 'Failed to load directory');
    } finally {
      setLoading((prev) => { const next = new Set(prev); next.delete(dirPath); return next; });
    }
  }

  function handleFileClick(filePath: string) {
    const absPath = `${projectDir}/${filePath}`;
    openFileCompanion(absPath);
  }

  function renderEntries(items: Entry[], parentPath: string, depth: number) {
    return items.map((entry) => {
      const entryPath = parentPath === '.' ? entry.name : `${parentPath}/${entry.name}`;
      const isDir = entry.type === 'dir';
      const isExpanded = expandedDirs.has(entryPath);
      const isLoading = loading.has(entryPath);
      const childEntries = expandedDirs.get(entryPath);

      return (
        <div key={entryPath}>
          <div
            class={`file-tree-entry${isDir ? ' dir' : ' file'}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => isDir ? toggleDir(entryPath) : handleFileClick(entryPath)}
          >
            {isDir && (
              <span class={`file-tree-chevron${isExpanded ? ' expanded' : ''}`}>
                {isLoading ? '\u23F3' : '\u25B6'}
              </span>
            )}
            <span class="file-tree-icon">{getFileIcon(entry)}</span>
            <span class="file-tree-name">{entry.name}</span>
            {!isDir && entry.size != null && (
              <span class="file-tree-size">{formatSize(entry.size)}</span>
            )}
          </div>
          {isExpanded && childEntries && renderEntries(childEntries, entryPath, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div class="file-tree">
      <div class="file-tree-breadcrumbs">
        {breadcrumbs.map((crumb, i) => {
          const label = crumb === '.' ? projectDir.split('/').pop() || 'root' : crumb.split('/').pop()!;
          const isLast = i === breadcrumbs.length - 1;
          return (
            <span key={crumb}>
              {i > 0 && <span class="file-tree-sep">/</span>}
              {isLast
                ? <span class="file-tree-crumb active">{label}</span>
                : <a class="file-tree-crumb" onClick={() => navigateTo(crumb)}>{label}</a>
              }
            </span>
          );
        })}
      </div>
      {error && <div class="file-tree-error">{error}</div>}
      {loading.has('__root__') ? (
        <div class="file-tree-loading">Loading...</div>
      ) : (
        <div class="file-tree-entries">
          {entries.length === 0 ? (
            <div class="file-tree-empty">Empty directory</div>
          ) : (
            renderEntries(entries, currentPath, 0)
          )}
        </div>
      )}
    </div>
  );
}
