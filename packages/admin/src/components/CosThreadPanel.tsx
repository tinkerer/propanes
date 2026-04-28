import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  chiefOfStaffAgents,
  sendChiefOfStaffMessage,
  type ChiefOfStaffVerbosity,
  type CosImageAttachment,
  type CosElementRef,
} from '../lib/chief-of-staff.js';
import { selectedAppId } from '../lib/state.js';
import { getSessionIdForThread } from '../lib/cos-thread-meta.js';
import {
  cosActiveThread,
  getThreadDraft,
  setThreadDraft,
  clearThreadDraft,
} from '../lib/cos-popout-tree.js';
import { useCosVoice } from '../lib/use-cos-voice.js';
import { useCosScreenshot } from '../lib/use-cos-screenshot.js';
import { useCosElementPicker } from '../lib/use-cos-element-picker.js';
import { groupIntoThreads, threadKeyOf } from './CosThread.js';
import { StructuredView } from './StructuredView.js';
import { CosInputToolbar } from './CosInputToolbar.js';

let attachmentIdCounter = 0;
function nextAttachmentId(): string {
  attachmentIdCounter += 1;
  return `cos-thread-att-${Date.now()}-${attachmentIdCounter}`;
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
 * Slack-mode side panel for one thread.
 *
 * The body is rendered from the **JSONL stream** of the thread's backing
 * agent session — not from cosMessages — because the cosMessages persistence
 * path drops assistant turns when the operator types fast and never sees
 * sub-agent (Task) transcripts at all. The JSONL has both. We delegate to
 * `StructuredView` (the same component that drives the JSONL companion tab)
 * with chat-mode opts so the rendering matches the bubble's compact style.
 *
 * The composer at the bottom shares the **same input toolbar** (camera +
 * options dropdown, element picker + options dropdown, mic, send) as the
 * main bubble — wired through useCosVoice / useCosScreenshot /
 * useCosElementPicker hooks so the panel composer has feature parity.
 * Replies land in this thread's session via sendChiefOfStaffMessage with
 * `replyToTs` set to the anchor user-message timestamp.
 */
export function ThreadPanel({
  agentId,
  showTools: _showTools,
  verbosity: _verbosity,
  onArtifactPopout,
  onReply,
  onClose,
  compact,
}: {
  agentId: string;
  showTools: boolean;
  verbosity: ChiefOfStaffVerbosity;
  onArtifactPopout: (artifactId: string) => void;
  onReply: (role: string, text: string, anchorTs?: number, threadServerId?: string | null) => void;
  onClose: () => void;
  compact?: boolean;
}) {
  void onArtifactPopout; // routed through the structured-view chat opts below if needed later
  const active = cosActiveThread.value;
  const agents = chiefOfStaffAgents.value;
  const agent = agents.find((a) => a.id === agentId) || null;
  const threads = useMemo(
    () => (agent ? groupIntoThreads(agent.messages) : []),
    [agent?.messages],
  );
  const found = active && agent && active.agentId === agentId
    ? threads.find((t) => threadKeyOf(t) === active.threadKey) || null
    : null;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const cameraGroupRef = useRef<HTMLDivElement>(null);
  const pickerGroupRef = useRef<HTMLDivElement>(null);
  const [composerText, setComposerText] = useState(() =>
    active ? getThreadDraft(active.agentId, active.threadKey) : '',
  );
  const [pendingAttachments, setPendingAttachments] = useState<Array<CosImageAttachment & { id: string }>>([]);
  const [pendingElementRefs, setPendingElementRefs] = useState<CosElementRef[]>([]);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [cameraMenuPos, setCameraMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  const [pickerMenuPos, setPickerMenuPos] = useState<{ top: number; left: number } | null>(null);

  // No agent or no selected thread → close the pane instead of rendering an
  // empty placeholder. Effect avoids calling the parent setter during render.
  const isEmpty = !agent || !active || !found;
  useEffect(() => {
    if (isEmpty) onClose();
  }, [isEmpty, onClose]);

  // When the operator switches threads, swap in that thread's persisted draft
  // so half-typed replies survive the switch (and reloads). Pending
  // attachments / element refs are deliberately ephemeral — they don't
  // persist across reloads or thread switches.
  useEffect(() => {
    setComposerText(active ? getThreadDraft(active.agentId, active.threadKey) : '');
    setPendingAttachments([]);
    setPendingElementRefs([]);
  }, [active?.threadKey, active?.agentId]);

  // Persist composer text on every keystroke — cheap because the store is
  // just a localStorage write of a small map. Empty text removes the entry.
  useEffect(() => {
    if (active) setThreadDraft(active.agentId, active.threadKey, composerText);
  }, [composerText, active?.agentId, active?.threadKey]);

  async function addImageBlob(blob: Blob, name?: string): Promise<void> {
    try {
      const dataUrl = await blobToDataUrl(blob);
      setPendingAttachments((prev) => [
        ...prev,
        { kind: 'image', dataUrl, name, id: nextAttachmentId() } as CosImageAttachment & { id: string },
      ]);
    } catch { /* non-fatal — operator can retry */ }
  }

  // Voice / screenshot / picker hooks share their state with CosInputToolbar
  // through the prop bridge below.
  const voice = useCosVoice({
    getInputBase: () => composerText,
    onAppendInput: (next: string) => setComposerText(next),
    focusInput: () => composerRef.current?.focus(),
  });
  const screenshot = useCosScreenshot({
    onAttachBlob: (blob, name) => addImageBlob(blob, name),
    closeCameraMenu: () => setCameraMenuOpen(false),
  });
  const picker = useCosElementPicker({
    wrapperRef,
    appendElementRefs: (refs) =>
      setPendingElementRefs((prev) => [...prev, ...refs]),
    focusInput: () => composerRef.current?.focus(),
    closePickerMenu: () => setPickerMenuOpen(false),
  });

  if (isEmpty) return null;

  const { userMsg, replies } = found;
  const threadServerId =
    userMsg?.threadId ?? replies.find((r) => r.msg.threadId)?.msg.threadId ?? null;
  const anchorTs = userMsg?.timestamp;
  const sessionId = getSessionIdForThread(threadServerId);
  const isAgentStreaming = replies.some((r) => r.msg.streaming);
  // Title preview: first ~60 chars of the anchor user message, falls back to
  // the agent name. Helps the operator know which thread is in the panel
  // without needing to read message bodies.
  const titlePreview = (() => {
    const t = (userMsg?.text || '').trim().replace(/\s+/g, ' ');
    if (!t) return agent.name;
    return t.length > 60 ? t.slice(0, 58) + '…' : t;
  })();

  const canSend =
    !!composerText.trim() ||
    pendingAttachments.length > 0 ||
    pendingElementRefs.length > 0;

  function submitReply() {
    if (!canSend) return;
    const trimmed = composerText.trim();
    sendChiefOfStaffMessage(trimmed, selectedAppId.value, {
      replyToTs: anchorTs,
      attachments: pendingAttachments.map(({ id: _id, ...att }) => att),
      elementRefs: pendingElementRefs,
    });
    setComposerText('');
    setPendingAttachments([]);
    setPendingElementRefs([]);
    if (active) clearThreadDraft(active.agentId, active.threadKey);
  }

  function onComposerPaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const it of imageItems) {
      const file = it.getAsFile();
      if (file) void addImageBlob(file, file.name || 'pasted-image.png');
    }
  }

  return (
    <div
      class={`cos-thread-panel${compact ? ' cos-thread-panel-compact' : ''}`}
      ref={wrapperRef}
    >
      <div class="cos-thread-panel-header">
        <span class="cos-thread-panel-title" title={userMsg?.text || ''}>{titlePreview}</span>
        <button
          type="button"
          class="cos-thread-panel-close"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >×</button>
      </div>
      <div class="cos-thread-panel-jsonl">
        {sessionId ? (
          <StructuredView sessionId={sessionId} chat={{}} />
        ) : (
          <div class="cos-thread-panel-empty-msg">
            Session warming up — the agent's JSONL appears here once the first
            turn writes a line.
          </div>
        )}
      </div>
      <div class="cos-thread-panel-composer">
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
          ref={composerRef}
          class="cos-input cos-thread-panel-input"
          value={composerText}
          placeholder={isAgentStreaming ? 'Reply (agent is responding…)' : 'Reply in this thread… (paste images to attach)'}
          onInput={(e) => setComposerText((e.target as HTMLTextAreaElement).value)}
          onPaste={onComposerPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitReply();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (composerText) setComposerText('');
              else if (userMsg?.text) onReply('user', userMsg.text, anchorTs, threadServerId);
            }
          }}
          rows={2}
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
          onSubmit={submitReply}
        />
      </div>
    </div>
  );
}
