import { useEffect, useRef, useCallback } from 'preact/hooks';
import { fileViewerPanels, closeFileViewer, updateFileViewer } from '../lib/file-viewer.js';
import { api } from '../lib/api.js';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';
import { IMAGE_EXTS, MARKDOWN_EXTS, getExt, getLanguage, shortenPath } from '../lib/file-utils.js';

function SingleFileViewer({ path, offset }: { path: string; offset: number }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startPos = useRef({ mx: 0, my: 0, x: 0, y: 0 });
  const posRef = useRef({ x: Math.max(100, window.innerWidth / 2 - 350 + offset * 30), y: Math.max(60, 100 + offset * 30) });

  const panel = fileViewerPanels.value.find(p => p.path === path);
  if (!panel) return null;

  const ext = getExt(path);
  const isImage = IMAGE_EXTS.has(ext);
  const isMarkdown = MARKDOWN_EXTS.has(ext);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isImage) {
          const url = await api.readFileImage(path);
          if (!cancelled) updateFileViewer(path, { imageUrl: url, loading: false });
        } else {
          const result = await api.readFile(path);
          if (!cancelled) updateFileViewer(path, { content: result.content, loading: false });
        }
      } catch (err: any) {
        if (!cancelled) updateFileViewer(path, { error: err.message, loading: false });
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  const onHeaderMouseDown = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragging.current = true;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    startPos.current = { mx: e.clientX, my: e.clientY, x: rect.left, y: rect.top };

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.clientX - startPos.current.mx;
      const dy = ev.clientY - startPos.current.my;
      const nx = Math.max(0, startPos.current.x + dx);
      const ny = Math.max(0, startPos.current.y + dy);
      posRef.current = { x: nx, y: ny };
      if (panelRef.current) {
        panelRef.current.style.left = nx + 'px';
        panelRef.current.style.top = ny + 'px';
      }
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  let bodyContent;
  if (panel.loading) {
    bodyContent = <div class="fv-loading">Loading...</div>;
  } else if (panel.error) {
    bodyContent = <div class="fv-error">{panel.error}</div>;
  } else if (panel.imageUrl) {
    bodyContent = <div class="fv-image-wrap"><img src={panel.imageUrl} alt={path} /></div>;
  } else if (panel.content !== undefined) {
    if (isMarkdown) {
      const html = marked.parse(panel.content);
      bodyContent = <div class="fv-markdown" dangerouslySetInnerHTML={{ __html: typeof html === 'string' ? html : '' }} />;
    } else {
      const lang = getLanguage(ext);
      let highlighted: string;
      try {
        highlighted = lang
          ? hljs.highlight(panel.content, { language: lang }).value
          : hljs.highlightAuto(panel.content).value;
      } catch {
        highlighted = panel.content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      const lines = highlighted.split('\n');
      bodyContent = (
        <div class="fv-code-wrap">
          <pre class="fv-code"><code>{lines.map((line, i) => (
            <div key={i} class="fv-code-line">
              <span class="fv-line-num">{i + 1}</span>
              <span class="fv-line-text" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
            </div>
          ))}</code></pre>
        </div>
      );
    }
  }

  return (
    <div
      ref={panelRef}
      class="file-viewer-panel"
      style={{ left: posRef.current.x, top: posRef.current.y }}
    >
      <div class="fv-header" onMouseDown={onHeaderMouseDown}>
        <span class="fv-title" title={path}>{shortenPath(path)}</span>
        <span style="flex:1" />
        <button class="fv-close" onClick={() => closeFileViewer(path)}>&times;</button>
      </div>
      <div class="fv-body">
        {bodyContent}
      </div>
    </div>
  );
}

export function FileViewerOverlay() {
  const panels = fileViewerPanels.value;
  if (panels.length === 0) return null;

  return (
    <>
      {panels.map((p, i) => (
        <SingleFileViewer key={p.path} path={p.path} offset={i} />
      ))}
    </>
  );
}
