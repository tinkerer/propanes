// Experimental contenteditable composer used when
// `inlineElementChipsEnabled` is on. Renders text + inline element chips
// in the same flow so picked DOM elements appear *within* the prompt
// rather than in a separate strip above the textarea. Chips can be
// expanded in-place to inspect selector / rect / classes / text, and
// removed via their × button.
//
// Send-time serialization: walks the editor's DOM in order. Text nodes
// emit verbatim; chip nodes emit `[#N tag.class]` markers, where N is the
// 1-based index into the resulting elementRefs array. The agent gets a
// readable in-context reference; the structured ref data still rides
// alongside the message via the existing elementRefs payload.

import { forwardRef } from 'preact/compat';
import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { CosElementRef } from '../../lib/chief-of-staff.js';

export interface CosInlineEditorHandle {
  /** Insert one or more element chips at the current caret position (or
   *  end of content if no selection lives inside the editor). Chip refs
   *  are appended to the editor's internal ref list. */
  insertChips: (refs: CosElementRef[]) => void;
  /** Replace editor content with plain text. Clears all chips. */
  setText: (text: string) => void;
  /** Read serialized prompt text + element refs in document order. */
  getValue: () => { text: string; refs: CosElementRef[] };
  /** Focus the editor and place caret at end. */
  focus: () => void;
  /** Move keyboard focus away (used by hooks expecting a `blur` shape). */
  blur: () => void;
  /** True if the editor has no text and no chips. */
  isEmpty: () => boolean;
}

export interface CosInlineEditorProps {
  placeholder: string;
  disabled?: boolean;
  /** Called whenever content changes — fires with the current serialized
   *  text + refs. Caller mirrors into composer-level state. */
  onChange: (text: string, refs: CosElementRef[]) => void;
  /** Called on Enter (without shift). Caller decides whether to submit. */
  onSubmit: () => void;
  /** Called on Escape. Returning true means "handled, skip default". */
  onEscape?: () => boolean;
  /** Optional clipboard handler — used to forward image paste to the
   *  composer's existing addImageBlob path. */
  onPaste?: (e: ClipboardEvent) => void;
  /** Inline style applied to the editor root. Mirrors the textarea's
   *  inputStyle prop so the bubble's manual resize handle still works. */
  style?: JSX.CSSProperties;
  /** Auto-grow up to maxPx based on scrollHeight. */
  autoGrow?: { maxPx: number };
  /** Initial content (plain text). The editor only honors this on mount;
   *  later changes go through the imperative `setText`. */
  initialText?: string;
}

/** What we render for an attached element. Kept short so chips stay
 *  inline-friendly even when the page selector is long. */
function chipLabel(ref: CosElementRef): string {
  let out = ref.tagName || 'element';
  if (ref.id) out += `#${ref.id}`;
  const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
  if (cls.length) out += '.' + cls.join('.');
  return out;
}

/** Serialize for the outgoing prompt — agents see a stable bracketed
 *  marker that ties back to the structured ref array. */
function chipMarker(idx1: number, ref: CosElementRef): string {
  return `[#${idx1} ${chipLabel(ref)}]`;
}

/** Walk the editor and produce { text, refs } in document order. Chips
 *  are stamped with `data-ref-id` so we can match the DOM node back to
 *  its CosElementRef regardless of how the operator rearranged things.
 *  Chip subtrees are intentionally skipped — their visible label /
 *  expand body would otherwise leak into the prompt as raw text. */
function serializeEditor(root: HTMLElement, refIndex: Map<string, CosElementRef>): { text: string; refs: CosElementRef[] } {
  const orderedRefs: CosElementRef[] = [];
  let text = '';

  function visit(node: Node, isRoot: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains('cos-inline-el-chip')) {
      const id = el.getAttribute('data-ref-id') || '';
      const ref = refIndex.get(id);
      if (ref) {
        orderedRefs.push(ref);
        text += chipMarker(orderedRefs.length, ref);
      }
      return;
    }
    if (el.tagName === 'BR') {
      text += '\n';
      return;
    }
    // contenteditable wraps new paragraphs in <div>/<p>. Emit a newline
    // before the block opens so multi-line input round-trips through
    // serialization without losing structure. Skip the root itself.
    if (!isRoot && (el.tagName === 'DIV' || el.tagName === 'P')) {
      if (text && !text.endsWith('\n')) text += '\n';
    }
    for (const child of Array.from(el.childNodes)) visit(child, false);
  }

  visit(root, true);
  return { text, refs: orderedRefs };
}

let chipIdCounter = 0;
function nextChipId(): string {
  chipIdCounter += 1;
  return `chip-${Date.now()}-${chipIdCounter}`;
}

