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

export const TABLE_BLOCK_CLASS = 'md-table-block';
export const TABLE_COPY_CLASS = 'md-table-copy';
export const TABLE_DOWNLOAD_CLASS = 'md-table-download';

const DOWNLOAD_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

export const TABLE_ACTIONS_HTML =
  `<div class="md-table-actions">` +
  `<button type="button" class="sm-copy-btn ${TABLE_COPY_CLASS}" title="Copy table (tab-separated, pastes into spreadsheets)" aria-label="Copy table">${COPY_ICON}<span class="sm-copy-btn-label">Copy</span></button>` +
  `<button type="button" class="sm-copy-btn ${TABLE_DOWNLOAD_CLASS}" title="Download table as CSV" aria-label="Download table as CSV">${DOWNLOAD_ICON}<span class="sm-copy-btn-label">CSV</span></button>` +
  `</div>`;

/** Wrap a rendered `<table>…</table>` with the copy/download toolbar. */
export function wrapTableBlock(tableHtml: string): string {
  return `<div class="${TABLE_BLOCK_CLASS}">${TABLE_ACTIONS_HTML}<div class="md-table-scroll">${tableHtml.replace(/\n$/, '')}</div></div>\n`;
}

/** Rows of cell text for the table behind a toolbar button. */
export function tableRowsForButton(btn: Element): string[][] {
  const table = btn.closest(`.${TABLE_BLOCK_CLASS}`)?.querySelector('table');
  if (!table) return [];
  return Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children).map((c) => (c.textContent ?? '').trim()),
  );
}

export function rowsToTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

export function rowsToCsv(rows: string[][]): string {
  const q = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}

function flashButton(btn: Element, done: string, idle: string): void {
  const label = btn.querySelector('.sm-copy-btn-label');
  btn.classList.add('copied');
  if (label) label.textContent = done;
  setTimeout(() => {
    btn.classList.remove('copied');
    if (label) label.textContent = idle;
  }, COPIED_RESET_MS);
}

function downloadCsv(csv: string): void {
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `table-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      table(token) {
        return wrapTableBlock(base.table.call(this, token));
      },
    },
  });

  if (typeof document === 'undefined') return;
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null;
      const tblBtn = target?.closest?.(`.${TABLE_COPY_CLASS}, .${TABLE_DOWNLOAD_CLASS}`);
      if (tblBtn) {
        e.preventDefault();
        e.stopPropagation();
        const rows = tableRowsForButton(tblBtn);
        if (tblBtn.classList.contains(TABLE_COPY_CLASS)) {
          copyText(rowsToTsv(rows));
          flashButton(tblBtn, 'Copied', 'Copy');
        } else {
          downloadCsv(rowsToCsv(rows));
          flashButton(tblBtn, 'Saved', 'CSV');
        }
        return;
      }
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
