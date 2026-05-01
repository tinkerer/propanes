import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openFileCompanion } from '../lib/sessions.js';

type Entry = { name: string; type: 'file' | 'dir'; size?: number; ext?: string };
type GitFile = { path: string; status: string; staged: string; unstaged: string };

const STATUS_COLORS: Record<string, string> = {
  modified: '#e5c07b',
  added: '#98c379',
  deleted: '#e06c75',
  untracked: '#888',
  renamed: '#61afef',
};

const STATUS_LETTERS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: '??',
  renamed: 'R',
};

interface Props {
  appId: string | null;
  open: boolean;
  onToggle: () => void;
}

export function SidebarFilesDrawer({ appId, open, onToggle }: Props) {
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allExpanded, setAllExpanded] = useState(false);
  const treeControlsRef = useRef<{ expandAll: () => void; collapseAll: () => void } | null>(null);

  useEffect(() => {
    if (!appId) { setProjectDir(null); return; }
    api.browseFiles(appId).then((r) => {
      setProjectDir(r.path);
      setError(null);
    }).catch((e: any) => setError(e.message));
  }, [appId]);

  return (
    <div class="sidebar-files-drawer" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', flex: open && appId ? 1 : 'none' }}>
      <div class="sidebar-files-header">
        {tab === 'files' && open && appId && (
          <button
            class="sidebar-file-tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              if (allExpanded) treeControlsRef.current?.collapseAll();
              else treeControlsRef.current?.expandAll();
            }}
            title={allExpanded ? 'Collapse all' : 'Expand all'}
          >
            {allExpanded ? '\u25BC' : '\u25B6'} All
          </button>
        )}
        <div style={{ flex: 1 }} />
        <div class="sidebar-files-tab-switcher" onClick={(e) => e.stopPropagation()}>
          <button class={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>{'\u{1F4C1}'}</button>
          <button class={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>{'\u{1F504}'}</button>
        </div>
      </div>
      {open && appId && (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {error ? (
            <div style={{ padding: '8px 12px', color: '#e06c75', fontSize: '12px' }}>{error}</div>
          ) : tab === 'files' ? (
            <SidebarFileTree appId={appId} projectDir={projectDir} controlsRef={treeControlsRef} onAllExpandedChange={setAllExpanded} />
          ) : (
            <SidebarGitChanges appId={appId} projectDir={projectDir} />
          )}
        </div>
      )}
    </div>
  );
}

interface SidebarFileTreeProps {
  appId: string;
  projectDir: string | null;
  controlsRef: { current: { expandAll: () => void; collapseAll: () => void } | null };
  onAllExpandedChange: (v: boolean) => void;
}

