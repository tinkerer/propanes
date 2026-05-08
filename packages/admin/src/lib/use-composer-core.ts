/**
 * Shared composer core hook — owns the stateful logic common to both
 * UnifiedComposer (InterruptBar, QuickDispatch) and CosComposer (CoS chat).
 *
 * Manages:
 *   - text state + auto-grow textarea
 *   - image attachment list (generic: blob + preview URL OR dataUrl)
 *   - element ref list
 *   - context / console capture attachment
 *   - submit guard (double-click protection via synchronous ref)
 *   - paste-image handler
 *   - Enter-to-submit / Escape-to-clear keyboard handler
 *   - optional draft binding (read/write/clear interface)
 *
 * Does NOT manage:
 *   - toolbar UI (each consumer renders its own)
 *   - voice recording, screenshot capture, element picker hooks
 *   - @mention picker
 *   - inline contenteditable editor
 */
import { useEffect, useRef, useState } from 'preact/hooks';

// ---------------------------------------------------------------------------
// Draft binding: abstract read/write/clear interface for persisting drafts.
// CosComposer uses a localStorage-backed binding; UnifiedComposer can wrap
// its existing API-based draft persistence into this shape.
// ---------------------------------------------------------------------------
export interface ComposerDraftBinding {
  read: () => string;
  write: (text: string) => void;
  clear: () => void;
}

// ---------------------------------------------------------------------------
// Generic image attachment — supports both blob-based (UnifiedComposer) and
// dataUrl-based (CosComposer) workflows via the `source` discriminant.
// ---------------------------------------------------------------------------
export type ComposerImage =
  | { id: string; kind: 'blob'; blob: Blob; previewUrl: string; name: string }
  | { id: string; kind: 'dataUrl'; dataUrl: string; name?: string };

