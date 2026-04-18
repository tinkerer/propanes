import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import { api } from '../lib/api.js';
import { openFileCompanion } from '../lib/sessions.js';

interface GitFile {
  path: string;
  status: string;
  staged: string;
  unstaged: string;
}

const STATUS_COLORS: Record<string, string> = {
  modified: '#e5c07b',
  added: '#98c379',
  deleted: '#e06c75',
  untracked: '#888',
  renamed: '#61afef',
  copied: '#56b6c2',
};

const STATUS_LETTERS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: '??',
  renamed: 'R',
  copied: 'C',
};

interface Props {
  appId: string;
  projectDir: string;
  onFileCount?: (count: number) => void;
}

export function GitChangesView({ appId, projectDir, onFileCount }: Props) {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [isGitRepo, setIsGitRepo] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const loadStatus = useCallback(async () => {
    try {
      const result = await api.gitStatus(appId);
      setIsGitRepo(result.isGitRepo);
      setBranch(result.branch);
      setFiles(result.files);
      onFileCount?.(result.files.length);
    } catch (err: any) {
      setError(err.message);
    }
  }, [appId, onFileCount]);

  useEffect(() => {
    loadStatus();
    pollRef.current = setInterval(loadStatus, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadStatus]);

  async function viewDiff(filePath: string) {
    setSelectedFile(filePath);
    setDiffLoading(true);
    setDiff(null);
    try {
      const result = await api.gitDiff(appId, filePath);
      setDiff(result.diff || '(no diff available)');
    } catch (err: any) {
      setDiff(`Error: ${err.message}`);
    } finally {
      setDiffLoading(false);
    }
  }

  function openFile(filePath: string) {
    openFileCompanion(`${projectDir}/${filePath}`);
  }

  if (!isGitRepo) {
    return <div class="git-changes-empty">Not a git repository</div>;
  }

  return (
    <div class="git-changes">
      <div class="git-changes-header">
        {branch && <span class="git-changes-branch">{'\u{1F33F}'} {branch}</span>}
        <span class="git-changes-count">{files.length} changed file{files.length !== 1 ? 's' : ''}</span>
        <button class="git-changes-refresh" onClick={loadStatus} title="Refresh">{'\u21BB'}</button>
      </div>
      {error && <div class="git-changes-error">{error}</div>}
      <div class="git-changes-list">
        {files.length === 0 && <div class="git-changes-clean">Working tree clean</div>}
        {files.map((file) => (
          <div
            key={file.path}
            class={`git-changes-file${selectedFile === file.path ? ' selected' : ''}`}
            onClick={() => viewDiff(file.path)}
          >
            <span
              class="git-changes-status"
              style={{ color: STATUS_COLORS[file.status] || '#888' }}
            >
              {STATUS_LETTERS[file.status] || file.staged + file.unstaged}
            </span>
            <span class="git-changes-path">{file.path}</span>
            <button
              class="git-changes-open"
              onClick={(e) => { e.stopPropagation(); openFile(file.path); }}
              title="Open file"
            >
              {'\u{1F4C4}'}
            </button>
          </div>
        ))}
      </div>
      {selectedFile && (
        <div class="git-diff-panel">
          <div class="git-diff-header">
            <span>{selectedFile}</span>
          </div>
          {diffLoading ? (
            <div class="git-diff-loading">Loading diff...</div>
          ) : diff ? (
            <div class="git-diff-content">
              {diff.split('\n').map((line, i) => {
                let cls = 'git-diff-line';
                if (line.startsWith('+') && !line.startsWith('+++')) cls += ' added';
                else if (line.startsWith('-') && !line.startsWith('---')) cls += ' removed';
                else if (line.startsWith('@@')) cls += ' hunk';
                return <div key={i} class={cls}>{line || ' '}</div>;
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
