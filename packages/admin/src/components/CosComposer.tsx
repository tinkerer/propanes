import { useEffect, useRef, useState } from 'preact/hooks';
import {
  type CosImageAttachment,
  type CosElementRef,
} from '../lib/chief-of-staff.js';
import { useCosVoice } from '../lib/use-cos-voice.js';
import { useCosScreenshot } from '../lib/use-cos-screenshot.js';
import { useCosElementPicker } from '../lib/use-cos-element-picker.js';
import { CosInputToolbar } from './CosInputToolbar.js';

let attachmentIdCounter = 0;
function nextAttachmentId(): string {
  attachmentIdCounter += 1;
  return `cos-att-${Date.now()}-${attachmentIdCounter}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Shared composer used by the bubble's main chat row and the thread side
 * panel. Owns the textarea + pending attachments + element refs + the three
 * input hooks (voice, screenshot, element picker) + the input toolbar.
 *
 * Text state can be:
 *   - uncontrolled (caller passes initialText, hears via onSend)
 *   - controlled via the `draft` prop, which is the bubble's draft-key
 *     interface — read on mount, write on every keystroke, clear on send.
 *     Lets the same composer back the bubble's per-(agent,app,thread)
 *     localStorage drafts AND the thread-panel's per-thread drafts without
 *     either knowing about the other's storage layout.
 *
 * Pending attachments + element refs are deliberately ephemeral: they live
 * for one compose cycle, then flush on send. The caller's onSend handler
 * decides what to do with them (typically pass into sendChiefOfStaffMessage).
 */
export interface CosComposerDraftBinding {
  read: () => string;
  write: (text: string) => void;
  clear: () => void;
}

export interface CosComposerProps {
  placeholder: string;
  /** Called when the operator hits Enter or clicks send. Caller is
   *  responsible for actually dispatching the message. */
  onSend: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  /** Optional: bind text state to a draft store that persists across mounts. */
  draft?: CosComposerDraftBinding;
  /** Optional: parent-scoped Escape handler — fired when Escape is pressed
   *  with empty text. Used by the thread panel to bounce a single-tap
   *  Escape up to a "drop reply scope" handler in the bubble. */
  onEscapeWhenEmpty?: () => void;
  /** When true, the textarea + toolbar both ignore input. Visual hint that
   *  the agent is streaming a reply. */
  disabled?: boolean;
  /** Auto-grow textarea row count while typing. */
  rows?: number;
}

export function CosComposer({
  placeholder,
  onSend,
  draft,
  onEscapeWhenEmpty,
  disabled,
  rows = 2,
}: CosComposerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cameraGroupRef = useRef<HTMLDivElement>(null);
  const pickerGroupRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string>(() => draft?.read() ?? '');
  const [pendingAttachments, setPendingAttachments] = useState<Array<CosImageAttachment & { id: string }>>([]);
  const [pendingElementRefs, setPendingElementRefs] = useState<CosElementRef[]>([]);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [cameraMenuPos, setCameraMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  const [pickerMenuPos, setPickerMenuPos] = useState<{ top: number; left: number } | null>(null);

  // Whenever the draft store identity changes (caller switches the binding),
  // re-hydrate text from the new draft. Caller indicates "switch" by passing
  // a new `draft` reference — typically tied to a thread switch.
  useEffect(() => {
    if (draft) setText(draft.read());
  }, [draft]);

  // Persist on every keystroke. Cheap because the binding is usually a thin
  // localStorage write.
  useEffect(() => {
    if (draft) draft.write(text);
  }, [text, draft]);

  async function addImageBlob(blob: Blob, name?: string): Promise<void> {
    try {
      const dataUrl = await blobToDataUrl(blob);
      setPendingAttachments((prev) => [
        ...prev,
        { kind: 'image', dataUrl, name, id: nextAttachmentId() } as CosImageAttachment & { id: string },
      ]);
    } catch { /* non-fatal — operator can retry */ }
  }

  const voice = useCosVoice({
    getInputBase: () => text,
    onAppendInput: (next) => setText(next),
    focusInput: () => textareaRef.current?.focus(),
  });
  const screenshot = useCosScreenshot({
    onAttachBlob: (blob, name) => addImageBlob(blob, name),
    closeCameraMenu: () => setCameraMenuOpen(false),
  });
  const picker = useCosElementPicker({
    wrapperRef,
    appendElementRefs: (refs) => setPendingElementRefs((prev) => [...prev, ...refs]),
    focusInput: () => textareaRef.current?.focus(),
    closePickerMenu: () => setPickerMenuOpen(false),
  });

  const canSend =
    !!text.trim() ||
    pendingAttachments.length > 0 ||
    pendingElementRefs.length > 0;

  function submit() {
    if (!canSend || disabled) return;
    onSend(
      text.trim(),
      pendingAttachments.map(({ id: _id, ...att }) => att),
      pendingElementRefs,
    );
    setText('');
    setPendingAttachments([]);
    setPendingElementRefs([]);
    if (draft) draft.clear();
  }

  function onPaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const it of imageItems) {
      const file = it.getAsFile();
      if (file) void addImageBlob(file, file.name || 'pasted-image.png');
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      if (text) {
        e.preventDefault();
        setText('');
      } else if (onEscapeWhenEmpty) {
        e.preventDefault();
        onEscapeWhenEmpty();
      }
    }
  }

  return (
    <div class="cos-composer" ref={wrapperRef}>
      {(pendingAttachments.length > 0 || pendingElementRefs.length > 0) && (
        <div class="cos-attach-strip">
          {pendingAttachments.map((att) => (
            <div class="cos-attach-thumb" key={att.id}>
              <img src={att.dataUrl} alt={att.name || 'attachment'} />
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                title="Remove attachment"
                aria-label="Remove attachment"
              >&times;</button>
            </div>
          ))}
          {pendingElementRefs.map((ref, idx) => {
            let display = ref.tagName || 'element';
            if (ref.id) display += `#${ref.id}`;
            const cls = (ref.classes || []).filter((c) => !c.startsWith('pw-')).slice(0, 2);
            if (cls.length) display += '.' + cls.join('.');
            return (
              <div class="cos-element-chip" key={`ref-${idx}`} title={ref.selector}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
                </svg>
                <code>{display}</code>
                <button
                  type="button"
                  class="cos-attach-remove"
                  onClick={() => setPendingElementRefs((prev) => prev.filter((_, i) => i !== idx))}
                  title="Remove element reference"
                  aria-label="Remove element reference"
                >&times;</button>
              </div>
            );
          })}
        </div>
      )}
      <textarea
        ref={textareaRef}
        class="cos-input"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        rows={rows}
      />
      <CosInputToolbar
        cameraGroupRef={cameraGroupRef}
        pickerGroupRef={pickerGroupRef}
        capturingScreenshot={screenshot.capturingScreenshot}
        captureAndAttachScreenshot={screenshot.captureAndAttachScreenshot}
        startTimedScreenshot={screenshot.startTimedScreenshot}
        cameraMenuOpen={cameraMenuOpen}
        setCameraMenuOpen={setCameraMenuOpen}
        cameraMenuPos={cameraMenuPos}
        setCameraMenuPos={setCameraMenuPos}
        screenshotExcludeWidget={screenshot.screenshotExcludeWidget}
        setScreenshotExcludeWidget={screenshot.setScreenshotExcludeWidget}
        screenshotExcludeCursor={screenshot.screenshotExcludeCursor}
        setScreenshotExcludeCursor={screenshot.setScreenshotExcludeCursor}
        screenshotMethod={screenshot.screenshotMethod}
        setScreenshotMethod={screenshot.setScreenshotMethod}
        screenshotKeepStream={screenshot.screenshotKeepStream}
        setScreenshotKeepStream={screenshot.setScreenshotKeepStream}
        pickerActive={picker.pickerActive}
        startElementPick={picker.startElementPick}
        pickerMenuOpen={pickerMenuOpen}
        setPickerMenuOpen={setPickerMenuOpen}
        pickerMenuPos={pickerMenuPos}
        setPickerMenuPos={setPickerMenuPos}
        pickerMultiSelect={picker.pickerMultiSelect}
        setPickerMultiSelect={picker.setPickerMultiSelect}
        pickerIncludeChildren={picker.pickerIncludeChildren}
        setPickerIncludeChildren={picker.setPickerIncludeChildren}
        micRecording={voice.recording}
        micElapsed={voice.elapsed}
        micInterim={voice.interim}
        toggleMicRecord={voice.toggleRecord}
        canSend={canSend}
        onSubmit={submit}
      />
    </div>
  );
}
