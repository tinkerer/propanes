import { useRef, useState, useEffect, useCallback } from 'preact/hooks';
import { marked } from 'marked';
import { MARKDOWN_EXTS } from '../../lib/file-utils.js';
import { normalizeCompanionUrl } from '../../lib/companion-url.js';

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

export function IframeCompanion({ url: initialUrl, label, onNavigate }: {
  url: string;
  label?: string;
  /** Called when the user edits the address. Return true if the owner re-keyed
   *  the tab (the `url` prop will change); otherwise we navigate locally. */
  onNavigate?: (url: string) => boolean | void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The address is editable, so the loaded URL can drift from the prop until
  // (unless) the owner re-keys the tab.
  const [url, setUrl] = useState(initialUrl);
  const [draft, setDraft] = useState(initialUrl);
  useEffect(() => { setUrl(initialUrl); setDraft(initialUrl); }, [initialUrl]);
  const isMarkdown = MARKDOWN_EXTS.has(urlExt(url));

  // Escape abandons the edit. Global shortcut handlers take Escape in the
  // capture phase and stop it before it reaches the input, so listen above
  // them; blurring restores the loaded URL via onBlur.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !inputRef.current || e.target !== inputRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      inputRef.current.blur();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const navigate = useCallback((input: string) => {
    const next = normalizeCompanionUrl(input, window.location.origin);
    if (!next) { setDraft(url); return; }
    setDraft(next);
    if (next === url) return;
    setRaw(false);
    if (onNavigate?.(next) === true) return;
    setUrl(next);
  }, [url, onNavigate]);

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
        {label ? (
          <span class="iframe-companion-url" title={label}>{label}</span>
        ) : (
          <input
            class="iframe-companion-url iframe-companion-url-input"
            type="text"
            spellcheck={false}
            autocomplete="off"
            ref={inputRef}
            aria-label="URL"
            title="Edit the URL and press Enter to load it"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onBlur={() => setDraft(url)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                navigate((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        )}
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
