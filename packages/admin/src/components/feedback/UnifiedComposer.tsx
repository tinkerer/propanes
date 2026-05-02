import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { captureScreenshot, type ScreenshotMethod } from '@propanes/widget/screenshot';
import { startPicker, type SelectedElementInfo } from '@propanes/widget/element-picker';
import { VoiceRecorder, type VoiceRecordingResult } from '@propanes/widget/voice-recorder';
import { snapshotConsole, type ConsoleEntry } from '../../lib/console-buffer.js';

// Single composer used by InterruptBar (resume/interrupt session) and
// CosComposer (CoS thread reply). Owns:
//   - textarea (auto-resize, paste-image, Enter-to-submit / Shift+Enter newline)
//   - attachment chips (image previews, DOM element refs, console capture, voice)
//   - expand-toggle popover menu with Screenshot / DOM-pick / Console / Mic
//     each with inline option toggles (mirrors widget menus)
//   - draft autosave/restore against /api/v1/admin/drafts/:key when draftKey is set
//
// Submit hand-off: callers receive raw blobs + structured attachments via
// onSubmit and decide what to do with them — InterruptBar uploads to
// /api/v1/screenshots and inlines URLs into a single resume prompt;
// CosComposer hands them to sendChiefOfStaffMessage which packs dataUrls.
//
// CSS contract: outer container uses the className prop. Internal class
// names use the `.interrupt-bar-*` vocabulary (matching the existing
// stylesheet) so existing CSS keeps working when className='interrupt-bar'
// and degrades gracefully (still functional, plain) under other parents.

export type SubmitIcon = 'send' | 'interrupt';

export type UnifiedComposerData = {
  text: string;
  images: Blob[];
  imageNames: string[];
  elements: SelectedElementInfo[];
  consoleEntries: ConsoleEntry[] | null;
  voice: VoiceRecordingResult | null;
};

export type UnifiedComposerProps = {
  onSubmit: (data: UnifiedComposerData) => Promise<void> | void;
  placeholder: string;
  submitTitle: string;
  submitIcon?: SubmitIcon;
  submitAriaLabel?: string;
  disabled?: boolean;
  draftKey?: string;
  initialText?: string;
  className?: string;
  /** Signals an external error to render inline (e.g. last resume error). */
  error?: string | null;
  /** Called when the operator hits Escape on an empty textarea — used by the
   *  thread panel to bounce up to "drop reply scope". */
  onEscapeWhenEmpty?: () => void;
  /** Auto-grow textarea row count while typing. Default 1 (matches InterruptBar). */
  rows?: number;
};

type PendingImage = {
  id: string;
  blob: Blob;
  previewUrl: string;
  name: string;
};

const DRAFT_DEBOUNCE_MS = 300;

async function pushDraft(key: string, payload: { text: string; attachmentsJson?: string }): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`/api/v1/admin/drafts/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });
  } catch { /* best-effort */ }
}

async function clearDraft(key: string): Promise<void> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`/api/v1/admin/drafts/${encodeURIComponent(key)}`, { method: 'DELETE', headers });
  } catch { /* best-effort */ }
}

async function loadDraft(key: string): Promise<{ text: string } | null> {
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`/api/v1/admin/drafts/${encodeURIComponent(key)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data === 'object' && data.exists) {
      return { text: typeof data.text === 'string' ? data.text : '' };
    }
  } catch { /* ignore */ }
  return null;
}