/** Build the DOM for one chip. Click the header to toggle the expand
 *  panel; click × to remove. Both interactions update editor state via
 *  the click handler attached at the editor root (event delegation). */
function buildChipNode(refId: string, ref: CosElementRef): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'cos-inline-el-chip';
  wrap.setAttribute('data-ref-id', refId);
  wrap.setAttribute('contenteditable', 'false');

  const header = document.createElement('span');
  header.className = 'cos-inline-el-chip-header';
  header.setAttribute('data-chip-action', 'toggle');
  header.setAttribute('title', ref.selector);

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '10');
  icon.setAttribute('height', '10');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z');
  icon.appendChild(path);
  header.appendChild(icon);

  const code = document.createElement('code');
  code.textContent = chipLabel(ref);
  header.appendChild(code);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cos-inline-el-chip-remove';
  remove.setAttribute('data-chip-action', 'remove');
  remove.setAttribute('title', 'Remove element reference');
  remove.setAttribute('aria-label', 'Remove element reference');
  remove.textContent = '×';

  wrap.appendChild(header);
  wrap.appendChild(remove);
  return wrap;
}

function buildExpandBody(ref: CosElementRef): HTMLElement {
  const body = document.createElement('span');
  body.className = 'cos-inline-el-chip-body';
  body.setAttribute('contenteditable', 'false');

  function row(label: string, value: string, multiline = false): HTMLElement {
    const r = document.createElement('span');
    r.className = 'cos-inline-el-chip-row';
    const l = document.createElement('span');
    l.className = 'cos-inline-el-chip-label';
    l.textContent = label;
    const v = document.createElement('code');
    v.className = 'cos-inline-el-chip-value' + (multiline ? ' cos-inline-el-chip-value-multiline' : '');
    v.textContent = value;
    r.appendChild(l);
    r.appendChild(v);
    return r;
  }

  body.appendChild(row('selector', ref.selector));
  if (ref.boundingRect) {
    const br = ref.boundingRect;
    body.appendChild(row('rect', `x:${Math.round(br.x)} y:${Math.round(br.y)} w:${Math.round(br.width)} h:${Math.round(br.height)}`));
  }
  if (ref.classes && ref.classes.length > 0) {
    body.appendChild(row('classes', ref.classes.join(' ')));
  }
  if (ref.textContent) {
    body.appendChild(row('text', ref.textContent, true));
  }
  const attrKeys = Object.keys(ref.attributes || {});
  if (attrKeys.length > 0) {
    const attrs = (ref.attributes || {});
    const lines = attrKeys.map((k) => `${k}="${attrs[k]}"`).join('\n');
    body.appendChild(row('attributes', lines, true));
  }
  return body;
}

