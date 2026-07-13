import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../../lib/api.js';

// Drag-and-drop files onto a session pane (PTY terminal or structured view):
// upload to /api/v1/uploads (written to UPLOAD_DIR, symlinked into /tmp on the
// server host), then type the resulting /tmp path into the session's composer
// via send-keys — the same thing a native terminal drop does with a local
// path. Claude/codex pick the path up from the prompt text; for images Claude
// reads the file directly.
//
// Files above LARGE_FILE_BYTES are held behind an explicit confirmation
// popup before uploading.

export const LARGE_FILE_BYTES = 10 * 1024 * 1024;

export interface SessionFileDrop {
  dragOver: boolean;
  busy: boolean;
  error: string | null;
  pendingLarge: File[] | null;
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  confirmLarge: () => void;
  cancelLarge: () => void;
}

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function useSessionFileDrop(sessionId: string): SessionFileDrop {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingLarge, setPendingLarge] = useState<File[] | null>(null);
  // dragenter/dragleave fire on every child element crossing; a depth counter
  // keeps the highlight stable until the pointer actually leaves the pane.
  const dragDepth = useRef(0);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 6000);
  }, []);

  const uploadAndPaste = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const res = await api.sessionDropFiles(sessionId, files);
      if (res.error) throw new Error(res.error);
      const paths = (res.files || []).map((f) => f.path).filter(Boolean);
      if (paths.length === 0) throw new Error('Upload returned no paths');
      // Trailing space so consecutive drops (or typing after) stay separated.
      const result = await api.sendKeys(sessionId, { keys: paths.join(' ') + ' ', enter: false });
      if (!result.ok) throw new Error(result.error || 'send-keys failed');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }, [sessionId, showError]);

  // Shared intake for dropped or pasted files: small ones upload right away,
  // oversized ones wait behind the confirmation popup.
  const intakeFiles = useCallback((all: File[]) => {
    const small = all.filter((f) => f.size <= LARGE_FILE_BYTES);
    const large = all.filter((f) => f.size > LARGE_FILE_BYTES);
    if (small.length > 0) void uploadAndPaste(small);
    if (large.length > 0) setPendingLarge(large);
  }, [uploadAndPaste]);

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    const dropped = e.dataTransfer?.files;
    dragDepth.current = 0;
    setDragOver(false);
    if (!dropped || dropped.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    intakeFiles(Array.from(dropped));
  }, [intakeFiles]);

  // Paste with files on the clipboard (screenshots, copied images/files).
  // Text-only pastes are left alone — xterm / native handlers take those.
  // Wire via onPasteCapture on panes containing xterm: its textarea paste
  // handler stops propagation, so a bubble listener never sees the event.
  const onPaste = useCallback((e: ClipboardEvent) => {
    const pasted = e.clipboardData?.files;
    if (!pasted || pasted.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    intakeFiles(Array.from(pasted));
  }, [intakeFiles]);

  const confirmLarge = useCallback(() => {
    setPendingLarge((files) => {
      if (files) void uploadAndPaste(files);
      return null;
    });
  }, [uploadAndPaste]);

  const cancelLarge = useCallback(() => setPendingLarge(null), []);

  return { dragOver, busy, error, pendingLarge, onDragEnter, onDragOver, onDragLeave, onDrop, onPaste, confirmLarge, cancelLarge };
}

// Overlay chrome for a drop-enabled pane: drag highlight, busy/error toasts,
// and the large-file confirmation popup. Render inside a position:relative
// container. The confirm popup floats over pane content, so it uses hardcoded
// opaque paint (#1e293b) per the floating-overlay convention.
export function SessionDropOverlay({ drop }: { drop: SessionFileDrop }) {
  // Capture-phase Escape so pane-level keydown handlers can't swallow it.
  useEffect(() => {
    if (!drop.pendingLarge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        drop.cancelLarge();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [drop.pendingLarge, drop.cancelLarge]);

  return (
    <>
      {drop.dragOver && (
        <div class="session-drop-zone">Drop to upload &amp; paste path</div>
      )}
      {drop.busy && <div class="session-drop-toast">Uploading…</div>}
      {drop.error && !drop.busy && (
        <div class="session-drop-toast session-drop-toast-error">{drop.error}</div>
      )}
      {drop.pendingLarge && (
        <div class="session-drop-confirm">
          <div class="session-drop-confirm-title">
            Upload {drop.pendingLarge.length > 1 ? `${drop.pendingLarge.length} large files` : 'large file'}?
          </div>
          <ul class="session-drop-confirm-list">
            {drop.pendingLarge.map((f) => (
              <li key={f.name}>
                <span class="session-drop-confirm-name">{f.name}</span>
                <span class="session-drop-confirm-size">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          <div class="session-drop-confirm-hint">
            Files over {formatBytes(LARGE_FILE_BYTES)} need confirmation before uploading.
          </div>
          <div class="session-drop-confirm-actions">
            <button type="button" class="session-drop-confirm-cancel" onClick={drop.cancelLarge}>Cancel</button>
            <button type="button" class="session-drop-confirm-upload" onClick={drop.confirmLarge}>Upload anyway</button>
          </div>
        </div>
      )}
    </>
  );
}
