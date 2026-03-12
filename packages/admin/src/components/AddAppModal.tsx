import { useState } from 'preact/hooks';
import { api } from '../lib/api.js';
import { loadApplications, navigate } from '../lib/state.js';
import { DirPicker } from './DirPicker.js';

type Mode = null | 'create' | 'existing' | 'clone';

interface SuccessState {
  id: string;
  apiKey: string;
  projectDir: string;
}

export function AddAppModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copied, setCopied] = useState(false);

  // Create mode fields
  const [createName, setCreateName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [projectName, setProjectName] = useState('');

  // Existing mode fields
  const [existingName, setExistingName] = useState('');
  const [existingDir, setExistingDir] = useState('');

  // Clone mode fields
  const [cloneName, setCloneName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [cloneParentDir, setCloneParentDir] = useState('');
  const [cloneDirName, setCloneDirName] = useState('');

  const serverUrl = `${window.location.protocol}//${window.location.host}`;

  async function handleSubmit() {
    setError('');
    setLoading(true);
    try {
      let result: SuccessState;
      if (mode === 'create') {
        result = await api.scaffoldApp({ name: createName, parentDir, projectName });
      } else if (mode === 'existing') {
        const res = await api.createApplication({ name: existingName, projectDir: existingDir });
        result = { id: res.id, apiKey: res.apiKey, projectDir: existingDir };
      } else if (mode === 'clone') {
        result = await api.cloneApp({
          name: cloneName,
          gitUrl,
          parentDir: cloneParentDir,
          ...(cloneDirName ? { dirName: cloneDirName } : {}),
        });
      } else {
        return;
      }
      setSuccess(result);
      await loadApplications();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  function handleDone() {
    if (success) {
      navigate(`/app/${success.id}/feedback`);
    }
    onClose();
  }

  const snippetTag = success
    ? `<script src="${serverUrl}/widget.js" data-server="${serverUrl}" data-api-key="${success.apiKey}"></script>`
    : '';

  function copySnippet() {
    navigator.clipboard.writeText(snippetTag);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (success) {
    return (
      <div class="modal-overlay" onClick={onClose}>
        <div class="modal" onClick={(e) => e.stopPropagation()}>
          <h3>App Created</h3>
          <p style={{ color: 'var(--pw-text-secondary)', marginBottom: 12 }}>
            Add this snippet to your HTML to enable the feedback widget:
          </p>
          <div class="add-app-snippet">
            <code>{snippetTag}</code>
            <button class="btn btn-small" onClick={copySnippet}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div class="modal-actions">
            <button class="btn btn-primary" onClick={handleDone}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === null) {
    return (
      <div class="modal-overlay" onClick={onClose}>
        <div class="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Add App</h3>
          <div class="add-app-cards">
            <button class="add-app-card" onClick={() => setMode('create')}>
              <span class="add-app-card-icon">{'\u{1F4C1}'}</span>
              <span class="add-app-card-title">Create Project</span>
              <span class="add-app-card-desc">Scaffold a new hello-world project</span>
            </button>
            <button class="add-app-card" onClick={() => setMode('existing')}>
              <span class="add-app-card-icon">{'\u{1F4C2}'}</span>
              <span class="add-app-card-title">Existing Directory</span>
              <span class="add-app-card-desc">Register a project you already have</span>
            </button>
            <button class="add-app-card" onClick={() => setMode('clone')}>
              <span class="add-app-card-icon">{'\u{1F517}'}</span>
              <span class="add-app-card-title">Clone Repository</span>
              <span class="add-app-card-desc">Clone a git repo and register it</span>
            </button>
          </div>
          <div class="modal-actions">
            <button class="btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  const titles: Record<string, string> = {
    create: 'Create Project',
    existing: 'Register Existing Directory',
    clone: 'Clone Repository',
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{titles[mode]}</h3>
        {error && <div class="form-error" style={{ marginBottom: 12 }}>{error}</div>}

        {mode === 'create' && (
          <>
            <div class="form-group">
              <label>App Name</label>
              <input type="text" value={createName} onInput={(e) => setCreateName((e.target as HTMLInputElement).value)} placeholder="My App" />
            </div>
            <div class="form-group">
              <label>Parent Directory</label>
              <DirPicker value={parentDir} onInput={setParentDir} placeholder="/Users/you/projects" />
            </div>
            <div class="form-group">
              <label>Project Name</label>
              <input type="text" value={projectName} onInput={(e) => setProjectName((e.target as HTMLInputElement).value)} placeholder="my-app" />
            </div>
            {parentDir && projectName && (
              <div style={{ color: 'var(--pw-text-muted)', fontSize: 13, marginBottom: 8 }}>
                Will create: {parentDir}/{projectName}
              </div>
            )}
          </>
        )}

        {mode === 'existing' && (
          <>
            <div class="form-group">
              <label>App Name</label>
              <input type="text" value={existingName} onInput={(e) => setExistingName((e.target as HTMLInputElement).value)} placeholder="My App" />
            </div>
            <div class="form-group">
              <label>Project Directory</label>
              <DirPicker value={existingDir} onInput={setExistingDir} placeholder="/Users/you/projects/my-app" />
            </div>
          </>
        )}

        {mode === 'clone' && (
          <>
            <div class="form-group">
              <label>App Name</label>
              <input type="text" value={cloneName} onInput={(e) => setCloneName((e.target as HTMLInputElement).value)} placeholder="My App" />
            </div>
            <div class="form-group">
              <label>Git URL</label>
              <input type="text" value={gitUrl} onInput={(e) => setGitUrl((e.target as HTMLInputElement).value)} placeholder="https://github.com/user/repo.git" />
            </div>
            <div class="form-group">
              <label>Parent Directory</label>
              <DirPicker value={cloneParentDir} onInput={setCloneParentDir} placeholder="/Users/you/projects" />
            </div>
            <div class="form-group">
              <label>Directory Name <span style={{ color: 'var(--pw-text-muted)' }}>(optional)</span></label>
              <input type="text" value={cloneDirName} onInput={(e) => setCloneDirName((e.target as HTMLInputElement).value)} placeholder="Defaults to repo name" />
            </div>
          </>
        )}

        <div class="modal-actions">
          <button class="btn" onClick={() => setMode(null)}>Back</button>
          <button class="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? 'Working...' : mode === 'create' ? 'Create' : mode === 'clone' ? 'Clone' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  );
}
