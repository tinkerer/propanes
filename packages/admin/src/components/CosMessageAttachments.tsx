// Attachment renderers extracted from CosMessage.tsx — image thumbnails
// (with lightbox) and DOM element-reference chips (with expand panel),
// wrapped by MessageAttachments which only renders when at least one
// attachment of either kind is present.

import { useEffect, useState } from 'preact/hooks';
import type {
  CosImageAttachment,
  CosElementRef,
} from '../lib/chief-of-staff.js';

function MessageImageThumb({ src, name }: { src: string; name?: string }) {
  const [lightbox, setLightbox] = useState(false);
  const hasSrc = !!src;

  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setLightbox(false);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [lightbox]);

  if (!hasSrc) {
    return (
      <div class="cos-msg-attach-img cos-msg-attach-img-missing" title={name || 'image not loaded'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        <span>image</span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        class="cos-msg-attach-img"
        onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
        title={name || 'Click to enlarge'}
      >
        <img src={src} alt={name || 'attachment'} />
      </button>
      {lightbox && (
        <div class="sm-lightbox" onClick={() => setLightbox(false)}>
          <div class="sm-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img src={src} alt={name || 'attachment (full)'} />
            <button class="sm-lightbox-close" onClick={() => setLightbox(false)}>&times;</button>
          </div>
        </div>
      )}
    </>
  );
}

function formatElementHeader(ref: CosElementRef): string {
  let out = ref.tagName || 'element';
  if (ref.id) out += `#${ref.id}`;
  const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
  if (cls.length) out += '.' + cls.join('.');
  return out;
}

function MessageElementChip({ info }: { info: CosElementRef }) {
  const [expanded, setExpanded] = useState(false);
  const header = formatElementHeader(info);
  const br = info.boundingRect;
  const dims = br ? `${Math.round(br.width)}×${Math.round(br.height)}` : '';
  const textPreview = (info.textContent || '').trim().slice(0, 80);
  const attrs = info.attributes || {};
  const attrKeys = Object.keys(attrs);
  return (
    <div class={`cos-msg-attach-el${expanded ? ' cos-msg-attach-el-open' : ''}`}>
      <button
        type="button"
        class="cos-msg-attach-el-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={info.selector}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
        </svg>
        <code class="cos-msg-attach-el-name">{header}</code>
        {dims && <span class="cos-msg-attach-el-dims">{dims}</span>}
        {textPreview && !expanded && (
          <span class="cos-msg-attach-el-text">"{textPreview}{(info.textContent || '').length > 80 ? '…' : ''}"</span>
        )}
        <span class="cos-msg-attach-el-toggle" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div class="cos-msg-attach-el-body">
          <div class="cos-msg-attach-el-row">
            <span class="cos-msg-attach-el-label">selector</span>
            <code class="cos-msg-attach-el-value">{info.selector}</code>
          </div>
          {br && (
            <div class="cos-msg-attach-el-row">
              <span class="cos-msg-attach-el-label">rect</span>
              <code class="cos-msg-attach-el-value">
                x:{Math.round(br.x)} y:{Math.round(br.y)} w:{Math.round(br.width)} h:{Math.round(br.height)}
              </code>
            </div>
          )}
          {info.classes && info.classes.length > 0 && (
            <div class="cos-msg-attach-el-row">
              <span class="cos-msg-attach-el-label">classes</span>
              <code class="cos-msg-attach-el-value">{info.classes.join(' ')}</code>
            </div>
          )}
          {info.textContent && (
            <div class="cos-msg-attach-el-row">
              <span class="cos-msg-attach-el-label">text</span>
              <code class="cos-msg-attach-el-value cos-msg-attach-el-value-multiline">{info.textContent}</code>
            </div>
          )}
          {attrKeys.length > 0 && (
            <div class="cos-msg-attach-el-row cos-msg-attach-el-row-stack">
              <span class="cos-msg-attach-el-label">attributes</span>
              <div class="cos-msg-attach-el-attrs">
                {attrKeys.map((k) => (
                  <div key={k} class="cos-msg-attach-el-attr">
                    <code class="cos-msg-attach-el-attr-key">{k}</code>
                    <code class="cos-msg-attach-el-attr-val">{attrs[k]}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  elementRefs,
}: {
  attachments?: CosImageAttachment[];
  elementRefs?: CosElementRef[];
}) {
  const hasImgs = !!(attachments && attachments.length > 0);
  const hasEls = !!(elementRefs && elementRefs.length > 0);
  if (!hasImgs && !hasEls) return null;
  return (
    <div class="cos-msg-attachments">
      {hasImgs && (
        <div class="cos-msg-attach-imgs">
          {attachments!.map((att, i) => (
            <MessageImageThumb key={i} src={att.dataUrl} name={att.name} />
          ))}
        </div>
      )}
      {hasEls && (
        <div class="cos-msg-attach-els">
          {elementRefs!.map((info, i) => (
            <MessageElementChip key={i} info={info} />
          ))}
        </div>
      )}
    </div>
  );
}
