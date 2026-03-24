import { signal } from '@preact/signals';
import { useRef, useEffect } from 'preact/hooks';
import { marked } from 'marked';

const html = signal('');
const loading = signal(true);
const error = signal('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/GETTING_STARTED.md');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    html.value = await marked.parse(md);
  } catch (err: any) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

let loaded = false;

function addCopyButtons(container: HTMLElement) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.querySelector('.gs-copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'gs-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = (code || pre).textContent || '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
    pre.appendChild(btn);
  }
}

export function GettingStartedPage() {
  const contentRef = useRef<HTMLDivElement>(null);

  if (!loaded) {
    loaded = true;
    load();
  }

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
        <a href="/GETTING_STARTED.md" target="_blank" class="btn btn-sm" style="text-decoration:none">
          Raw Markdown
        </a>
      </div>
      <div ref={contentRef} class="getting-started-content" dangerouslySetInnerHTML={{ __html: html.value }} />
    </div>
  );
}
