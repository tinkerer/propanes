import { useState, useRef, useEffect } from 'preact/hooks';
import { BASE_PATH } from '../../lib/base-path.js';
import { api } from '../../lib/api.js';
import { loadApplications, navigate, selectedAppId } from '../../lib/state.js';
import { openSession, loadAllSessions } from '../../lib/sessions.js';
import { DirPicker } from '../pickers/DirPicker.js';
import { copyText } from '../../lib/clipboard.js';

type Mode = null | 'create' | 'existing' | 'clone';
interface SuccessState { id: string; apiKey: string; projectDir: string; appUrl?: string }

export function AddAppModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copied, setCopied] = useState(false);
  const [assistText, setAssistText] = useState('');
  const [name, setName] = useState('Hello World');
  const [directory, setDirectory] = useState('');
  const [projectName, setProjectName] = useState('hello-world');
  const [port, setPort] = useState('5173');
  const [gitUrl, setGitUrl] = useState('');
  const [cloneDirName, setCloneDirName] = useState('');
  const [started, setStarted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    // A step change removes the focused button; keep keyboard focus in the dialog.
    dialogRef.current?.focus();
  }, [mode, success]);
  function onDialogKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !loading) { e.preventDefault(); e.stopPropagation(); onClose(); }
    if (e.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, a[href], summary') || []).filter(el => el.getClientRects().length > 0);
    const first = items[0], last = items[items.length - 1];
    if (!first) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  const serverUrl = window.location.origin + BASE_PATH;
  const snippet = success ? '<script src="' + serverUrl + '/widget/propanes.js" data-endpoint="' + serverUrl + '/api/v1/feedback" data-app-key="' + success.apiKey + '" data-mode="always"></script>' : '';
  const valid = name.trim() && directory.trim() && (mode !== 'create' || (/^[a-zA-Z0-9_-]+$/.test(projectName) && Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535)) && (mode !== 'clone' || gitUrl.trim());

  function choose(next: Mode) { setMode(next); setError(''); }
  async function submit() {
    if (loading || !valid) return;
    setLoading(true); setError('');
    try {
      let result: SuccessState;
      if (mode === 'create') result = await api.scaffoldApp({ name: name.trim(), parentDir: directory.trim(), projectName, port: Number(port) });
      else if (mode === 'clone') result = await api.cloneApp({ name: name.trim(), gitUrl: gitUrl.trim(), parentDir: directory.trim(), ...(cloneDirName.trim() ? { dirName: cloneDirName.trim() } : {}) });
      else {
        const app = await api.createApplication({ name: name.trim(), projectDir: directory.trim() });
        result = { id: app.id, apiKey: app.apiKey, projectDir: directory.trim() };
      }
      setSuccess(result);
      await loadApplications();
      selectedAppId.value = result.id;
    } catch (err: any) { setError(err.message || 'Could not create your app. Please try again.'); }
    finally { setLoading(false); }
  }
  async function assist() {
    if (loading || !assistText.trim()) return;
    setLoading(true); setError('');
    try {
      const result = await api.onboardAssist({ request: assistText.trim() });
      await loadAllSessions(); openSession(result.sessionId); onClose();
    } catch (err: any) { setError(err.message || 'Could not start the assistant. Check your agent setup and try again.'); }
    finally { setLoading(false); }
  }
  async function start() {
    if (!success || loading || started) return;
    setLoading(true); setError('');
    try {
      const result = await api.runControlAction(success.id, 'dev');
      await loadAllSessions(); openSession(result.sessionId); setStarted(true);
    } catch (err: any) { setError(err.message || 'Could not open a terminal. Run the commands below manually.'); }
    finally { setLoading(false); }
  }
  function copy(value: string) { copyText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  const title = success ? (success.appUrl ? 'Your Hello World is ready' : 'Application registered') : mode === 'create' ? 'Create your Hello World' : mode === 'existing' ? 'Connect an existing project' : mode === 'clone' ? 'Clone a repository' : 'Start with something small';
  return (
    <div class="modal-overlay" onClick={() => !loading && onClose()}>
      <div ref={dialogRef} tabIndex={-1} class="modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="add-app-title" onKeyDown={onDialogKey} onClick={e => e.stopPropagation()}>
        <div class="onboarding-eyebrow">{success ? 'STEP 2 OF 3 · RUN & PREVIEW' : 'STEP 1 OF 3 · CREATE'}</div>
        <h3 id="add-app-title">{title}</h3>
        {error && <div class="form-error" role="alert">{error}</div>}
        {success ? <>
          {success.appUrl ? <>
            <p class="onboarding-muted">Your app is registered. Hot reload is configured and the prompt widget is already connected.</p>
            <ol class="onboarding-checklist">
              <li><strong>Start your app</strong><p>Install dependencies and start Vite on the ProPanes server machine. Keep the terminal running.</p>
                <button class="btn btn-primary" disabled={loading || started} onClick={start}>{loading ? 'Opening terminal…' : started ? 'Terminal opened — check startup output' : 'Start dev server'}</button>
                <details><summary>Or run these commands yourself</summary><pre><code>{"cd '" + success.projectDir.replace(/'/g, "'\\''") + "'\nnpm install && npm run dev"}</code></pre></details>
              </li>
              <li><strong>Open the preview</strong><p>When Vite shows “ready”, open your app. Edit <code>main.js</code> and save to see hot reload.</p>
                <a class="btn" href={success.appUrl} target="_blank" rel="noopener">Open {success.appUrl} ↗</a>
                <p class="onboarding-muted">Localhost refers to the server machine. If the port is busy, change it in package.json and App Settings.</p>
              </li>
              <li><strong>Make your first change</strong><p>Open the widget in your app, select a configured agent, and ask: “Change the heading to My first app.”</p></li>
            </ol>
          </> : <p class="onboarding-muted">Add the widget snippet before your closing &lt;/body&gt; tag. Start your app, open it in a browser, and send your first prompt.</p>}
          <details open={!success.appUrl}><summary>{success.appUrl ? 'Widget snippet (already installed)' : 'Install the prompt widget'}</summary>
            <div class="add-app-snippet"><code>{snippet}</code><button class="btn btn-small" onClick={() => copy(snippet)}>{copied ? 'Copied!' : 'Copy'}</button></div>
          </details>
          <div class="modal-actions">
            <button class="btn" onClick={() => { navigate('/app/' + success.id + '/tickets'); onClose(); }}>Open application</button>
            <button class="btn btn-primary" onClick={() => { navigate('/settings/getting-started'); onClose(); }}>Continue the guide →</button>
          </div>
        </> : mode === null ? <>
          <p class="onboarding-muted">Create a working app, open it, and make your first change with a prompt.</p>
          <button class="onboarding-starter" onClick={() => choose('create')} disabled={loading}>
            <span class="onboarding-eyebrow">RECOMMENDED · NO AGENT NEEDED</span>
            <strong>Hello World →</strong>
            <span>A ready-to-edit app with hot reload and the ProPanes widget included.</span>
          </button>
          <div class="add-app-cards">
            <button class="add-app-card" disabled={loading} onClick={() => { setName(''); choose('existing'); }}><span class="add-app-card-title">Existing directory</span><span class="add-app-card-desc">Connect a project on this machine</span></button>
            <button class="add-app-card" disabled={loading} onClick={() => { setName(''); choose('clone'); }}><span class="add-app-card-title">Clone repository</span><span class="add-app-card-desc">Start from a Git repository</span></button>
          </div>
          <details><summary>Let an agent help with setup</summary>
            <p class="onboarding-muted">Requires an agent configured in Settings → Agents with a working CLI login.</p>
            <textarea class="request-panel-textarea" aria-label="Describe your project" placeholder="Describe your project and how you want to set it up…" value={assistText} onInput={e => setAssistText(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void assist(); } }} rows={3} />
            <button class="btn" disabled={loading || !assistText.trim()} onClick={assist}>{loading ? 'Starting agent…' : 'Start setup assistant'}</button>
          </details>
          <div class="modal-actions"><button class="btn" disabled={loading} onClick={onClose}>Cancel</button></div>
        </> : <form onSubmit={e => { e.preventDefault(); void submit(); }}>
          {mode === 'create' && <p class="onboarding-muted">A small JavaScript app powered by Vite. Requires Node.js 18+ and npm on the server machine.</p>}
          <div class="form-group"><label for="new-app-name">App name</label><input id="new-app-name" value={name} onInput={e => setName(e.currentTarget.value)} placeholder="My app" required maxLength={100} /></div>
          {mode === 'clone' && <div class="form-group"><label for="new-app-git">Repository URL</label><input id="new-app-git" value={gitUrl} onInput={e => setGitUrl(e.currentTarget.value)} placeholder="https://github.com/you/project.git" required /></div>}
          {mode === 'clone' && <div class="form-group"><label for="new-app-clone-folder">Project folder (optional)</label><input id="new-app-clone-folder" value={cloneDirName} onInput={e => setCloneDirName(e.currentTarget.value)} placeholder="Defaults to repository name" /></div>}
          <div class="form-group"><label for="new-app-directory">{mode === 'existing' ? 'Project directory' : 'Create inside this directory'}</label><DirPicker inputId="new-app-directory" value={directory} onInput={setDirectory} placeholder="/Users/you/projects" /><p class="onboarding-muted">Choose a directory on the machine running ProPanes.</p></div>
          {mode === 'create' && <>
            <div class="onboarding-fields">
              <div class="form-group"><label for="new-app-folder">Project folder</label><input id="new-app-folder" value={projectName} onInput={e => setProjectName(e.currentTarget.value)} pattern="[a-zA-Z0-9_-]+" required /><small>Letters, numbers, hyphens or underscores.</small></div>
              <div class="form-group"><label for="new-app-port">Preview port</label><input id="new-app-port" type="number" min="1024" max="65535" value={port} onInput={e => setPort(e.currentTarget.value)} required /></div>
            </div>
            {directory && projectName && <p class="onboarding-path">Will create {directory}/{projectName}</p>}
          </>}
          <div class="modal-actions"><button type="button" class="btn" disabled={loading} onClick={() => choose(null)}>Back</button><button class="btn btn-primary" type="submit" disabled={loading || !valid}>{loading ? 'Creating…' : mode === 'create' ? 'Create Hello World' : mode === 'clone' ? 'Clone & connect' : 'Connect project'}</button></div>
        </form>}
      </div>
    </div>
  );
}
