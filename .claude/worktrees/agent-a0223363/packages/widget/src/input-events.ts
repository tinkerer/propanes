interface ElementInfo {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
}

interface Modifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function elementInfo(el: Element | null): ElementInfo {
  if (!el) return { tagName: '', id: '', className: '', textContent: '' };
  return {
    tagName: el.tagName,
    id: (el as HTMLElement).id || '',
    className: el.className || '',
    textContent: el.textContent?.slice(0, 200) || '',
  };
}

function modifierProps(m?: Modifiers) {
  return {
    ctrlKey: m?.ctrl ?? false,
    shiftKey: m?.shift ?? false,
    altKey: m?.alt ?? false,
    metaKey: m?.meta ?? false,
  };
}

function mouseInit(x: number, y: number, button: number, extra?: Modifiers): MouseEventInit {
  return {
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button,
    buttons: button === 0 ? 1 : button === 2 ? 2 : 4,
    bubbles: true,
    cancelable: true,
    view: window,
    ...modifierProps(extra),
  };
}

// --- Visible cursor overlay ---

const CURSOR_ID = '__pw-virtual-cursor';
let cursorEl: HTMLElement | null = null;
let cursorHideTimer: ReturnType<typeof setTimeout> | null = null;

function getCursor(): HTMLElement {
  if (cursorEl && document.body.contains(cursorEl)) return cursorEl;

  cursorEl = document.createElement('div');
  cursorEl.id = CURSOR_ID;
  Object.assign(cursorEl.style, {
    position: 'fixed',
    zIndex: '2147483647',
    pointerEvents: 'none',
    width: '0',
    height: '0',
    transform: 'translate(-2px, -2px)',
    transition: 'left 0.08s ease-out, top 0.08s ease-out, opacity 0.3s',
    opacity: '0',
  });

  // SVG cursor pointer icon
  cursorEl.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g filter="url(#shadow)">
      <path d="M5 3L19 12L12 13L9 20L5 3Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
    </g>
    <defs>
      <filter id="shadow" x="2" y="1" width="20" height="22" filterUnits="userSpaceOnUse">
        <feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.3"/>
      </filter>
    </defs>
  </svg>
  <div style="position:absolute;top:20px;left:12px;background:#ff4444;color:white;font:bold 9px/1 system-ui;padding:2px 4px;border-radius:3px;white-space:nowrap;opacity:0.9;">AGENT</div>`;

  document.body.appendChild(cursorEl);
  return cursorEl;
}

function showCursorAt(x: number, y: number) {
  const el = getCursor();
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.opacity = '1';

  if (cursorHideTimer) clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => {
    el.style.opacity = '0.4';
  }, 3000);
}

function flashCursor() {
  const el = getCursor();
  el.style.transition = 'none';
  el.style.transform = 'translate(-2px, -2px) scale(0.8)';
  requestAnimationFrame(() => {
    el.style.transition = 'left 0.08s ease-out, top 0.08s ease-out, opacity 0.3s, transform 0.15s ease-out';
    el.style.transform = 'translate(-2px, -2px) scale(1)';
  });
}

// --- Mouse dispatchers ---

export function dispatchMouseMove(x: number, y: number) {
  showCursorAt(x, y);
  const el = document.elementFromPoint(x, y);
  const target = el || document.documentElement;
  target.dispatchEvent(new MouseEvent('mousemove', mouseInit(x, y, 0)));
  return { element: elementInfo(el) };
}

export function dispatchClickAt(x: number, y: number, button = 0) {
  showCursorAt(x, y);
  flashCursor();
  const el = document.elementFromPoint(x, y);
  const target = el || document.documentElement;
  const init = mouseInit(x, y, button);
  target.dispatchEvent(new MouseEvent('mousedown', init));
  target.dispatchEvent(new MouseEvent('mouseup', init));
  target.dispatchEvent(new MouseEvent('click', init));
  return { element: elementInfo(el) };
}

function deepQuerySelectorForHover(root: Element | Document | ShadowRoot, selector: string): Element | null {
  const found = root.querySelector(selector);
  if (found) return found;
  const elements = root.querySelectorAll('*');
  for (const el of elements) {
    if (el.shadowRoot) {
      const deep = deepQuerySelectorForHover(el.shadowRoot, selector);
      if (deep) return deep;
    }
  }
  return null;
}

export function dispatchHover(opts: { selector?: string; x?: number; y?: number; pierceShadow?: boolean }) {
  let el: Element | null;
  if (opts.selector) {
    el = opts.pierceShadow ? deepQuerySelectorForHover(document, opts.selector) : document.querySelector(opts.selector);
    if (!el) throw new Error(`Element not found: ${opts.selector}`);
  } else {
    el = document.elementFromPoint(opts.x ?? 0, opts.y ?? 0);
  }
  const target = el || document.documentElement;
  const rect = target.getBoundingClientRect();
  const cx = opts.x ?? rect.left + rect.width / 2;
  const cy = opts.y ?? rect.top + rect.height / 2;
  showCursorAt(cx, cy);
  const init = mouseInit(cx, cy, 0);
  target.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
  target.dispatchEvent(new MouseEvent('mouseover', init));
  target.dispatchEvent(new MouseEvent('mousemove', init));
  return { element: elementInfo(el) };
}

export function dispatchMouseDown(x: number, y: number, button = 0) {
  showCursorAt(x, y);
  flashCursor();
  const el = document.elementFromPoint(x, y);
  const target = el || document.documentElement;
  target.dispatchEvent(new MouseEvent('mousedown', mouseInit(x, y, button)));
  return { element: elementInfo(el) };
}

export function dispatchMouseUp(x: number, y: number, button = 0) {
  showCursorAt(x, y);
  const el = document.elementFromPoint(x, y);
  const target = el || document.documentElement;
  target.dispatchEvent(new MouseEvent('mouseup', mouseInit(x, y, button)));
  return { element: elementInfo(el) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function dispatchDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 10,
  stepDelayMs = 16,
) {
  showCursorAt(from.x, from.y);
  flashCursor();
  const startEl = document.elementFromPoint(from.x, from.y);
  const target = startEl || document.documentElement;
  target.dispatchEvent(new MouseEvent('mousedown', mouseInit(from.x, from.y, 0)));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    showCursorAt(x, y);
    const el = document.elementFromPoint(x, y) || document.documentElement;
    el.dispatchEvent(new MouseEvent('mousemove', mouseInit(x, y, 0)));
    if (stepDelayMs > 0) await sleep(stepDelayMs);
  }

  const endEl = document.elementFromPoint(to.x, to.y) || document.documentElement;
  endEl.dispatchEvent(new MouseEvent('mouseup', mouseInit(to.x, to.y, 0)));
  return { startElement: elementInfo(startEl), endElement: elementInfo(endEl) };
}

// --- Keyboard helpers ---

const KEY_CODE_MAP: Record<string, string> = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
  Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home',
  End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

function keyToCode(key: string): string {
  if (KEY_CODE_MAP[key]) return KEY_CODE_MAP[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return `Key${upper}`;
    if (upper >= '0' && upper <= '9') return `Digit${upper}`;
  }
  return key;
}

function isPrintable(key: string): boolean {
  return key.length === 1;
}

function keyInit(key: string, modifiers?: Modifiers): KeyboardEventInit {
  return {
    key,
    code: keyToCode(key),
    bubbles: true,
    cancelable: true,
    view: window,
    ...modifierProps(modifiers),
  };
}

function isTypeable(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !type || /^(text|search|url|tel|email|password|number)$/i.test(type);
  }
  return false;
}

function insertCharAtCursor(el: HTMLInputElement | HTMLTextAreaElement, ch: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + ch + after;
  const newPos = start + ch.length;
  el.selectionStart = newPos;
  el.selectionEnd = newPos;
}

// --- Keyboard dispatchers ---

export function dispatchPressKey(key: string, modifiers?: Modifiers) {
  const target = document.activeElement || document.body;
  const init = keyInit(key, modifiers);
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  if (isPrintable(key)) {
    target.dispatchEvent(new KeyboardEvent('keypress', init));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { element: elementInfo(target) };
}

export function dispatchKeyDown(key: string, modifiers?: Modifiers) {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', keyInit(key, modifiers)));
  return { element: elementInfo(target) };
}

export function dispatchKeyUp(key: string, modifiers?: Modifiers) {
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent('keyup', keyInit(key, modifiers)));
  return { element: elementInfo(target) };
}

export async function dispatchTypeText(text: string, selector?: string, charDelayMs = 0) {
  let el: HTMLElement;
  if (selector) {
    const found = document.querySelector(selector) as HTMLElement | null;
    if (!found) throw new Error(`Element not found: ${selector}`);
    found.focus();
    el = found;
  } else {
    el = (document.activeElement as HTMLElement) || document.body;
  }

  const editable = (el as HTMLElement).isContentEditable;
  const typeable = isTypeable(el);

  for (const ch of text) {
    const init = keyInit(ch);
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));

    if (typeable) {
      insertCharAtCursor(el as HTMLInputElement | HTMLTextAreaElement, ch);
    } else if (editable) {
      // For contentEditable, insert via Selection API
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(ch));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.textContent = (el.textContent || '') + ch;
      }
    }

    el.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (charDelayMs > 0) await sleep(charDelayMs);
  }

  // Fire change event at the end for form elements
  if (typeable) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const value = typeable ? (el as HTMLInputElement).value : el.textContent || '';
  return { element: elementInfo(el), length: text.length, value: value.slice(0, 500) };
}
