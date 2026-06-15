import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { captureScreenshot, type ScreenshotMethod } from '@propanes/widget/screenshot';
import { startPicker, type SelectedElementInfo } from '@propanes/widget/element-picker';
import { VoiceRecorder, type VoiceRecordingResult } from '@propanes/widget/voice-recorder';
import { snapshotConsole, type ConsoleEntry } from '../../lib/console-buffer.js';
import { useComposerCore, type ComposerImage, type ComposerFileUploadResult } from '../../lib/use-composer-core.js';
import { api } from '../../lib/api.js';
import { copyWithTooltip } from '../../lib/clipboard.js';

// Single composer used by InterruptBar (resume/interrupt session) and
// QuickDispatchPopup. Owns:
//   - textarea (auto-resize, paste-image, Enter-to-submit / Shift+Enter newline)
//   - attachment chips (image previews, DOM element refs, console capture, voice)
//   - expand-toggle popover menu with Screenshot / DOM-pick / Console / Mic
//     each with inline option toggles (mirrors widget menus)
//   - draft autosave/restore against /api/v1/admin/drafts/:key when draftKey is set
//
// Submit hand-off: callers receive raw blobs + structured attachments via
// onSubmit and decide what to do with them — InterruptBar uploads to
// /api/v1/screenshots and inlines URLs into a single resume prompt.
//
// CSS contract: outer container uses the className prop. Internal class
// names use the `.interrupt-bar-*` vocabulary (matching the existing
// stylesheet) so existing CSS keeps working when className='interrupt-bar'
// and degrades gracefully (still functional, plain) under other parents.

export type SubmitIcon = 'send' | 'interrupt';

export type UnifiedComposerFile = {
  id: string;
  name: string;
  path: string;
  url?: string;
  size: number;
  mimeType: string;
};

export type UnifiedComposerData = {
  text: string;
  images: Blob[];
  imageNames: string[];
  files: UnifiedComposerFile[];
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
  autoFocus?: boolean;
  draftStorage?: 'server' | 'local';
  /** Context attached to dragged-file uploads (resolves appId server-side). */
  uploadMeta?: { sessionId?: string; appId?: string };
};

const DRAFT_DEBOUNCE_MS = 300;
const LOCAL_DRAFT_PREFIX = 'pw-unified-composer-draft:';

type ComposerDraftAttachments = {
  elements?: SelectedElementInfo[];
};

function serializeDraftAttachments(elements: SelectedElementInfo[]): string | undefined {
  if (elements.length === 0) return undefined;
  return JSON.stringify({ elements });
}

function parseDraftAttachments(raw: string | null | undefined): ComposerDraftAttachments {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      elements: Array.isArray(parsed.elements)
        ? parsed.elements.filter((el: unknown): el is SelectedElementInfo => !!el && typeof el === 'object')
        : undefined,
    };
  } catch {
    return {};
  }
}

type ComposerDraftPayload = { text: string; attachmentsJson?: string };

function localDraftKey(key: string): string {
  return `${LOCAL_DRAFT_PREFIX}${key}`;
}

function saveLocalDraft(key: string, payload: ComposerDraftPayload): void {
  try {
    if (!payload.text && !payload.attachmentsJson) {
      localStorage.removeItem(localDraftKey(key));
      return;
    }
    localStorage.setItem(localDraftKey(key), JSON.stringify(payload));
  } catch { /* best-effort */ }
}

function readLocalDraft(key: string): { text: string; attachmentsJson: string | null } | null {
  try {
    const raw = localStorage.getItem(localDraftKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      attachmentsJson: typeof parsed.attachmentsJson === 'string' ? parsed.attachmentsJson : null,
    };
  } catch {
    return null;
  }
}

async function pushDraft(key: string, payload: { text: string; attachmentsJson?: string }): Promise<void> {
  saveLocalDraft(key, payload);
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

function pushLocalDraft(key: string, payload: ComposerDraftPayload): void {
  saveLocalDraft(key, payload);
}

async function clearDraftApi(key: string): Promise<void> {
  saveLocalDraft(key, { text: '' });
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`/api/v1/admin/drafts/${encodeURIComponent(key)}`, { method: 'DELETE', headers });
  } catch { /* best-effort */ }
}

function clearLocalDraft(key: string): void {
  saveLocalDraft(key, { text: '' });
}

