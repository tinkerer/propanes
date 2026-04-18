import { signal } from '@preact/signals';
import { shortcutsEnabled } from './settings.js';

export interface Shortcut {
  key: string;
  code?: string; // e.g. 'Digit1' — matches e.code instead of e.key
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  sequence?: string; // e.g. "g f" — first key already matched, this is the second
  label: string;
  category: 'Navigation' | 'Panels' | 'General';
  action: () => void;
}

export const ctrlShiftHeld = signal(false);

const registry: Shortcut[] = [];
let pendingSequence: string | null = null;
let sequenceTimer: ReturnType<typeof setTimeout> | null = null;

export function registerShortcut(shortcut: Shortcut): () => void {
  registry.push(shortcut);
  return () => {
    const idx = registry.indexOf(shortcut);
    if (idx >= 0) registry.splice(idx, 1);
  };
}

export function getAllShortcuts(): Shortcut[] {
  return [...registry];
}

function isInputFocused(): boolean {
  let el: Element | null = document.activeElement;
  if (!el) return false;
  // Traverse into shadow roots — when focus is inside a Shadow DOM,
  // document.activeElement returns the host element, not the inner target.
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable) {
    return true;
  }
  // xterm.js terminals live inside .xterm containers — treat them as input targets
  // so global shortcuts don't steal keystrokes from the PTY
  if (el.closest?.('.xterm')) return true;
  return false;
}

function matchesModifiers(e: KeyboardEvent, mods?: Shortcut['modifiers']): boolean {
  const ctrl = mods?.ctrl || false;
  const shift = mods?.shift || false;
  const alt = mods?.alt || false;
  const meta = mods?.meta || false;
  const eCtrl = stickyMode || e.ctrlKey;
  const eShift = stickyMode || e.shiftKey;
  return eCtrl === ctrl && eShift === shift && e.altKey === alt && e.metaKey === meta;
}

function normalizeCode(code: string): string {
  const m = code.match(/^Numpad(\d)$/);
  return m ? `Digit${m[1]}` : code;
}

function handleKeyDown(e: KeyboardEvent) {
  if (!shortcutsEnabled.value) return;
  const code = normalizeCode(e.code);
  const ctrlOrMeta = stickyMode || e.ctrlKey || e.metaKey;
  const shiftHeld = stickyMode || e.shiftKey;
  const inXterm = !!document.activeElement?.closest?.('.xterm');
  if (!stickyMode && isInputFocused() && (e.key !== 'Escape' || inXterm)) {
    // Spotlight shortcut works from any context
    if (ctrlOrMeta && shiftHeld && e.code === 'Space') { /* allow through */ }
    else if (ctrlOrMeta && e.key === 'k') { /* allow through */ }
    else {
      const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
      const isDigit = /^Digit[0-9]$/.test(code);
      const isMinusEqual = code === 'Minus' || code === 'Equal';
      const isSessionAction = code === 'KeyW' || code === 'KeyR' || code === 'KeyK' || code === 'KeyP' || code === 'KeyB' || code === 'KeyA' || code === 'KeyX' || code === 'KeyE';
      const isBackquote = code === 'Backquote';
      const isTab = e.key === 'Tab';
      const isPipe = code === 'Backslash' && shiftHeld;
      // Panel shortcuts (digits, minus, equal, close, backquote, tab, pipe) work from any input;
      // arrows only pass through in xterm (Ctrl+Shift+Arrow is text selection in normal inputs)
      const allowedInAnyInput = ctrlOrMeta && shiftHeld && (isDigit || isMinusEqual || isSessionAction || isBackquote || isTab || isPipe);
      const allowedInXterm = inXterm && ctrlOrMeta && shiftHeld && isArrow;
      if (!(allowedInAnyInput || allowedInXterm)) return;
    }
  }

  // Handle second key in sequence
  if (pendingSequence) {
    const prefix = pendingSequence;
    clearSequence();
    const combo = `${prefix} ${e.key}`;
    for (const s of registry) {
      if (s.sequence === combo && matchesModifiers(e, s.modifiers)) {
        e.preventDefault();
        e.stopPropagation();
        s.action();
        return;
      }
    }
    return;
  }

  // Check for sequence starters (single char that begins a two-key combo)
  const sequenceStarters = new Set(
    registry
      .filter((s) => s.sequence)
      .map((s) => s.sequence!.split(' ')[0])
  );

  if (sequenceStarters.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const directMatch = registry.find(
      (s) => !s.sequence && s.key === e.key && matchesModifiers(e, s.modifiers)
    );
    if (!directMatch) {
      e.preventDefault();
      pendingSequence = e.key;
      sequenceTimer = setTimeout(clearSequence, 1000);
      return;
    }
  }

  // Direct single-key shortcuts (normalize numpad codes)
  for (const s of registry) {
    if (s.sequence) continue;
    const keyMatch = s.code ? s.code === code : s.key === e.key;
    if (keyMatch && matchesModifiers(e, s.modifiers)) {
      e.preventDefault();
      e.stopPropagation();
      s.action();
      return;
    }
  }
}

