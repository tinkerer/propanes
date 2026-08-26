import { useSignal } from '@preact/signals';
import { serverPath } from '../lib/base-path.js';
import { useRef, useEffect } from 'preact/hooks';
import { marked } from 'marked';

function addCopyButtons(container: HTMLElement) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.querySelector('.gs-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'gs-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = (code || pre).textContent || '';
      const onSuccess = () => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess, fallback);
      } else {
        fallback();
      }
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        onSuccess();
      }
    });
    pre.appendChild(btn);
  }
}

export function GettingStartedPage() {
  const contentRef = useRef<HTMLDivElement>(null);
  const html = useSignal('');
  const loading = useSignal(true);
  const error = useSignal('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      loading.value = true;
      error.value = '';
      try {
        const res = await fetch('/GETTING_STARTED.md');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const md = await res.text();
        if (!cancelled) html.value = await marked.parse(md);
      } catch (err: any) {
        if (!cancelled) error.value = err.message;
      } finally {
        if (!cancelled) loading.value = false;
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (contentRef.current && html.value) {
      addCopyButtons(contentRef.current);
    }
  }, [html.value]);

  if (loading.value) return <div style="padding:40px;color:#64748b">Loading...</div>;
  if (error.value) return <div class="error-msg" style="padding:24px">{error.value}</div>;

  return (
    <div>
      <div class="page-header">
        <h2>Getting Started</h2>
        <a href={serverPath('/GETTING_STARTED.md')} target="_blank" class="btn btn-sm" style="text-decoration:none">
          Raw Markdown
        </a>
      </div>
      <div ref={contentRef} class="getting-started-content" dangerouslySetInnerHTML={{ __html: html.value }} />
    </div>
  );
}
