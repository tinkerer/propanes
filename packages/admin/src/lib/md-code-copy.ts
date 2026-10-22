// Copy button for fenced code blocks rendered through `marked`.
//
// Every markdown surface in the admin (`.sm-md-rendered`, `.cos-md-prose`,
// `.fv-markdown`, spec/wiki pages…) injects marked's HTML via
// dangerouslySetInnerHTML, so there is no component boundary per `<pre>` to
// hang a Preact button on. Instead we extend marked's `code` renderer once so
// every block ships wrapped as
//
//   <div class="md-code-block"><pre><code>…</code></pre><button class="md-code-copy">…</button></div>
//
// and a single capture-phase click listener on `document` copies the block's
// text. Capture phase matters: some containers (e.g. the CoS prose) have their
// own onClick handlers and must not see the click.

import { marked } from 'marked';
import { copyText } from './clipboard.js';

export const CODE_BLOCK_CLASS = 'md-code-block';
export const COPY_BUTTON_CLASS = 'md-code-copy';
const COPIED_RESET_MS = 1400;

const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

export const COPY_BUTTON_HTML =
  `<button type="button" class="sm-copy-btn ${COPY_BUTTON_CLASS}" title="Copy code" aria-label="Copy code">` +
  `${COPY_ICON}<span class="sm-copy-btn-label">Copy</span></button>`;

/** Wrap a rendered `<pre>…</pre>` block with the copy-button container. */
export function wrapCodeBlock(preHtml: string): string {
  return `<div class="${CODE_BLOCK_CLASS}">${preHtml.replace(/\n$/, '')}${COPY_BUTTON_HTML}</div>\n`;
}

/** Text a copy button should put on the clipboard: the code, not the button label. */
export function codeTextForButton(btn: Element): string {
  const block = btn.closest(`.${CODE_BLOCK_CLASS}`);
  const pre = block?.querySelector('pre');
  if (!pre) return '';
  const code = pre.querySelector('code') ?? pre;
  return (code.textContent ?? '').replace(/\n$/, '');
}

let installed = false;

/**
 * Idempotent. Call once at app startup (main.tsx). Safe to call from tests
 * without a DOM — the click listener is only attached when `document` exists.
 */
export function installMarkdownCodeCopy(): void {
  if (installed) return;
  installed = true;

  const base = new marked.Renderer();
  marked.use({
    renderer: {
      code(token) {
        return wrapCodeBlock(base.code.call(this, token));
      },
    },
  });

  if (typeof document === 'undefined') return;
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null;
      const btn = target?.closest?.(`.${COPY_BUTTON_CLASS}`);
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      copyText(codeTextForButton(btn));
      const label = btn.querySelector('.sm-copy-btn-label');
      btn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      setTimeout(() => {
        btn.classList.remove('copied');
        if (label) label.textContent = 'Copy';
      }, COPIED_RESET_MS);
    },
    true,
  );
}
