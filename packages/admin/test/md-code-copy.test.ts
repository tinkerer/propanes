import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import {
  installMarkdownCodeCopy,
  wrapCodeBlock,
  codeTextForButton,
  CODE_BLOCK_CLASS,
  COPY_BUTTON_CLASS,
} from '../src/lib/md-code-copy.js';

test('fenced code blocks render with a wrapper and copy button', () => {
  installMarkdownCodeCopy();
  installMarkdownCodeCopy(); // idempotent — must not double-wrap
  const html = marked.parse('before\n\n```ts\nconst a = "<b>";\n```\n\nafter') as string;
  assert.equal(html.match(new RegExp(`class="${CODE_BLOCK_CLASS}"`, 'g'))?.length, 1);
  assert.equal(html.match(new RegExp(`${COPY_BUTTON_CLASS}`, 'g'))?.length, 1);
  // Default renderer output is preserved: language class + escaped content.
  assert.match(html, /<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot;;\n<\/code><\/pre>/);
  // Button is a sibling of the <pre>, inside the wrapper, after the code.
  assert.match(html, /<\/pre><button type="button" class="sm-copy-btn md-code-copy"[^>]*aria-label="Copy code">/);
  assert.match(html, /<\/button><\/div>\n<p>after<\/p>/);
  // Inline code is untouched.
  assert.equal(marked.parse('say `hi`') as string, '<p>say <code>hi</code></p>\n');
});

test('wrapCodeBlock keeps a single trailing newline', () => {
  const out = wrapCodeBlock('<pre><code>x</code></pre>\n');
  assert.ok(out.startsWith(`<div class="${CODE_BLOCK_CLASS}"><pre><code>x</code></pre><button`));
  assert.ok(out.endsWith('</div>\n'));
});

test('codeTextForButton copies the code, not the button label', () => {
  // Minimal element stand-ins — no DOM in node:test.
  const code = { textContent: 'line1\nline2\n', querySelector: () => null };
  const pre = { querySelector: (sel: string) => (sel === 'code' ? code : null) };
  const block = { querySelector: (sel: string) => (sel === 'pre' ? pre : null) };
  const btn = { closest: (sel: string) => (sel === `.${CODE_BLOCK_CLASS}` ? block : null) };
  assert.equal(codeTextForButton(btn as unknown as Element), 'line1\nline2');
  const orphan = { closest: () => null };
  assert.equal(codeTextForButton(orphan as unknown as Element), '');
});
