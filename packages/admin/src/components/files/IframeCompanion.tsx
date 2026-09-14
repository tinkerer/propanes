import { useRef, useState, useEffect, useCallback } from 'preact/hooks';
import { marked } from 'marked';
import { MARKDOWN_EXTS } from '../../lib/file-utils.js';

/** Extension of a URL's path, ignoring query string and hash. */
function urlExt(url: string): string {
  let path = url;
  try {
    path = new URL(url, window.location.href).pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  const last = path.split('/').pop() || '';
  return last.includes('.') ? (last.split('.').pop() || '').toLowerCase() : '';
}

/**
 * Render markdown and resolve relative links/images against the document URL,
 * so a `./foo.png` inside a served .md still points at the right place.
 */
function renderMarkdown(source: string, baseUrl: string): string {
  const parsed = marked.parse(source);
  const html = typeof parsed === 'string' ? parsed : '';
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const absolutize = (el: Element, attr: string) => {
    const raw = el.getAttribute(attr);
    if (!raw || /^([a-z]+:|\/\/|#|data:)/i.test(raw)) return;
    try {
      el.setAttribute(attr, new URL(raw, baseUrl).href);
    } catch { /* leave as-is */ }
  };
  holder.querySelectorAll('a[href]').forEach((a) => {
    absolutize(a, 'href');
    if ((a.getAttribute('href') || '').startsWith('#')) return;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  holder.querySelectorAll('img[src]').forEach((img) => absolutize(img, 'src'));
  return holder.innerHTML;
}

export function IframeCompanion({ url, label }: { url: string; label?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const displayLabel = label || url;
  const isMarkdown = MARKDOWN_EXTS.has(urlExt(url));

  // Markdown URLs render in-pane instead of in the iframe (the server serves
  // .md as text/plain, so an iframe just shows the raw source). `raw` flips
  // back to the plain iframe; a fetch failure (cross-origin) does too.
  const [raw, setRaw] = useState(false);
  const [md, setMd] = useState<string | null>(null);
  const [mdError, setMdError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!isMarkdown || raw) return;
    let cancelled = false;
    setMd(null);
    setMdError(null);
    (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setMd(renderMarkdown(text, url));
      } catch (err: any) {
        if (!cancelled) setMdError(err?.message || 'Failed to load');
      }
    })();
    return () => { cancelled = true; };
  }, [url, isMarkdown, raw, nonce]);

  const reload = useCallback(() => {
    if (isMarkdown && !raw) {
      setNonce((n) => n + 1);
      return;
    }
    const iframe = iframeRef.current;
    if (iframe) iframe.src = url;
  }, [url, isMarkdown, raw]);

  const showMarkdown = isMarkdown && !raw && !mdError;

  return (
    <div class="iframe-companion">
      <div class="iframe-companion-toolbar">
        <span class="iframe-companion-url" title={displayLabel}>{displayLabel}</span>
        {isMarkdown && !mdError && (
          <button
            class="iframe-companion-reload"
            onClick={() => setRaw((r) => !r)}
            title={raw ? 'Render markdown' : 'View raw source'}
          >
            {raw ? '¶' : '‹›'}
          </button>
        )}
        <button
          class="iframe-companion-reload"
          onClick={reload}
          title="Reload"
        >
          {'↻'}
        </button>
        <a
          class="iframe-companion-open"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in new tab"
        >
          {'↗'}
        </a>
      </div>
      {showMarkdown ? (
        md === null
          ? <div class="companion-loading">Loading...</div>
          : <div class="iframe-companion-markdown fv-markdown" dangerouslySetInnerHTML={{ __html: md }} />
      ) : (
        <iframe
          ref={iframeRef}
          src={url}
          class="iframe-companion-frame"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      )}
    </div>
  );
}