let imageIdCounter = 0;
export function nextImageId(): string {
  imageIdCounter += 1;
  return `cimg-${Date.now()}-${imageIdCounter}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Hook options
// ---------------------------------------------------------------------------
export interface UseComposerCoreOptions<TElement, TContext> {
  /** Initial text (used when no draft binding or draft is empty). */
  initialText?: string;
  /** Draft binding for read/write/clear. */
  draft?: ComposerDraftBinding;
  /** Called when text changes. */
  onTextChange?: (text: string) => void;
  /** Auto-grow textarea to this max pixel height. */
  autoGrowMaxPx?: number;
  /** Ref to the textarea element for auto-grow. */
  textareaRef?: { current: HTMLTextAreaElement | null };
  /** Store images as dataUrl (CosComposer) instead of blob (UnifiedComposer). */
  imageMode?: 'blob' | 'dataUrl';
  /** Check if context attachment has content. */
  contextHasContent?: (ctx: TContext | null) => boolean;
  /** Called on Escape when text is empty. */
  onEscapeWhenEmpty?: () => void;
  /** Called on Escape unconditionally (before default handling). Return true to suppress default. */
  onEscape?: () => boolean;
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------
export interface ComposerCoreState<TElement, TContext> {
  // Text
  text: string;
  setText: (text: string) => void;

  // Submitting
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
  submittingRef: { current: boolean };

  // Images
  images: ComposerImage[];
  setImages: (updater: ComposerImage[] | ((prev: ComposerImage[]) => ComposerImage[])) => void;
  addImageBlob: (blob: Blob, name?: string) => Promise<void>;
  removeImage: (id: string) => void;
  updateImageDataUrl: (id: string, dataUrl: string) => void;

  // Elements
  elements: TElement[];
  setElements: (updater: TElement[] | ((prev: TElement[]) => TElement[])) => void;

  // Context (console / browser context)
  context: TContext | null;
  setContext: (ctx: TContext | null | ((prev: TContext | null) => TContext | null)) => void;

  // Derived
  hasContent: boolean;

  // Actions
  clearAll: () => void;
  onPaste: (ev: ClipboardEvent) => void;
  onKeyDown: (ev: KeyboardEvent, opts?: { mentionActive?: boolean; onMentionKey?: (ev: KeyboardEvent) => boolean; submit?: () => void }) => void;

  // Draft
  draftRef: { current: ComposerDraftBinding | undefined };
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------
export function useComposerCore<TElement = unknown, TContext = unknown>(
  opts: UseComposerCoreOptions<TElement, TContext>,
): ComposerCoreState<TElement, TContext> {
  const {
    initialText,
    draft,
    onTextChange,
    autoGrowMaxPx,
    textareaRef,
    imageMode = 'blob',
    contextHasContent,
    onEscapeWhenEmpty,
    onEscape,
  } = opts;

  const [text, setText] = useState<string>(() => draft?.read() ?? initialText ?? '');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [elements, setElements] = useState<TElement[]>([]);
  const [context, setContext] = useState<TContext | null>(null);

  // ---- Draft binding bridge ----
  // Same logic as CosComposer's prev-binding + pendingSelfWrite pattern:
  // identity change → hydrate from new binding; text change with same binding
  // → write to store. The pendingSelfWriteRef prevents loops when the binding
  // identity changes due to a signal tick caused by our own write.
  const prevDraftRef = useRef<ComposerDraftBinding | undefined>(undefined);
  const pendingSelfWriteRef = useRef<string | null>(null);

  useEffect(() => {
    if (!draft) {
      prevDraftRef.current = undefined;
      pendingSelfWriteRef.current = null;
      return;
    }
    if (prevDraftRef.current !== draft) {
      prevDraftRef.current = draft;
      const stored = draft.read();
      if (pendingSelfWriteRef.current !== null && stored === pendingSelfWriteRef.current) {
        pendingSelfWriteRef.current = null;
        return;
      }
      pendingSelfWriteRef.current = null;
      if (stored !== text) {
        setText(stored);
      }
      return;
    }
    if (draft.read() !== text) {
      pendingSelfWriteRef.current = text;
      draft.write(text);
    }
  }, [text, draft]);

  // ---- onTextChange callback ----
  useEffect(() => {
    onTextChange?.(text);
  }, [text, onTextChange]);

  // ---- Auto-grow textarea ----
  useEffect(() => {
    if (!autoGrowMaxPx || !textareaRef) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, autoGrowMaxPx) + 'px';
  }, [text, autoGrowMaxPx, textareaRef]);

  // ---- Cleanup: revoke blob URLs on unmount ----
  useEffect(() => {
    return () => {
      for (const img of images) {
        if (img.kind === 'blob') URL.revokeObjectURL(img.previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Image management ----
  async function addImageBlob(blob: Blob, name?: string): Promise<void> {
    const id = nextImageId();
    if (imageMode === 'dataUrl') {
      try {
        const dataUrl = await blobToDataUrl(blob);
        setImages((prev) => [...prev, { id, kind: 'dataUrl', dataUrl, name }]);
      } catch { /* non-fatal */ }
    } else {
      const previewUrl = URL.createObjectURL(blob);
      setImages((prev) => [...prev, { id, kind: 'blob', blob, previewUrl, name: name || 'pasted.png' }]);
    }
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit && hit.kind === 'blob') URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function updateImageDataUrl(id: string, dataUrl: string) {
    setImages((prev) =>
      prev.map((img) => {
        if (img.id !== id) return img;
        if (img.kind === 'dataUrl') return { ...img, dataUrl };
        // blob → convert to dataUrl mode
        URL.revokeObjectURL(img.previewUrl);
        return { id, kind: 'dataUrl', dataUrl, name: img.name };
      }),
    );
  }

  // ---- Paste handler ----
  function onPaste(ev: ClipboardEvent) {
    const items = ev.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    );
    if (imageItems.length === 0) return;
    ev.preventDefault();
    for (const it of imageItems) {
      const file = it.getAsFile();
      if (file) void addImageBlob(file, file.name || 'pasted-image.png');
    }
  }

  // ---- Derived ----
  const ctxHas = contextHasContent ?? (() => false);
  const hasContent =
    !!text.trim() ||
    images.length > 0 ||
    elements.length > 0 ||
    ctxHas(context);

  // ---- Clear all state ----
  function clearAll() {
    setText('');
    for (const img of images) {
      if (img.kind === 'blob') URL.revokeObjectURL(img.previewUrl);
    }
    setImages([]);
    setElements([]);
    setContext(null);
    if (draft) draft.clear();
  }

  // ---- Keyboard handler ----
  function onKeyDown(
    ev: KeyboardEvent,
    extra?: {
      mentionActive?: boolean;
      onMentionKey?: (ev: KeyboardEvent) => boolean;
      submit?: () => void;
    },
  ) {
    // Let @mention picker eat nav keys when open
    if (extra?.mentionActive && extra?.onMentionKey) {
      if (extra.onMentionKey(ev)) return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      extra?.submit?.();
      return;
    }
    if (ev.key !== 'Escape') return;
    // onEscape gets the first chance
    if (onEscape && onEscape()) {
      ev.preventDefault();
      return;
    }
    if (text) {
      ev.preventDefault();
      setText('');
    } else if (onEscapeWhenEmpty) {
      ev.preventDefault();
      onEscapeWhenEmpty();
    }
  }

  return {
    text,
    setText,
    submitting,
    setSubmitting,
    submittingRef,
    images,
    setImages,
    addImageBlob,
    removeImage,
    updateImageDataUrl,
    elements,
    setElements,
    context,
    setContext,
    hasContent,
    clearAll,
    onPaste,
    onKeyDown,
    draftRef: prevDraftRef,
  };
}
