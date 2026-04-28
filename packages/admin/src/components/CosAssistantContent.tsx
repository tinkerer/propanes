// Assistant message body rendering extracted from CosMessage.tsx.
//
// AssistantContent runs the markdown lexer (via parseAssistantContent),
// renders prose chunks with marked.parse + linkifyHtml + a click handler
// that intercepts ULID and URL anchors, and renders code/list/table
// artifacts as ArtifactCard chips that pop out into companion panes.
//
// The DOM walker (highlightTextNodesInDom) is run from a useEffect after
// the dangerouslySetInnerHTML pass so search hits get wrapped in <mark>
// tags inside the rendered markdown.

import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { openSession } from '../lib/sessions.js';
import { openUrlCompanion } from '../lib/companion-state.js';
import { registerCosArtifact, artifactIdFor } from '../lib/cos-artifacts.js';
import {
  linkifyHtml,
  parseAssistantContent,
  type ContentSegment,
} from '../lib/cos-markdown.js';

function handleCosProseClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const urlLink = target.closest('a[data-cos-url]') as HTMLElement | null;
  if (urlLink) {
    const url = urlLink.getAttribute('data-cos-url');
    if (url) { e.preventDefault(); e.stopPropagation(); openUrlCompanion(url); }
    return;
  }
  const link = target.closest('a[data-cos-session-id]') as HTMLElement | null;
  if (!link) return;
  const sid = link.getAttribute('data-cos-session-id');
  if (!sid) return;
  e.preventDefault();
  e.stopPropagation();
  openSession(sid);
}

function ArtifactCard({
  seg,
  onPopout,
}: {
  seg: Extract<ContentSegment, { type: 'artifact' }>;
  onPopout: (artifactId: string) => void;
}) {
  // Register eagerly so the CoS artifact drawer and companion pane can look up
  // labels/content after a page reload (drawer/pane tab IDs are persisted; the
  // artifact contents are re-derived from message text on each render).
  useEffect(() => {
    registerCosArtifact({
      id: artifactIdFor(seg.kind, seg.raw),
      kind: seg.kind,
      label: seg.label,
      meta: seg.meta,
      lang: seg.lang,
      filename: seg.filename,
      raw: seg.raw,
    });
  }, [seg.kind, seg.raw, seg.label, seg.meta, seg.lang, seg.filename]);

  const icon = seg.kind === 'code' ? '❮❯' : seg.kind === 'table' ? '▦' : '☰';

  const popout = () => {
    const id = artifactIdFor(seg.kind, seg.raw);
    registerCosArtifact({
      id,
      kind: seg.kind,
      label: seg.label,
      meta: seg.meta,
      lang: seg.lang,
      filename: seg.filename,
      raw: seg.raw,
    });
    onPopout(id);
  };

  return (
    <div class={`cos-artifact cos-artifact-${seg.kind}`}>
      <button
        type="button"
        class="cos-artifact-header"
        onClick={popout}
        title="Open in companion pane"
        aria-label={`Open ${seg.label} in companion pane`}
      >
        <span class="cos-artifact-icon" aria-hidden="true">{icon}</span>
        <span class="cos-artifact-label">{seg.label}</span>
        <span class="cos-artifact-meta">{seg.meta}</span>
        <span class="cos-artifact-popout-hint" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h6v6" />
            <path d="M10 14L21 3" />
            <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
          </svg>
        </span>
      </button>
    </div>
  );
}

// Walks all text nodes inside a rendered markdown container and wraps
// substring matches in <mark class="cos-search-hit">. Skips nodes already
// inside a mark (idempotent across re-runs). Run from a useEffect after the
// dangerouslySetInnerHTML pass so we operate on the live DOM.
function highlightTextNodesInDom(root: HTMLElement, query: string) {
  if (!query) return;
  const lowerQ = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === 'MARK' && parent.classList.contains('cos-search-hit')) return NodeFilter.FILTER_REJECT;
      if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue || '';
      return text.toLowerCase().includes(lowerQ) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets: Text[] = [];
  let cur = walker.nextNode();
  while (cur) { targets.push(cur as Text); cur = walker.nextNode(); }
  for (const node of targets) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const hit = lower.indexOf(lowerQ, i);
      if (hit < 0) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
      if (hit > i) frag.appendChild(document.createTextNode(text.slice(i, hit)));
      const mark = document.createElement('mark');
      mark.className = 'cos-search-hit';
      mark.textContent = text.slice(hit, hit + query.length);
      frag.appendChild(mark);
      i = hit + query.length;
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

export function AssistantContent({ text, onArtifactPopout, searchHighlight }: { text: string; onArtifactPopout: (artifactId: string) => void; searchHighlight?: string | null }) {
  const segments = useMemo(() => parseAssistantContent(text), [text]);
  const proseRef = useRef<HTMLDivElement>(null);
  // Re-apply DOM-level highlight after every render that might change the
  // rendered markdown or the active query. The walker is idempotent thanks to
  // the dangerouslySetInnerHTML reset that runs before this effect.
  useEffect(() => {
    const root = proseRef.current;
    if (!root) return;
    const q = (searchHighlight || '').trim();
    if (!q) return;
    highlightTextNodesInDom(root, q);
  }, [text, searchHighlight]);
  return (
    <div class="cos-msg-md" ref={proseRef}>
      {segments.map((seg, i) => {
        if (seg.type === 'artifact') {
          return <ArtifactCard key={i} seg={seg} onPopout={onArtifactPopout} />;
        }
        const html = marked.parse(seg.markdown) as string;
        const safeHtml = typeof html === 'string' ? linkifyHtml(html) : '';
        return <div key={i} class="cos-md-prose" onClick={handleCosProseClick} dangerouslySetInnerHTML={{ __html: safeHtml }} />;
      })}
    </div>
  );
}