async function loadDraft(key: string): Promise<{ text: string; attachmentsJson: string | null } | null> {
  const localDraft = readLocalDraft(key);
  if (localDraft) return localDraft;
  try {
    const token = localStorage.getItem('pw-admin-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`/api/v1/admin/drafts/${encodeURIComponent(key)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data === 'object' && data.exists) {
      return {
        text: typeof data.text === 'string' ? data.text : '',
        attachmentsJson: typeof data.attachmentsJson === 'string' ? data.attachmentsJson : null,
      };
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
  autoFocus = false,
  draftStorage = 'server',
  uploadMeta,
}: UnifiedComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Eager uploader for dragged non-image files — stores in /tmp and returns
  // the path so the chip can offer "copy path" immediately.
  async function uploadFile(file: File): Promise<ComposerFileUploadResult> {
    const res = await api.uploadFiles([file], {
      sessionId: uploadMeta?.sessionId,
      appId: uploadMeta?.appId,
      sourceUrl: typeof window !== 'undefined' ? window.location.href : undefined,
    });
    const up = res.files[0];
    if (!up) throw new Error('Upload failed');
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return { id: up.id, path: up.path, url: `${origin}/api/v1/uploads/${up.id}` };
  }

  // Core composer state from shared hook (text, images, elements, submit guard,
  // paste, keyboard). UnifiedComposer uses blob-mode images and manages its own
  // API-based draft persistence (draftKey) rather than the hook's draft binding.
  const core = useComposerCore<SelectedElementInfo, ConsoleEntry[] | null>({
    initialText,
    onEscapeWhenEmpty,
    autoGrowMaxPx: 140,
    textareaRef,
    imageMode: 'blob',
    contextHasContent: (ctx) => !!(ctx && ctx.length > 0),
    uploadFile,
  });

  const [internalError, setInternalError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerActive, setPickerActive] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [draftHydratedKey, setDraftHydratedKey] = useState<string | null>(null);

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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const submitGroupRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pickerCleanupRef = useRef<(() => void) | null>(null);
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);

  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftLoadedKeyRef = useRef<string | null>(null);

  const error = externalError ?? internalError;

  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // Hydrate from draft on mount / when draftKey changes. Only fires once per
  // key — text typed before the load resolves is preserved as the user input
  // wins over the persisted draft.
  useEffect(() => {
    if (!draftKey) {
      draftLoadedKeyRef.current = null;
      setDraftHydratedKey(null);
      return;
    }
    if (draftLoadedKeyRef.current === draftKey) return;
    draftLoadedKeyRef.current = draftKey;
    setDraftHydratedKey(null);
    let cancelled = false;
    void (async () => {
      const draft = await loadDraft(draftKey);
      if (cancelled) return;
      if (draft && draft.text && !core.text) core.setText(draft.text);
      const attachments = parseDraftAttachments(draft?.attachmentsJson);
      if (attachments.elements?.length && core.elements.length === 0) {
        core.setElements(attachments.elements);
      }
      setDraftHydratedKey(draftKey);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Debounced autosave on every keystroke. Empty text deletes the row server-
  // side; the route handles that.
  useEffect(() => {
    if (!draftKey) return;
    if (draftHydratedKey !== draftKey) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      const payload = {
        text: core.text,
        attachmentsJson: serializeDraftAttachments(core.elements),
      };
      if (draftStorage === 'local') {
        pushLocalDraft(draftKey, payload);
      } else {
        void pushDraft(draftKey, payload);
      }
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
        const payload = {
          text: core.text,
          attachmentsJson: serializeDraftAttachments(core.elements),
        };
        if (draftStorage === 'local') {
          pushLocalDraft(draftKey, payload);
        } else {
          void pushDraft(draftKey, payload);
        }
      }
    };
  }, [draftKey, draftHydratedKey, draftStorage, core.text, core.elements]);

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

  // Cleanup on unmount: stop pickers, kill mic.
  useEffect(() => {
    return () => {
      if (pickerCleanupRef.current) pickerCleanupRef.current();
      if (micTimerRef.current) clearInterval(micTimerRef.current);
      if (voiceRecorderRef.current?.recording) {
        voiceRecorderRef.current.stop().catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      if (blob) void core.addImageBlob(blob, 'screenshot.png');
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
        core.setElements((prev) => [...prev, ...infos]);
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
    core.setContext(snap);
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
    core.setElements((prev) => prev.filter((_, i) => i !== idx));
  }

  // hasContent includes voice result which the core hook doesn't know about
  const hasContent = core.hasContent || !!voiceResult;

  async function submit() {
    if (!hasContent) return;
    if (core.submittingRef.current) return;
    core.submittingRef.current = true;
    core.setSubmitting(true);
    setInternalError(null);
    try {
      // Extract blobs from core images (UnifiedComposer always uses blob mode)
      const blobs: Blob[] = [];
      const names: string[] = [];
      for (const img of core.images) {
        if (img.kind === 'blob') {
          blobs.push(img.blob);
          names.push(img.name);
        }
      }
      // Only forward fully-uploaded files (those with a resolved /tmp path).
      const uploadedFiles = core.files
        .filter((f) => f.status === 'done' && f.path)
        .map((f) => ({
          id: f.uploadId || f.id,
          name: f.name,
          path: f.path as string,
          url: f.url,
          size: f.size,
          mimeType: f.mimeType,
        }));

      await onSubmit({
        text: core.text.trim(),
        images: blobs,
        imageNames: names,
        files: uploadedFiles,
        elements: core.elements,
        consoleEntries: core.context,
        voice: voiceResult,
      });
      // Reset on success
      core.clearAll();
      setVoiceResult(null);
      if (draftKey) {
        if (draftSaveTimerRef.current) {
          clearTimeout(draftSaveTimerRef.current);
          draftSaveTimerRef.current = null;
        }
        if (draftStorage === 'local') {
          clearLocalDraft(draftKey);
        } else {
          void clearDraftApi(draftKey);
        }
      }
    } catch (err: any) {
      setInternalError(err?.message || String(err));
    } finally {
      core.setSubmitting(false);
      core.submittingRef.current = false;
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    core.onKeyDown(ev, { submit: () => void submit() });
  }

  const consoleCap = core.context;
  const consoleCount = consoleCap?.length ?? 0;
  const showChips = core.images.length > 0
    || core.files.length > 0
    || core.elements.length > 0
    || consoleCap !== null
    || !!voiceResult
    || micRecording;

  // Drag-and-drop: highlight on dragover, route files through the core handler.
  function onDragOver(ev: DragEvent) {
    if (!ev.dataTransfer) return;
    const hasFiles = Array.from(ev.dataTransfer.types || []).includes('Files');
    if (!hasFiles) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  }
  function onDragLeave(ev: DragEvent) {
    // Only clear when leaving the container itself (not bubbling from children).
    if (ev.currentTarget === ev.target) setDragOver(false);
  }
  function onDrop(ev: DragEvent) {
    setDragOver(false);
    core.onDrop(ev);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const voiceFinalCount = voiceResult?.transcript.filter((t) => t.isFinal).length ?? 0;
  const voiceIxCount = voiceResult?.interactions.length ?? 0;
  const voiceShotCount = voiceResult?.screenshots.length ?? 0;

  return (
    <div
      class={`${className || ''}${dragOver ? ' is-drag-over' : ''}`}
      ref={containerRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div class="interrupt-bar-dropzone" aria-hidden="true">
          <span>Drop files to attach</span>
        </div>
      )}
      {error && <div class="interrupt-bar-error">{error}</div>}
      {showChips && (
        <div class="interrupt-bar-chips">
          {core.images.map((img) => (
            <div class="cos-attach-thumb" key={img.id}>
              <img src={img.kind === 'blob' ? img.previewUrl : img.dataUrl} alt={img.name} />
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => core.removeImage(img.id)}
                title="Remove image"
                aria-label="Remove image"
              >&times;</button>
            </div>
          ))}
          {core.files.map((f) => (
            <div
              class={`cos-file-chip${f.status === 'error' ? ' is-error' : ''}${f.status === 'uploading' ? ' is-uploading' : ''}`}
              key={f.id}
              title={f.status === 'error' ? (f.error || 'Upload failed') : (f.path || f.name)}
            >
              {f.status === 'uploading' ? (
                <svg class="cos-file-spin" width="11" height="11" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56">
                    <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                  </path>
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              )}
              <code class="cos-file-name">{f.name}</code>
              <span class="cos-file-size">{f.status === 'error' ? 'failed' : formatSize(f.size)}</span>
              {f.status === 'done' && f.path && (
                <button
                  type="button"
                  class="cos-file-copy"
                  onClick={(e) => copyWithTooltip(f.path as string, e as unknown as MouseEvent)}
                  title={`Copy path: ${f.path}`}
                  aria-label="Copy file path"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => core.removeFile(f.id)}
                title="Remove file"
                aria-label="Remove file"
              >&times;</button>
            </div>
          ))}
          {core.elements.map((ref, idx) => {
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
                >&times;</button>
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
                onClick={() => core.setContext(null)}
                title="Remove console capture"
                aria-label="Remove console capture"
              >&times;</button>
            </div>
          )}
          {micRecording && (
            <div class="cos-element-chip interrupt-bar-mic-chip is-recording" title="Recording...">
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
              >&times;</button>
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
          value={core.text}
          disabled={disabled || core.submitting}
          onInput={(e) => core.setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          onPaste={core.onPaste}
        />
        <div class="interrupt-bar-submit-group" ref={submitGroupRef}>
          <button
            type="button"
            class={`interrupt-bar-expand-toggle${menuOpen ? ' is-open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            disabled={disabled || core.submitting}
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
            disabled={disabled || core.submitting || !hasContent}
            onClick={() => void submit()}
            title={submitTitle}
            aria-label={submitAriaLabel || (submitIcon === 'interrupt' ? 'Interrupt' : 'Send')}
          >
            {core.submitting ? (
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
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
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
                  <span>{captureBusy ? 'Capturing...' : 'Screenshot'}</span>
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
                  onClick={(e) => {
                    e.stopPropagation();
                    startDomPicker();
                  }}
                  disabled={pickerActive}
                  role="menuitem"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 3h4V1H1v6h2V3zm0 14H1v6h6v-2H3v-4zm14 4h-4v2h6v-6h-2v4zM17 3V1h6v6h-2V3h-4z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  <span>{pickerActive ? 'Picking...' : 'DOM select'}</span>
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
// the paper-plane (matches the existing InterruptBar behavior).
// The prop is exposed so a future variant can swap in an interrupt glyph.
export type { SubmitIcon as UnifiedComposerSubmitIcon };