export function UnifiedComposer({
  onSubmit,
  placeholder,
  submitTitle,
  submitIcon = 'send',
  submitAriaLabel,
  disabled,
  draftKey,
  initialText,
  className,
  error: externalError,
  onEscapeWhenEmpty,
  rows = 1,
}: UnifiedComposerProps) {
  const [text, setText] = useState<string>(initialText ?? '');
  const [submitting, setSubmitting] = useState(false);
  // Synchronous mirror of `submitting` — guards against rapid re-entry from
  // double-fired touch/click + keydown events (iOS) before React has applied
  // the state update. Without this, two calls in the same tick both close
  // over `submitting=false` and slip past the state guard.
  const submittingRef = useRef(false);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [elements, setElements] = useState<SelectedElementInfo[]>([]);
  const [consoleCap, setConsoleCap] = useState<ConsoleEntry[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerActive, setPickerActive] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);

  // Option state mirroring the widget menus
  const [shotMethod, setShotMethod] = useState<ScreenshotMethod>('html-to-image');
  const [shotExcludeCursor, setShotExcludeCursor] = useState(true);
  const [shotExcludeWidget, setShotExcludeWidget] = useState(false);
  const [domMultiSelect, setDomMultiSelect] = useState(true);
  const [domIncludeChildren, setDomIncludeChildren] = useState(false);
  const [domExcludeWidget, setDomExcludeWidget] = useState(false);
  const [micScreenCaptures, setMicScreenCaptures] = useState(false);

  // Microphone state
  const [micRecording, setMicRecording] = useState(false);
  const [micElapsed, setMicElapsed] = useState(0);
  const [voiceResult, setVoiceResult] = useState<VoiceRecordingResult | null>(null);
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const micTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micStartRef = useRef<number>(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const submitGroupRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pickerCleanupRef = useRef<(() => void) | null>(null);
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);

  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftLoadedKeyRef = useRef<string | null>(null);

  const error = externalError ?? internalError;

  // Auto-grow textarea height based on content. Cap at 140px to match the
  // interrupt-bar styling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

  // Hydrate from draft on mount / when draftKey changes. Only fires once per
  // key — text typed before the load resolves is preserved as the user input
  // wins over the persisted draft.
  useEffect(() => {
    if (!draftKey) return;
    if (draftLoadedKeyRef.current === draftKey) return;
    draftLoadedKeyRef.current = draftKey;
    let cancelled = false;
    void (async () => {
      const draft = await loadDraft(draftKey);
      if (cancelled) return;
      if (draft && draft.text && !text) setText(draft.text);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Debounced autosave on every keystroke. Empty text deletes the row server-
  // side; the route handles that.
  useEffect(() => {
    if (!draftKey) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      void pushDraft(draftKey, { text });
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, [draftKey, text]);

  // Click-outside to close the expand menu.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(ev: MouseEvent) {
      const target = ev.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  // Position the portal-rendered menu above the submit-group anchor.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    function compute() {
      const anchor = submitGroupRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setMenuPos({
        bottom: window.innerHeight - rect.top + 6,
        right: window.innerWidth - rect.right,
      });
    }
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [menuOpen]);

  // Cleanup on unmount: revoke object URLs, stop pickers, kill mic.
  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      if (pickerCleanupRef.current) pickerCleanupRef.current();
      if (micTimerRef.current) clearInterval(micTimerRef.current);
      if (voiceRecorderRef.current?.recording) {
        voiceRecorderRef.current.stop().catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addImageBlob(blob: Blob, name = 'pasted.png') {
    const previewUrl = URL.createObjectURL(blob);
    setImages((prev) => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      blob,
      previewUrl,
      name,
    }]);
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function onPaste(ev: ClipboardEvent) {
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        ev.preventDefault();
        const blob = item.getAsFile();
        if (blob) addImageBlob(blob, blob.name || 'pasted.png');
      }
    }
  }

  async function takeScreenshot() {
    if (captureBusy) return;
    setCaptureBusy(true);
    setMenuOpen(false);
    try {
      const blob = await captureScreenshot({
        method: shotMethod,
        excludeWidget: shotExcludeWidget,
        excludeCursor: shotExcludeCursor,
      });
      if (blob) addImageBlob(blob, 'screenshot.png');
    } catch (err: any) {
      setInternalError(err?.message || 'Screenshot failed');
    } finally {
      setCaptureBusy(false);
    }
  }

  function startDomPicker() {
    if (pickerActive) return;
    setMenuOpen(false);
    setPickerActive(true);
    const cleanup = startPicker(
      (infos) => {
        pickerCleanupRef.current = null;
        setPickerActive(false);
        if (infos.length === 0) return;
        setElements((prev) => [...prev, ...infos]);
      },
      document.body,
      {
        multiSelect: domMultiSelect,
        excludeWidget: domExcludeWidget,
        includeChildren: domIncludeChildren,
      },
    );
    pickerCleanupRef.current = cleanup;
  }

  function captureConsoleNow() {
    setMenuOpen(false);
    const snap = snapshotConsole();
    setConsoleCap(snap);
  }

  async function toggleMicRecord() {
    if (micRecording) {
      setMicRecording(false);
      if (micTimerRef.current) {
        clearInterval(micTimerRef.current);
        micTimerRef.current = null;
      }
      const rec = voiceRecorderRef.current;
      if (!rec) return;
      try {
        const result = await rec.stop();
        setVoiceResult(result);
      } catch (err: any) {
        setInternalError(err?.message || 'Mic stop failed');
      }
      return;
    }

    setMenuOpen(false);
    setInternalError(null);
    const rec = voiceRecorderRef.current ?? (voiceRecorderRef.current = new VoiceRecorder());
    try {
      await rec.start({ screenCaptures: micScreenCaptures });
      micStartRef.current = Date.now();
      setMicElapsed(0);
      setMicRecording(true);
      micTimerRef.current = setInterval(() => {
        setMicElapsed(Math.floor((Date.now() - micStartRef.current) / 1000));
      }, 500);
    } catch (err: any) {
      setInternalError(err?.message || 'Mic start failed');
    }
  }

  function discardVoice() {
    setVoiceResult(null);
  }

  function removeElement(idx: number) {
    setElements((prev) => prev.filter((_, i) => i !== idx));
  }

  const hasContent = !!text.trim()
    || images.length > 0
    || elements.length > 0
    || !!(consoleCap && consoleCap.length > 0)
    || !!voiceResult;

  async function submit() {
    if (!hasContent) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setInternalError(null);
    try {
      await onSubmit({
        text: text.trim(),
        images: images.map((i) => i.blob),
        imageNames: images.map((i) => i.name),
        elements,
        consoleEntries: consoleCap,
        voice: voiceResult,
      });
      // Reset on success
      setText('');
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      setImages([]);
      setElements([]);
      setConsoleCap(null);
      setVoiceResult(null);
      if (draftKey) {
        if (draftSaveTimerRef.current) {
          clearTimeout(draftSaveTimerRef.current);
          draftSaveTimerRef.current = null;
        }
        void clearDraft(draftKey);
      }
    } catch (err: any) {
      setInternalError(err?.message || String(err));
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void submit();
      return;
    }
    if (ev.key === 'Escape') {
      if (text) {
        ev.preventDefault();
        setText('');
      } else if (onEscapeWhenEmpty) {
        ev.preventDefault();
        onEscapeWhenEmpty();
      }
    }
  }

  const consoleCount = consoleCap?.length ?? 0;
  const showChips = images.length > 0
    || elements.length > 0
    || consoleCap !== null
    || !!voiceResult
    || micRecording;

  const voiceFinalCount = voiceResult?.transcript.filter((t) => t.isFinal).length ?? 0;
  const voiceIxCount = voiceResult?.interactions.length ?? 0;
  const voiceShotCount = voiceResult?.screenshots.length ?? 0;

  return (
    <div class={className} ref={containerRef}>
      {error && <div class="interrupt-bar-error">{error}</div>}
      {showChips && (
        <div class="interrupt-bar-chips">
          {images.map((img) => (
            <div class="cos-attach-thumb" key={img.id}>
              <img src={img.previewUrl} alt={img.name} />
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => removeImage(img.id)}
                title="Remove image"
                aria-label="Remove image"
              >×</button>
            </div>
          ))}
          {elements.map((ref, idx) => {
            let display = ref.tagName || 'element';
            if (ref.id) display += `#${ref.id}`;
            const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
            if (cls.length) display += '.' + cls.join('.');
            return (
              <div class="cos-element-chip" key={`el-${idx}`} title={ref.selector}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
                </svg>
                <code>{display}</code>
                <button
                  type="button"
                  class="cos-attach-remove"
                  onClick={() => removeElement(idx)}
                  title="Remove element"
                  aria-label="Remove element"
                >×</button>
              </div>
            );
          })}
          {consoleCap && (
            <div class="cos-element-chip" title={`${consoleCount} console entries`}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <code>console · {consoleCount} {consoleCount === 1 ? 'entry' : 'entries'}</code>
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => setConsoleCap(null)}
                title="Remove console capture"
                aria-label="Remove console capture"
              >×</button>
            </div>
          )}
          {micRecording && (
            <div class="cos-element-chip interrupt-bar-mic-chip is-recording" title="Recording…">
              <span class="interrupt-bar-mic-dot" aria-hidden="true" />
              <code>recording · {micElapsed}s</code>
              <button
                type="button"
                class="cos-attach-remove"
                onClick={toggleMicRecord}
                title="Stop recording"
                aria-label="Stop recording"
              >■</button>
            </div>
          )}
          {voiceResult && !micRecording && (
            <div class="cos-element-chip" title="Captured voice input">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
              </svg>
              <code>
                mic · {Math.round(voiceResult.duration / 1000)}s
                {voiceFinalCount > 0 ? ` · ${voiceFinalCount} seg` : ''}
                {voiceIxCount > 0 ? ` · ${voiceIxCount} ix` : ''}
                {voiceShotCount > 0 ? ` · ${voiceShotCount} shots` : ''}
              </code>
              <button
                type="button"
                class="cos-attach-remove"
                onClick={discardVoice}
                title="Remove voice capture"
                aria-label="Remove voice capture"
              >×</button>
            </div>
          )}
        </div>
      )}
      <div class="interrupt-bar-row">
        <textarea
          ref={(el) => { textareaRef.current = el; }}
          class="interrupt-bar-input"
          rows={rows}
          placeholder={placeholder}
          value={text}
          disabled={disabled || submitting}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div class="interrupt-bar-submit-group" ref={submitGroupRef}>
          <button
            type="button"
            class={`interrupt-bar-expand-toggle${menuOpen ? ' is-open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            disabled={disabled || submitting}
            aria-expanded={menuOpen}
            aria-label="Attach context"
            title="Attach screenshot, DOM selection, console, or voice capture"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
            </svg>
          </button>
          <button
            type="button"
            class="interrupt-bar-submit"
            disabled={disabled || submitting || !hasContent}
            onClick={() => void submit()}
            title={submitTitle}
            aria-label={submitAriaLabel || (submitIcon === 'interrupt' ? 'Interrupt' : 'Send')}
          >
            {submitting ? (
              <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true" style={{ fill: 'none' }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" style={{ fill: 'none' }}>
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </path>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
          {menuOpen && menuPos && createPortal(
            <div
              class="interrupt-bar-expand-menu"
              role="menu"
              ref={menuRef}
              style={{ position: 'fixed', bottom: `${menuPos.bottom}px`, right: `${menuPos.right}px`, zIndex: 10000 }}
            >
              {/* Screenshot group */}
              <div class="interrupt-bar-expand-group">
                <button
                  type="button"
                  class="interrupt-bar-expand-item"
                  onClick={takeScreenshot}
                  disabled={captureBusy}
                  role="menuitem"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span>{captureBusy ? 'Capturing…' : 'Screenshot'}</span>
                </button>
                <div class="interrupt-bar-expand-options">
                  <label class="interrupt-bar-expand-opt" title="html-to-image is silent; display-media asks for screen-share permission">
                    <input
                      type="checkbox"
                      checked={shotMethod === 'html-to-image'}
                      onChange={(e) => setShotMethod((e.target as HTMLInputElement).checked ? 'html-to-image' : 'display-media')}
                    />
                    <span>html-to-image</span>
                  </label>
                  <label class="interrupt-bar-expand-opt">
                    <input
                      type="checkbox"
                      checked={shotExcludeCursor}
                      onChange={(e) => setShotExcludeCursor((e.target as HTMLInputElement).checked)}
                    />
                    <span>exclude cursor</span>
                  </label>
                  <label class="interrupt-bar-expand-opt">
                    <input
                      type="checkbox"
                      checked={shotExcludeWidget}
                      onChange={(e) => setShotExcludeWidget((e.target as HTMLInputElement).checked)}
                    />
                    <span>exclude widget</span>
                  </label>
                </div>
              </div>

              {/* DOM select group */}
              <div class="interrupt-bar-expand-group">
                <button
                  type="button"
                  class="interrupt-bar-expand-item"
                  onClick={startDomPicker}
                  disabled={pickerActive}
                  role="menuitem"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 3h4V1H1v6h2V3zm0 14H1v6h6v-2H3v-4zm14 4h-4v2h6v-6h-2v4zM17 3V1h6v6h-2V3h-4z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  <span>{pickerActive ? 'Picking…' : 'DOM select'}</span>
                </button>
                <div class="interrupt-bar-expand-options">
                  <label class="interrupt-bar-expand-opt">
                    <input
                      type="checkbox"
                      checked={domMultiSelect}
                      onChange={(e) => setDomMultiSelect((e.target as HTMLInputElement).checked)}
                    />
                    <span>multi-select</span>
                  </label>
                  <label class="interrupt-bar-expand-opt">
                    <input
                      type="checkbox"
                      checked={domIncludeChildren}
                      onChange={(e) => setDomIncludeChildren((e.target as HTMLInputElement).checked)}
                    />
                    <span>include children</span>
                  </label>
                  <label class="interrupt-bar-expand-opt">
                    <input
                      type="checkbox"
                      checked={domExcludeWidget}
                      onChange={(e) => setDomExcludeWidget((e.target as HTMLInputElement).checked)}
                    />
                    <span>exclude widget</span>
                  </label>
                </div>
              </div>

              {/* Console capture (no options) */}
              <div class="interrupt-bar-expand-group">
                <button
                  type="button"
                  class="interrupt-bar-expand-item"
                  onClick={captureConsoleNow}
                  role="menuitem"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  <span>Console capture</span>
                </button>
              </div>

              {/* Microphone group */}
              <div class="interrupt-bar-expand-group">
                <button
                  type="button"
                  class={`interrupt-bar-expand-item${micRecording ? ' is-recording' : ''}`}
                  onClick={toggleMicRecord}
                  role="menuitem"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                  </svg>
                  <span>{micRecording ? `Stop recording (${micElapsed}s)` : 'Microphone'}</span>
                </button>
                <div class="interrupt-bar-expand-options">
                  <label class="interrupt-bar-expand-opt" title="Capture screenshots triggered by click/drag gestures while recording">
                    <input
                      type="checkbox"
                      checked={micScreenCaptures}
                      disabled={micRecording}
                      onChange={(e) => setMicScreenCaptures((e.target as HTMLInputElement).checked)}
                    />
                    <span>screen captures</span>
                  </label>
                </div>
              </div>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </div>
  );
}

// `submitIcon` is included in the public type but visually we always render
// the paper-plane (matches the existing InterruptBar/CosComposer behavior).
// The prop is exposed so a future variant can swap in an interrupt glyph.
export type { SubmitIcon as UnifiedComposerSubmitIcon };