function SidebarFileTree({ appId, projectDir, controlsRef, onAllExpandedChange }: SidebarFileTreeProps) {
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Map<string, Entry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);
  const cache = useRef<Map<string, Entry[]>>(new Map());
  const [loaded, setLoaded] = useState(false);

  const loadDir = useCallback(async (path: string): Promise<Entry[]> => {
    if (cache.current.has(path)) return cache.current.get(path)!;
    const result = await api.browseFiles(appId, path === '.' ? undefined : path);
    cache.current.set(path, result.entries);
    return result.entries;
  }, [appId]);

  useEffect(() => {
    setLoaded(false);
    setCurrentPath('.');
    setEntries([]);
    setExpandedDirs(new Map());
    cache.current.clear();
  }, [appId]);

  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    setLoading((p) => new Set([...p, '__root__']));
    loadDir('.').then((e) => {
      setEntries(e);
      setLoading((p) => { const n = new Set(p); n.delete('__root__'); return n; });
    }).catch(() => {
      setLoading((p) => { const n = new Set(p); n.delete('__root__'); return n; });
    });
  }, [loaded, loadDir]);

  async function toggleDir(dirPath: string) {
    if (expandedDirs.has(dirPath)) {
      setExpandedDirs((prev) => { const n = new Map(prev); n.delete(dirPath); return n; });
      return;
    }
    setLoading((p) => new Set([...p, dirPath]));
    try {
      const items = await loadDir(dirPath);
      setExpandedDirs((prev) => new Map(prev).set(dirPath, items));
    } finally {
      setLoading((p) => { const n = new Set(p); n.delete(dirPath); return n; });
    }
  }

  async function expandAll() {
    const queue = [...entries.filter((e) => e.type === 'dir').map((e) => e.name)];
    const newExpanded = new Map(expandedDirs);
    while (queue.length > 0) {
      const batch = queue.splice(0, 10);
      const results = await Promise.all(batch.map(async (p) => {
        if (newExpanded.has(p)) return { path: p, entries: newExpanded.get(p)! };
        const items = await loadDir(p);
        return { path: p, entries: items };
      }));
      for (const r of results) {
        newExpanded.set(r.path, r.entries);
        for (const e of r.entries) {
          if (e.type === 'dir') {
            const childPath = r.path === '.' ? e.name : `${r.path}/${e.name}`;
            if (!newExpanded.has(childPath)) queue.push(childPath);
          }
        }
      }
    }
    setExpandedDirs(newExpanded);
    setAllExpanded(true);
    onAllExpandedChange(true);
  }

  function collapseAll() {
    setExpandedDirs(new Map());
    setAllExpanded(false);
    onAllExpandedChange(false);
  }

  controlsRef.current = { expandAll, collapseAll };

  function handleFileClick(entryPath: string) {
    if (!projectDir) return;
    openFileCompanion(`${projectDir}/${entryPath}`);
  }

  function renderEntries(items: Entry[], parentPath: string, depth: number): any[] {
    return items.map((entry) => {
      const entryPath = parentPath === '.' ? entry.name : `${parentPath}/${entry.name}`;
      const isDir = entry.type === 'dir';
      const isExpanded = expandedDirs.has(entryPath);
      const isLoading = loading.has(entryPath);
      const children = expandedDirs.get(entryPath);
      return (
        <div key={entryPath}>
          <div
            class={`sidebar-file-entry${isDir ? ' dir' : ''}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => isDir ? toggleDir(entryPath) : handleFileClick(entryPath)}
          >
            {isDir && (
              <span class={`sidebar-file-chevron${isExpanded ? ' expanded' : ''}`}>
                {isLoading ? '\u23F3' : '\u25B6'}
              </span>
            )}
            <span class="sidebar-file-icon">{isDir ? '\u{1F4C1}' : '\u{1F4C4}'}</span>
            <span class="sidebar-file-name">{entry.name}</span>
          </div>
          {isExpanded && children && renderEntries(children, entryPath, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div class="sidebar-file-tree">
      {loading.has('__root__') ? (
        <div style={{ padding: '8px 12px', color: '#64748b', fontSize: '12px' }}>Loading...</div>
      ) : (
        renderEntries(entries, currentPath, 0)
      )}
    </div>
  );
}

function SidebarGitChanges({ appId, projectDir }: { appId: string; projectDir: string | null }) {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [showAllDiffs, setShowAllDiffs] = useState(false);
  const [allDiffs, setAllDiffs] = useState<Map<string, string>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const loadStatus = useCallback(async () => {
    try {
      const result = await api.gitStatus(appId);
      setIsGitRepo(result.isGitRepo);
      setBranch(result.branch);
      setFiles(result.files);
    } catch { /* ignore */ }
  }, [appId]);

  useEffect(() => {
    loadStatus();
    pollRef.current = setInterval(() => { if (!document.hidden) loadStatus(); }, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadStatus]);

  useEffect(() => {
    if (!showAllDiffs || files.length === 0) return;
    let cancelled = false;
    (async () => {
      const newDiffs = new Map<string, string>();
      for (const f of files) {
        if (cancelled) break;
        try {
          const result = await api.gitDiff(appId, f.path);
          newDiffs.set(f.path, result.diff || '');
        } catch { /* ignore */ }
      }
      if (!cancelled) setAllDiffs(newDiffs);
    })();
    return () => { cancelled = true; };
  }, [showAllDiffs, files, appId]);

  async function viewDiff(filePath: string) {
    if (selectedFile === filePath) { setSelectedFile(null); setDiff(null); return; }
    setSelectedFile(filePath);
    setDiffLoading(true);
    try {
      const result = await api.gitDiff(appId, filePath);
      setDiff(result.diff || '(no changes)');
    } catch (e: any) {
      setDiff(`Error: ${e.message}`);
    } finally {
      setDiffLoading(false);
    }
  }

  function openFile(filePath: string) {
    if (!projectDir) return;
    openFileCompanion(`${projectDir}/${filePath}`);
  }

  if (!isGitRepo) return <div style={{ padding: '8px 12px', color: '#64748b', fontSize: '12px' }}>Not a git repo</div>;

  return (
    <div class="sidebar-git-changes">
      <div class="sidebar-git-header">
        {branch && <span class="sidebar-git-branch">{'\u{1F33F}'} {branch}</span>}
        <span style={{ color: '#64748b', fontSize: '11px' }}>{files.length} change{files.length !== 1 ? 's' : ''}</span>
        <div style={{ flex: 1 }} />
        <label class="sidebar-git-auto-label" title="Show inline diffs for all files">
          <input type="checkbox" checked={showAllDiffs} onChange={(e) => setShowAllDiffs((e.target as HTMLInputElement).checked)} />
          <span>auto</span>
        </label>
        <button class="sidebar-git-refresh" onClick={loadStatus} title="Refresh">{'\u21BB'}</button>
      </div>
      {files.length === 0 && <div style={{ padding: '8px 12px', color: '#64748b', fontSize: '12px' }}>Clean</div>}
      {files.map((file) => {
        const inlineDiff = showAllDiffs ? allDiffs.get(file.path) : null;
        const isSelected = selectedFile === file.path;
        return (
          <div key={file.path}>
            <div
              class={`sidebar-git-file${isSelected ? ' selected' : ''}`}
              onClick={() => viewDiff(file.path)}
            >
              <span class="sidebar-git-status" style={{ color: STATUS_COLORS[file.status] || '#888' }}>
                {STATUS_LETTERS[file.status] || '?'}
              </span>
              <span class="sidebar-git-path">{file.path}</span>
              <button class="sidebar-git-open" onClick={(e) => { e.stopPropagation(); openFile(file.path); }} title="Open file">{'\u2197'}</button>
            </div>
            {isSelected && !showAllDiffs && (
              <div class="sidebar-git-diff-inline">
                {diffLoading ? <div style={{ padding: '4px 8px', color: '#64748b', fontSize: '11px' }}>Loading...</div> : diff && renderDiffLines(diff)}
              </div>
            )}
            {showAllDiffs && inlineDiff && (
              <div class="sidebar-git-diff-inline">
                {renderDiffLines(inlineDiff)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderDiffLines(diff: string) {
  const lines = diff.split('\n');
  return (
    <div class="sidebar-diff-lines">
      {lines.map((line, i) => {
        let cls = 'sidebar-diff-line';
        if (line.startsWith('+') && !line.startsWith('+++')) cls += ' added';
        else if (line.startsWith('-') && !line.startsWith('---')) cls += ' removed';
        else if (line.startsWith('@@')) cls += ' hunk';
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls += ' meta';
        return <div key={i} class={cls}>{line || ' '}</div>;
      })}
    </div>
  );
}
