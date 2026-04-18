import { useState, useEffect } from 'preact/hooks';
import { FileTree } from '../components/FileTree.js';
import { GitChangesView } from '../components/GitChangesView.js';
import { api } from '../lib/api.js';

interface Props {
  appId: string;
}

export function FileBrowserPage({ appId }: Props) {
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changeCount, setChangeCount] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.browseFiles(appId).then((result) => {
      const dir = result.path.replace(/\/$/, '');
      setProjectDir(dir);
      setLoading(false);
    }).catch((err: any) => {
      setError(err.message || 'Failed to load project directory');
      setLoading(false);
    });
  }, [appId]);

  if (loading) return <div class="page-loading" style={{ padding: '24px' }}>Loading project...</div>;
  if (error) return <div class="page-error" style={{ padding: '24px', color: '#e06c75' }}>{error}</div>;
  if (!projectDir) return <div style={{ padding: '24px' }}>No project directory configured</div>;

  return (
    <div class="file-browser-page">
      <div class="file-browser-tabs">
        <button
          class={`file-browser-tab${tab === 'files' ? ' active' : ''}`}
          onClick={() => setTab('files')}
        >
          {'\u{1F4C1}'} Files
        </button>
        <button
          class={`file-browser-tab${tab === 'changes' ? ' active' : ''}`}
          onClick={() => setTab('changes')}
        >
          {'\u{1F504}'} Changes
          {changeCount > 0 && <span class="file-browser-badge">{changeCount}</span>}
        </button>
      </div>
      <div class="file-browser-content">
        {tab === 'files' ? (
          <FileTree appId={appId} projectDir={projectDir} />
        ) : (
          <GitChangesView appId={appId} projectDir={projectDir} onFileCount={setChangeCount} />
        )}
      </div>
    </div>
  );
}