function clearSequence() {
  pendingSequence = null;
  if (sequenceTimer) {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  }
}

// Track Ctrl+Shift held state for tab number overlay
let stickyMode = false;
let stickyArmed = false; // true once all modifiers released after activation
let stickyPrevFocus: Element | null = null;
const shiftTaps: number[] = [];

function updateCtrlShift(e: KeyboardEvent) {
  if (stickyMode) return;
  ctrlShiftHeld.value = e.ctrlKey && e.shiftKey;
}

function clearCtrlShift() {
  if (stickyMode) return;
  ctrlShiftHeld.value = false;
}

function handleStickyShortcut(e: KeyboardEvent) {
  if (e.key !== 'Shift' || e.repeat) return;
  if (!(e.ctrlKey || e.metaKey)) {
    shiftTaps.length = 0;
    return;
  }

  // Exit: only if armed (user fully released modifiers after activation)
  if (stickyMode && stickyArmed) {
    e.preventDefault();
    e.stopImmediatePropagation();
    exitStickyMode();
    return;
  }

  if (stickyMode) return; // not armed yet, ignore

  const now = Date.now();
  shiftTaps.push(now);
  while (shiftTaps.length > 0 && now - shiftTaps[0] > 800) shiftTaps.shift();

  if (shiftTaps.length >= 3) {
    shiftTaps.length = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
    stickyMode = true;
    stickyArmed = false;
    ctrlShiftHeld.value = true;
    stickyPrevFocus = document.activeElement;
    (document.activeElement as HTMLElement)?.blur?.();
  }
}

function handleStickyKeys(e: KeyboardEvent) {
  if (!stickyMode) return;
  // Ignore modifier keys themselves
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
    e.stopImmediatePropagation();
    return;
  }
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    exitStickyMode();
    return;
  }
  // Run shortcuts as if Ctrl+Shift were held, then swallow
  handleKeyDown(e);
  e.preventDefault();
  e.stopImmediatePropagation();
}

function handleStickyKeyUp(e: KeyboardEvent) {
  if (!stickyMode) {
    updateCtrlShift(e);
    return;
  }
  e.stopImmediatePropagation();
  // Arm exit once all modifiers are released after activation
  if (!stickyArmed && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    stickyArmed = true;
  }
}

function exitStickyMode() {
  stickyMode = false;
  stickyArmed = false;
  ctrlShiftHeld.value = false;
  if (stickyPrevFocus instanceof HTMLElement) {
    stickyPrevFocus.focus();
  }
  stickyPrevFocus = null;
}

// Install global handler
// Capture phase so we intercept before xterm.js processes the event
document.addEventListener('keydown', (e) => { handleStickyShortcut(e); if (stickyMode) { handleStickyKeys(e); return; } updateCtrlShift(e); handleKeyDown(e); }, true);
document.addEventListener('keyup', handleStickyKeyUp, true);
window.addEventListener('blur', clearCtrlShift);