export const CosInlineEditor = forwardRef<CosInlineEditorHandle, CosInlineEditorProps>(function CosInlineEditor({
  placeholder,
  disabled,
  onChange,
  onSubmit,
  onEscape,
  onPaste,
  style,
  autoGrow,
  initialText,
}, handleRef) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Saved selection range — captured on blur so we can restore the caret
  // when the picker callback fires later (operator clicks elsewhere
  // between picker-start and picker-capture, so the editor loses focus).
  const savedRangeRef = useRef<{ node: Node; offset: number } | null>(null);
  // Stable id → ref map. Chip DOM nodes carry data-ref-id; we look up
  // through this map on serialize so we never rely on closures or React
  // state for the source-of-truth ref data.
  const refIndexRef = useRef<Map<string, CosElementRef>>(new Map());
  const [empty, setEmpty] = useState(true);

  // One-time initial-text seed. Subsequent updates come through `setText`.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (initialText) {
      root.textContent = initialText;
      setEmpty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function recomputeEmpty(root: HTMLElement) {
    const hasChips = root.querySelector('.cos-inline-el-chip') !== null;
    const text = (root.textContent || '').trim();
    setEmpty(!hasChips && text.length === 0);
  }

  function fireChange() {
    const root = rootRef.current;
    if (!root) return;
    const { text, refs } = serializeEditor(root, refIndexRef.current);
    // Prune ref index of any chips that have been removed from the DOM —
    // otherwise removed chips keep stale entries around and could leak
    // into a future picker insert if id collision ever happened.
    const surviving = new Set<string>();
    root.querySelectorAll('.cos-inline-el-chip').forEach((el) => {
      const id = (el as HTMLElement).getAttribute('data-ref-id');
      if (id) surviving.add(id);
    });
    for (const key of Array.from(refIndexRef.current.keys())) {
      if (!surviving.has(key)) refIndexRef.current.delete(key);
    }
    recomputeEmpty(root);
    if (autoGrow) {
      root.style.height = 'auto';
      root.style.height = Math.min(root.scrollHeight, autoGrow.maxPx) + 'px';
    }
    onChange(text, refs);
  }

  function saveSelection() {
    const root = rootRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer)) return;
    savedRangeRef.current = { node: r.startContainer, offset: r.startOffset };
  }

  function placeCaretAtEnd(root: HTMLElement) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  useImperativeHandle(handleRef, (): CosInlineEditorHandle => ({
    insertChips(refs) {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const sel = window.getSelection();
      let range: Range;
      // Prefer the live selection if it still lives inside the editor —
      // operator may have clicked back in. Otherwise restore from the
      // last-known caret. As a final fallback, append at end.
      if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)) {
        range = sel.getRangeAt(0);
      } else if (savedRangeRef.current && root.contains(savedRangeRef.current.node)) {
        range = document.createRange();
        try {
          range.setStart(savedRangeRef.current.node, savedRangeRef.current.offset);
          range.collapse(true);
        } catch {
          range = document.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
        }
      } else {
        range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
      }
      // Insert each chip + a trailing space so the caret can keep typing
      // past it (chips are contenteditable=false; without a text node
      // after, browsers tend to trap the caret).
      for (const ref of refs) {
        const id = nextChipId();
        refIndexRef.current.set(id, ref);
        const node = buildChipNode(id, ref);
        range.insertNode(node);
        range.setStartAfter(node);
        const space = document.createTextNode(' ');
        range.insertNode(space);
        range.setStartAfter(space);
        range.collapse(true);
      }
      const live = window.getSelection();
      if (live) { live.removeAllRanges(); live.addRange(range); }
      saveSelection();
      fireChange();
    },
    setText(text: string) {
      const root = rootRef.current;
      if (!root) return;
      // Wipe content + ref map. setText is the "load draft" /
      // "clear after send" path, so chips don't persist into the new state.
      refIndexRef.current.clear();
      root.textContent = text;
      placeCaretAtEnd(root);
      saveSelection();
      fireChange();
    },
    getValue() {
      const root = rootRef.current;
      if (!root) return { text: '', refs: [] };
      return serializeEditor(root, refIndexRef.current);
    },
    focus() {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      placeCaretAtEnd(root);
    },
    blur() {
      rootRef.current?.blur();
    },
    isEmpty() {
      const root = rootRef.current;
      if (!root) return true;
      const hasChips = root.querySelector('.cos-inline-el-chip') !== null;
      const text = (root.textContent || '').trim();
      return !hasChips && text.length === 0;
    },
  }), []);

  function onClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const chip = target.closest('.cos-inline-el-chip') as HTMLElement | null;
    if (!chip) return;
    const action = (target.closest('[data-chip-action]') as HTMLElement | null)?.getAttribute('data-chip-action');
    if (action === 'remove') {
      e.preventDefault();
      e.stopPropagation();
      // Remove a single trailing whitespace if present, so the gap left
      // behind matches the gap inserted with the chip.
      const next = chip.nextSibling;
      chip.remove();
      if (next && next.nodeType === Node.TEXT_NODE && next.textContent === ' ') {
        next.parentNode?.removeChild(next);
      }
      fireChange();
      return;
    }
    if (action === 'toggle') {
      e.preventDefault();
      e.stopPropagation();
      const refId = chip.getAttribute('data-ref-id') || '';
      const ref = refIndexRef.current.get(refId);
      if (!ref) return;
      const open = chip.classList.toggle('cos-inline-el-chip-open');
      const existingBody = chip.querySelector('.cos-inline-el-chip-body');
      if (open && !existingBody) {
        chip.appendChild(buildExpandBody(ref));
      } else if (!open && existingBody) {
        existingBody.remove();
      }
      // Don't fire change — toggling the panel doesn't alter prompt text.
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === 'Escape') {
      if (onEscape && onEscape()) {
        e.preventDefault();
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      if (root.textContent || root.querySelector('.cos-inline-el-chip')) {
        e.preventDefault();
        refIndexRef.current.clear();
        root.textContent = '';
        fireChange();
      }
    }
  }

  function onInput() {
    saveSelection();
    fireChange();
  }

  function onBlur() {
    saveSelection();
  }

  function onPasteEvent(e: ClipboardEvent) {
    if (onPaste) onPaste(e);
    if (e.defaultPrevented) return;
    // Force plain-text paste so the editor stays clean. Browsers often
    // paste rich HTML by default which would smuggle styles in.
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text);
  }

  return (
    <div
      class="cos-inline-editor"
      ref={rootRef}
      contentEditable={!disabled}
      data-empty={empty || undefined}
      data-placeholder={placeholder}
      role="textbox"
      aria-multiline="true"
      aria-disabled={disabled || undefined}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onInput={onInput}
      onBlur={onBlur}
      onPaste={onPasteEvent}
      spellcheck={true}
    />
  );
});
