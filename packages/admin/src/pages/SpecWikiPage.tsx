import { useSignal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { api } from '../lib/api.js';
import { isMobile } from '../lib/viewport.js';
import { SpecUpdateComposer } from '../components/feedback/SpecUpdateComposer.js';

marked.setOptions({ gfm: true, breaks: false });

export function SpecWikiPage({ appId }: { appId: string }) {
  const [file, setFile] = useState('index.md');
  const [files, setFiles] = useState<string[]>([]);
  const [content, setContent] = useState('');
  const [wikiDir, setWikiDir] = useState('');
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [launchedSessionId, setLaunchedSessionId] = useState('');
  const [error, setError] = useState('');
  const pagesExpanded = useSignal(!isMobile.value);
  const bodyRef = useRef<HTMLDivElement>(null);

  async function load(targetFile = file) {
    setLoading(true);
    setError('');
    try {
      const res = await api.getSpec(appId, targetFile);
      setExists(res.exists);
      setWikiDir(res.wikiDir);
      setFiles(res.files);
      setContent(res.content);
      setFile(res.file);
    } catch (err: any) {
      setError(err.message || 'Failed to load spec');
    } finally {
      setLoading(false);
    }
  }

  function openComposer() {
    setError('');
    setComposerOpen(true);
  }

  function handleLaunched(sessionId: string | undefined) {
    if (sessionId) {
      setLaunchedSessionId(sessionId);
    } else {
      void load('index.md');
    }
  }

  function selectFile(name: string) {
    void load(name);
    if (isMobile.value) pagesExpanded.value = false;
  }

  useEffect(() => {
    pagesExpanded.value = !isMobile.value;
    load('index.md');
  }, [appId]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest('a');
      const href = link?.getAttribute('href') || '';
      if (!href || href.startsWith('http') || href.startsWith('#') || !href.endsWith('.md')) return;
      event.preventDefault();
      load(href);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [appId, file]);

  const html = content ? (marked.parse(content) as string) : '';

  return (
    <div>
      <div class="page-header">
        <div>
          <h2 style="margin:0">Spec Wiki</h2>
          {wikiDir && <div style="font-size:12px;color:var(--pw-text-muted);margin-top:4px">{wikiDir}</div>}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-sm" onClick={() => { window.location.hash = `#/app/${appId}/tickets`; }}>
            Tickets
          </button>
          <button class="btn btn-sm btn-primary" onClick={openComposer}>
            {'Update Spec'}
          </button>
        </div>
      </div>

      {error && <div class="detail-card" style="color:var(--pw-error);margin-bottom:12px">{error}</div>}
      {launchedSessionId && (
        <div class="detail-card" style="margin-bottom:12px;color:var(--pw-text-muted);font-size:13px">
          Spec update session launched: <code>{launchedSessionId}</code>
        </div>
      )}

      {!loading && !exists ? (
        <div class="detail-card" style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div>
            <h3 style="margin:0 0 6px">No spec wiki yet</h3>
            <p style="margin:0;color:var(--pw-text-muted);font-size:13px">
              Run Update Spec to generate the index from tickets, CoS thread inputs, and agent JSONL prompts.
            </p>
          </div>
          <button class="btn btn-sm btn-primary" onClick={openComposer}>
            {'Update Spec'}
          </button>
        </div>
      ) : (
        <div class={`spec-wiki-layout ${pagesExpanded.value ? 'pages-expanded' : 'pages-collapsed'}`}>
          <div class="detail-card spec-wiki-pages-card">
            <button
              type="button"
              class="spec-wiki-pages-toggle"
              aria-expanded={pagesExpanded.value}
              onClick={() => { pagesExpanded.value = !pagesExpanded.value; }}
            >
              <span>Pages</span>
              <span class="spec-wiki-current-page">{file}</span>
              <span class="spec-wiki-pages-toggle-icon" aria-hidden="true">{pagesExpanded.value ? '-' : '+'}</span>
            </button>
            <div class="spec-wiki-pages-list">
              {(files.length ? files : ['index.md']).map((name) => (
                <button
                  key={name}
                  class={`btn btn-sm ${file === name ? 'btn-primary' : ''}`}
                  onClick={() => selectFile(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div class="detail-card">
            {loading ? (
              <div style="color:var(--pw-text-muted)">Loading spec...</div>
            ) : (
              <div ref={bodyRef} class="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </div>
        </div>
      )}
      {composerOpen && (
        <SpecUpdateComposer
          appId={appId}
          onClose={() => setComposerOpen(false)}
          onLaunched={handleLaunched}
        />
      )}
    </div>
  );
}
