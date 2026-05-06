import { useEffect, useImperativeHandle, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import type { ComponentChildren, JSX, RefObject } from 'preact';
import {
  chiefOfStaffAgents,
  type CosImageAttachment,
  type CosElementRef,
} from '../../lib/chief-of-staff.js';
import { activeChannel } from '../../lib/state.js';
import { inlineElementChipsEnabled } from '../../lib/settings.js';
import { api } from '../../lib/api.js';
import { useCosVoice } from '../../lib/use-cos-voice.js';
import { useCosScreenshot } from '../../lib/use-cos-screenshot.js';
import { useCosElementPicker } from '../../lib/use-cos-element-picker.js';
import { CosInputToolbar } from './CosInputToolbar.js';
import { CosInlineEditor, type CosInlineEditorHandle } from './CosInlineEditor.js';
import {
  snapshotBrowserContext,
  summarizeBrowserContext,
  formatBrowserContext,
  cosSelectedCollectors,
  type CosBrowserContext,
} from '../../lib/console-buffer.js';

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

/** Imperative handle for callers (mostly the bubble) that need to mutate
 *  composer-owned state without lifting it. Kept intentionally narrow — add
 *  members only when an inline-prop alternative would be uglier. */
export interface CosComposerHandle {
  /** Replace the dataUrl of a pending attachment in place — used by the
   *  bubble's inline image editor modal. */
  updateAttachmentDataUrl: (id: string, dataUrl: string) => void;
  /** Snapshot the current composer state. Used by the bubble's saved-drafts
   *  swap-on-click flow (stash composer → load clicked draft). */
  getSnapshot: () => { text: string; attachments: CosImageAttachment[]; elementRefs: CosElementRef[] };
  /** Replace composer state with the given payload. Triggers a draft.write
   *  through the normal text-change path so the active draft scope mirrors
   *  the loaded text. */
  loadSnapshot: (snapshot: { text: string; attachments?: CosImageAttachment[]; elementRefs?: CosElementRef[] }) => void;
}

export interface CosComposerProps {
  placeholder: string;
  /** Called when the operator hits Enter or clicks send. Caller is
   *  responsible for actually dispatching the message. May return a Promise;
   *  the composer keeps the textarea frozen (text intact, input disabled)
   *  until the promise settles, then clears on resolve. On rejection the
   *  textarea unfreezes with the operator's text preserved so they can retry
   *  or edit without losing what they typed. */
  onSend: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void | Promise<void>;
  /** Optional: bind text state to a draft store that persists across mounts. */
  draft?: CosComposerDraftBinding;
  /** Optional: parent-scoped Escape handler — fired when Escape is pressed
   *  with empty text. Used by the thread panel to bounce a single-tap
   *  Escape up to a "drop reply scope" handler in the bubble. */
  onEscapeWhenEmpty?: () => void;
  /** Optional: parent-scoped Escape handler that fires *unconditionally* on
   *  every Escape (not just when empty). Returning true skips the default
   *  clear-text-then-onEscapeWhenEmpty flow. The bubble uses this to drop
   *  reply-pill scope without losing the in-progress text. */
  onEscape?: () => boolean;
  /** When true, the textarea + toolbar both ignore input. Visual hint that
   *  the agent is streaming a reply. */
  disabled?: boolean;
  /** Auto-grow textarea row count while typing. */
  rows?: number;
  /** Extra class appended to the composer root (in addition to
   *  `cos-composer`). The bubble passes `cos-input-row` so existing styles
   *  for that container keep applying. */
  className?: string;
  /** Slot rendered before the attachment strip + textarea — used by the
   *  bubble for its manual resize handle. */
  prefix?: ComponentChildren;
  /** Inline style applied to the textarea. The bubble uses this to override
   *  the CSS-driven max-height when its manual resize handle is dragged. */
  inputStyle?: JSX.CSSProperties;
  /** Caller-supplied object ref that receives the textarea DOM node. The
   *  bubble uses this for focus-on-open. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Auto-grow the textarea up to `maxPx` based on scroll height. The bubble
   *  passes a value when its manual resize handle has not been dragged. */
  autoGrow?: { maxPx: number };
  /** Optional click handler for attachment thumbnails. When set, thumbs are
   *  rendered with a pointer cursor + edit-affordance tooltip. The bubble
   *  uses this to open its inline image editor modal. */
  onAttachmentClick?: (id: string, dataUrl: string) => void;
  /** Mirror of the live composer text for callers that need to react to it
   *  outside the composer (e.g. the bubble's reply-pill toggling a "Save
   *  draft" affordance based on whether the box is empty). */
  onTextChange?: (text: string) => void;
  /** Optional: when set, renders a "Save as draft" button next to send.
   *  Caller stashes the payload (the saved-drafts list lives outside the
   *  composer); the composer clears its text/attachments/element refs after
   *  the callback fires, just like onSend. */
  onSaveDraft?: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  /** Optional: turns the Save-draft button into a split-button. When the
   *  caret menu is open the operator can pick additional CoS agent scopes
   *  to fan the same draft into. The `current` flag marks the agent the
   *  composer is currently scoped to (always pre-saved). */
  fanOutAgents?: Array<{ id: string; name: string; current?: boolean }>;
  /** Optional: invoked when the operator picks "Save draft for these
   *  agents" from the dropdown. Composer clears state on success, just
   *  like onSaveDraft. */
  onSaveDraftToAgents?: (agentIds: string[], text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  /** Optional: when true, enables the enqueue/interrupt items in the
   *  send-mode dropdown and shows the stop button next to send. The bubble
   *  passes this when its active thread has a turn in flight. */
  streaming?: boolean;
  /** Stop the currently streaming turn. Wired to `interruptThread` /
   *  `interruptActiveAgent`. Only invoked via the stop button. */
  onStop?: () => void;
  /** Send the message after the current streaming turn finishes — picked
   *  from the send-mode dropdown. Caller queues client-side; composer
   *  clears state once handler accepts. */
  onEnqueueAfterCurrent?: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  /** Interrupt the running turn, then send the message immediately. Caller
   *  is responsible for awaiting the interrupt before dispatching. Same
   *  promise-aware freeze semantics as `onSend`. */
  onSendAndInterrupt?: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void | Promise<void>;
}

export const CosComposer = forwardRef<CosComposerHandle, CosComposerProps>(function CosComposer({
  placeholder,
  onSend,
  draft,
  onEscapeWhenEmpty,
  onEscape,
  disabled,
  rows = 2,
  className,
  prefix,
  inputStyle,
  textareaRef: externalTextareaRef,
  autoGrow,
  onAttachmentClick,
  onTextChange,
  onSaveDraft,
  fanOutAgents,
  onSaveDraftToAgents,
  streaming,
  onStop,
  onEnqueueAfterCurrent,
  onSendAndInterrupt,
}, handleRef) {
  // Snapshot the inline-chip toggle once per mount. Live-toggling between
  // a textarea and a contenteditable mid-conversation would require
  // marshaling text + chips between two source-of-truth shapes; instead
  // the operator gets the new mode on next composer mount (which happens
  // every bubble open / thread switch anyway).
  const inlineMode = inlineElementChipsEnabled.value;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inlineEditorRef = useRef<CosInlineEditorHandle>(null);
  // Forward the textarea DOM node to the caller's ref each time it mounts /
  // unmounts. Wrapped in a callback so we don't reach across refs in render.
  const setTextareaEl = (el: HTMLTextAreaElement | null) => {
    (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
    if (externalTextareaRef) {
      (externalTextareaRef as { current: HTMLTextAreaElement | null }).current = el;
    }
  };
  const cameraGroupRef = useRef<HTMLDivElement>(null);
  const pickerGroupRef = useRef<HTMLDivElement>(null);
  const consoleGroupRef = useRef<HTMLDivElement>(null);
  const micGroupRef = useRef<HTMLDivElement>(null);
  const sendModeGroupRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string>(() => draft?.read() ?? '');
  // While `submitting` is true we keep the textarea text intact but the
  // composer is fully frozen — operator can see exactly what they sent
  // until the server acks. Cleared after the onSend promise resolves.
  const [submitting, setSubmitting] = useState(false);
  // Synchronous mirror of `submitting` for re-entry guards. State updates are
  // queued, so two click/keydown events firing in the same tick (iOS often
  // double-fires; some Bluetooth keyboards repeat Enter) both close over the
  // pre-render `submitting=false` and slip past the state guard, producing
  // duplicate optimistic rows + duplicate POST /chat calls. The ref flips
  // synchronously so the second call returns immediately.
  const submittingRef = useRef(false);
  const [pendingAttachments, setPendingAttachments] = useState<Array<CosImageAttachment & { id: string }>>([]);
  const [pendingElementRefs, setPendingElementRefs] = useState<CosElementRef[]>([]);
  const [pendingContext, setPendingContext] = useState<CosBrowserContext | null>(null);
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [cameraMenuPos, setCameraMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [pickerMenuOpen, setPickerMenuOpen] = useState(false);
  const [pickerMenuPos, setPickerMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [consoleMenuOpen, setConsoleMenuOpen] = useState(false);
  const [consoleMenuPos, setConsoleMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [micMenuOpen, setMicMenuOpen] = useState(false);
  const [micMenuPos, setMicMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [sendModeOpen, setSendModeOpen] = useState(false);
  const [sendModeMenuPos, setSendModeMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [fanOutSelected, setFanOutSelected] = useState<Set<string>>(() => new Set());

  // Inline @mention picker state. `prefix` null = picker hidden; non-null
  // (incl. empty string) = "@" was just typed, dropdown should be open.
  // `start` is the caret index *after* the @ — i.e. the start of the partial
  // slug — so insertion can replace from start to current caret.
  const [mentionPrefix, setMentionPrefix] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number>(0);
  const [mentionHighlight, setMentionHighlight] = useState<number>(0);
  const [channelMembers, setChannelMembers] = useState<
    Array<{ kind: 'user' | 'agent'; refId: string; role: string }>
  >([]);
  // Cache channel members on mount + whenever the active channel id changes.
  // Members rarely shift mid-session; one fetch is enough.
  const channelId = activeChannel.value?.id ?? null;
  useEffect(() => {
    if (!channelId) {
      setChannelMembers([]);
      return;
    }
    let cancelled = false;
    api.getChannelMembers(channelId)
      .then((res) => {
        if (cancelled) return;
        setChannelMembers(res.members);
      })
      .catch(() => {
        if (cancelled) return;
        setChannelMembers([]);
      });
    return () => { cancelled = true; };
  }, [channelId]);

  // Single effect that owns the draft<->text bridge for both axes:
  //   * binding identity change (scope switch / signal-tick rebuild) →
  //     hydrate from the new binding without writing back. Writing back
  //     would clobber the new scope with the closed-over text from the old
  //     one.
  //   * text change with the same binding → propagate to the draft store,
  //     skipping if the value is already there (e.g. a self-write that
  //     bounced through a signal subscriber).
  // Without the prev-binding ref + dedupe the bubble's cosDrafts signal
  // subscription would loop: every keystroke writes → signal tick → bubble
  // re-renders with a new binding identity → write fires again.
  // pendingSelfWriteRef closes the ghost-edit race: when the operator types
  // fast, a keystroke can commit *between* our post-write cosDrafts tick and
  // the next render. The new binding identity arrives carrying the older
  // stored value, but local `text` has already moved on. Without the guard
  // we'd treat the bump as a scope switch and roll text back to the older
  // value (eating the in-flight keystroke). The marker holds the value we
  // just wrote; if the post-write read returns it, we skip the read-back.
  // Real scope switches and peer-window writes (stored !== pending) still
  // hydrate correctly.
  const prevDraftRef = useRef<CosComposerDraftBinding | undefined>(undefined);
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
        // Inline mode: scope switched (e.g. operator picked another
        // thread). Push the new draft text into the editor so its
        // contenteditable contents match.
        if (inlineMode) inlineEditorRef.current?.setText(stored);
      }
      return;
    }
    if (draft.read() !== text) {
      pendingSelfWriteRef.current = text;
      draft.write(text);
    }
  }, [text, draft]);

  useEffect(() => {
    onTextChange?.(text);
  }, [text, onTextChange]);

  // Auto-grow effect: when caller opts in, sync the textarea height to its
  // content (capped at `autoGrow.maxPx`). The bubble passes this only while
  // its manual resize handle hasn't been dragged — `inputStyle.height`
  // overrides this once the operator pulls the handle.
  useEffect(() => {
    if (!autoGrow) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, autoGrow.maxPx) + 'px';
  }, [text, autoGrow]);

  useImperativeHandle(handleRef, () => ({
    updateAttachmentDataUrl(id: string, dataUrl: string) {
      setPendingAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, dataUrl } : a)),
      );
    },
    getSnapshot() {
      return {
        text,
        attachments: pendingAttachments.map(({ id: _id, ...att }) => att),
        elementRefs: pendingElementRefs,
      };
    },
    loadSnapshot(snapshot) {
      setText(snapshot.text);
      setPendingAttachments(
        (snapshot.attachments ?? []).map((att) => ({ ...att, id: nextAttachmentId() })),
      );
      setPendingElementRefs(snapshot.elementRefs ?? []);
      setPendingContext(null);
      // Inline mode keeps content in a contenteditable — setting React
      // state alone doesn't push into the editor. The snapshot's chips
      // are lost on this path (we'd need to walk markers to rebuild
      // them); v1 accepts plain-text-only restore for saved drafts.
      if (inlineMode) inlineEditorRef.current?.setText(snapshot.text);
    },
  }), [text, pendingAttachments, pendingElementRefs]);

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
    onAppendInput: (next) => {
      // In inline mode the editor is the source of truth — push the
      // transcribed text in via setText so the editor renders it (and
      // re-fires onChange, which mirrors back into composer state).
      if (inlineMode) inlineEditorRef.current?.setText(next);
      else setText(next);
    },
    focusInput: () => {
      if (inlineMode) inlineEditorRef.current?.focus();
      else textareaRef.current?.focus();
    },
  });
  const screenshot = useCosScreenshot({
    onAttachBlob: (blob, name) => addImageBlob(blob, name),
    closeCameraMenu: () => setCameraMenuOpen(false),
  });
  const picker = useCosElementPicker({
    wrapperRef,
    appendElementRefs: (refs) => {
      if (inlineMode) {
        // Inline mode: chips go into the editor at caret. The editor's
        // onChange fires with the full ordered ref list, which we mirror
        // into pendingElementRefs — the strip stays hidden because all
        // refs are now visible in-flow.
        inlineEditorRef.current?.insertChips(refs);
      } else {
        setPendingElementRefs((prev) => [...prev, ...refs]);
      }
    },
    focusInput: () => {
      if (inlineMode) inlineEditorRef.current?.focus();
      else textareaRef.current?.focus();
    },
    closePickerMenu: () => setPickerMenuOpen(false),
  });

  function pendingContextHasAny(c: CosBrowserContext | null): boolean {
    if (!c) return false;
    return !!(
      (c.console && c.console.length > 0) ||
      (c.network && c.network.length > 0) ||
      (c.performance && Object.keys(c.performance).length > 0) ||
      c.environment
    );
  }

  const canSend =
    !!text.trim() ||
    pendingAttachments.length > 0 ||
    pendingElementRefs.length > 0 ||
    pendingContextHasAny(pendingContext);

  function captureConsole() {
    const snap = snapshotBrowserContext(cosSelectedCollectors.value);
    setPendingContext(snap);
    setMicMenuOpen(false);
    setCameraMenuOpen(false);
    setPickerMenuOpen(false);
    setConsoleMenuOpen(false);
    textareaRef.current?.focus();
  }

  /** Build the outgoing prompt by folding pending browser context (if any)
   *  into the trimmed text as fenced blocks. Used by every send-mode path
   *  (send, save draft, enqueue, interrupt-and-send) so they all serialize
   *  context the same way. */
  function buildFinalText(): string {
    let finalText = text.trim();
    if (pendingContextHasAny(pendingContext)) {
      const block = formatBrowserContext(pendingContext as CosBrowserContext);
      finalText = finalText ? `${finalText}\n\n---\n${block}` : block;
    }
    return finalText;
  }

  function clearAfterSend() {
    setText('');
    setPendingAttachments([]);
    setPendingElementRefs([]);
    setPendingContext(null);
    // Inline editor owns its DOM; clear it explicitly so chips disappear
    // along with the text. The setText below fires onChange, which mirrors
    // the empty state back into composer state — that's redundant with
    // the React-side resets above but harmless.
    if (inlineMode) inlineEditorRef.current?.setText('');
    if (draft) draft.clear();
  }

  async function submit() {
    if (!canSend || disabled || submittingRef.current) return;
    submittingRef.current = true;
    const finalText = buildFinalText();
    const atts = pendingAttachments.map(({ id: _id, ...att }) => att);
    const refs = pendingElementRefs;
    const result = onSend(finalText, atts, refs);
    if (!(result instanceof Promise)) {
      // Sync caller — preserve historical "clear immediately" behavior.
      clearAfterSend();
      submittingRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      await result;
      clearAfterSend();
    } catch {
      // Caller surfaces the error elsewhere (chiefOfStaffError); we just
      // unfreeze and leave the operator's text intact.
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  function saveDraft() {
    if (!onSaveDraft || !canSend || disabled) return;
    onSaveDraft(
      buildFinalText(),
      pendingAttachments.map(({ id: _id, ...att }) => att),
      pendingElementRefs,
    );
    clearAfterSend();
  }

  function enqueueAfterCurrent() {
    if (!onEnqueueAfterCurrent || !canSend || disabled) return;
    onEnqueueAfterCurrent(
      buildFinalText(),
      pendingAttachments.map(({ id: _id, ...att }) => att),
      pendingElementRefs,
    );
    setSendModeOpen(false);
    clearAfterSend();
  }

  async function sendAndInterrupt() {
    if (!onSendAndInterrupt || !canSend || disabled || submittingRef.current) return;
    submittingRef.current = true;
    const finalText = buildFinalText();
    const atts = pendingAttachments.map(({ id: _id, ...att }) => att);
    const refs = pendingElementRefs;
    setSendModeOpen(false);
    const result = onSendAndInterrupt(finalText, atts, refs);
    if (!(result instanceof Promise)) {
      clearAfterSend();
      submittingRef.current = false;
      return;
    }
    setSubmitting(true);
    try {
      await result;
      clearAfterSend();
    } catch {
      /* see submit() */
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  function saveDraftToFanOut() {
    const ids = Array.from(fanOutSelected);
    if (!onSaveDraftToAgents || !canSend || disabled || ids.length === 0) return;
    onSaveDraftToAgents(
      ids,
      buildFinalText(),
      pendingAttachments.map(({ id: _id, ...att }) => att),
      pendingElementRefs,
    );
    setSendModeOpen(false);
    setFanOutSelected(new Set());
    clearAfterSend();
  }

  // Recompute @mention state from a textarea's current value + caret. Called
  // after every input/keystroke that could change either. The trigger fires
  // when the char immediately before the caret is `@` AND that `@` sits at a
  // word boundary (start of input or after whitespace) — same boundary rule
  // parseAgentMentions uses on send.
  function refreshMentionState(value: string, caret: number) {
    if (caret <= 0) {
      if (mentionPrefix !== null) setMentionPrefix(null);
      return;
    }
    let i = caret;
    while (i > 0) {
      const ch = value[i - 1];
      if (ch === '@') {
        const before = i >= 2 ? value[i - 2] : '';
        const atBoundary = i === 1 || /\s/.test(before);
        if (!atBoundary) break;
        const partial = value.slice(i, caret);
        setMentionStart(i);
        setMentionPrefix(partial);
        setMentionHighlight(0);
        return;
      }
      if (!/[a-zA-Z0-9_-]/.test(ch)) break;
      i--;
    }
    if (mentionPrefix !== null) setMentionPrefix(null);
  }

  function onTextareaInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    setText(ta.value);
    refreshMentionState(ta.value, ta.selectionStart ?? ta.value.length);
  }

  type MentionCandidate = {
    key: string;
    slug: string;
    label: string;
    sublabel: string;
    icon: string;
  };
  function buildMentionCandidates(prefix: string): MentionCandidate[] {
    const lower = prefix.toLowerCase();
    const out: MentionCandidate[] = [];
    const seenSlugs = new Set<string>();
    for (const a of chiefOfStaffAgents.value) {
      const slug = (a.name || a.id).toLowerCase().replace(/\s+/g, '-');
      const matches = !lower
        || slug.startsWith(lower)
        || a.id.toLowerCase().startsWith(lower)
        || a.name.toLowerCase().startsWith(lower);
      if (!matches) continue;
      seenSlugs.add(slug);
      out.push({ key: `agent:${a.id}`, slug, label: a.name, sublabel: 'agent', icon: '🤖' });
    }
    for (const m of channelMembers) {
      if (!m.refId.toLowerCase().startsWith(lower)) continue;
      const slug = m.refId.toLowerCase().replace(/\s+/g, '-');
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      out.push({
        key: `member:${m.kind}:${m.refId}`,
        slug: m.refId,
        label: m.refId,
        sublabel: m.kind === 'agent' ? 'agent member' : 'user member',
        icon: m.kind === 'agent' ? '🤖' : '👤',
      });
    }
    return out.slice(0, 8);
  }

  const mentionCandidates =
    mentionPrefix === null ? [] : buildMentionCandidates(mentionPrefix);

  function insertMention(slug: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const before = text.slice(0, mentionStart);
    const afterStart = ta.selectionStart ?? mentionStart;
    const after = text.slice(afterStart);
    // Trailing space matches Slack/Twitter behavior — operator can keep
    // typing without manually separating the next word.
    const insertion = `${slug} `;
    const next = `${before}${insertion}${after}`;
    setText(next);
    setMentionPrefix(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      const pos = before.length + insertion.length;
      node.setSelectionRange(pos, pos);
    });
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
    // @mention picker eats nav keys when open. Escape just closes it (does
    // NOT fall through to the existing clear-text / drop-reply-scope flow,
    // which is what the conventions ask for).
    if (mentionPrefix !== null && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionHighlight((h) => Math.min(h + 1, mentionCandidates.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const pick = mentionCandidates[mentionHighlight];
        if (pick) insertMention(pick.slug);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionPrefix(null);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const pick = mentionCandidates[mentionHighlight];
        if (pick) insertMention(pick.slug);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key !== 'Escape') return;
    // onEscape gets the first chance — the bubble uses it to drop reply-pill
    // scope without the default clear-text-first behavior wiping in-progress
    // input. Returning true means "handled, skip the rest."
    if (onEscape && onEscape()) {
      e.preventDefault();
      return;
    }
    if (text) {
      e.preventDefault();
      setText('');
    } else if (onEscapeWhenEmpty) {
      e.preventDefault();
      onEscapeWhenEmpty();
    }
  }

  // Save-draft + send-mode dropdown: rendered as an icon-only tool group that
  // slots into the input toolbar right before the stop/send pair via the
  // toolbar's `beforeSend` slot. Keeping the JSX out of the main return keeps
  // the toolbar block readable and lets us pass nothing when neither
  // save-draft nor any send-mode submenu items are wired.
  const fanOutOthers = (fanOutAgents ?? []).filter((a) => !a.current);
  const showFanOut = !!onSaveDraftToAgents && fanOutOthers.length > 0;
  const showEnqueue = !!streaming && !!onEnqueueAfterCurrent;
  const showInterruptSend = !!streaming && !!onSendAndInterrupt;
  const hasSendModeMenu = showFanOut || showEnqueue || showInterruptSend;
  const saveDraftSlot = (onSaveDraft || hasSendModeMenu) ? (
    <div class="cos-tool-group cos-send-mode-group" ref={sendModeGroupRef}>
      {onSaveDraft && (
        <button
          type="button"
          class="cos-tool-btn cos-tool-btn-main cos-save-draft-btn"
          onClick={saveDraft}
          disabled={!canSend || disabled}
          title="Save as draft (won't send) — appears as a pending row at the bottom of the thread"
          aria-label="Save as draft"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
      )}
      {hasSendModeMenu && (
        <button
          type="button"
          class="cos-tool-dropdown-toggle"
          onClick={(e) => {
            e.stopPropagation();
            const r = sendModeGroupRef.current?.getBoundingClientRect();
            if (r) setSendModeMenuPos({ top: r.top - 4, left: r.left });
            setSendModeOpen((v) => !v);
          }}
          title="Send / draft options"
          aria-label="Send and draft options"
          aria-expanded={sendModeOpen}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
      )}
      {sendModeOpen && hasSendModeMenu && (
        <div class="cos-tool-menu cos-send-mode-menu" style={sendModeMenuPos ? { top: `${sendModeMenuPos.top}px`, left: `${sendModeMenuPos.left}px`, transform: 'translateY(-100%)' } : undefined}>
          {showInterruptSend && (
            <button
              type="button"
              class="cos-tool-menu-item cos-tool-menu-btn"
              onClick={sendAndInterrupt}
              disabled={!canSend || disabled}
              title="Stop the running turn, then send this message"
            >
              Send & interrupt current
            </button>
          )}
          {showEnqueue && (
            <button
              type="button"
              class="cos-tool-menu-item cos-tool-menu-btn"
              onClick={enqueueAfterCurrent}
              disabled={!canSend || disabled}
              title="Send automatically when the current turn finishes"
            >
              Send when current finishes
            </button>
          )}
          {(showInterruptSend || showEnqueue) && showFanOut && <div class="cos-tool-menu-divider" />}
          {showFanOut && (
            <>
              <div class="cos-tool-menu-section">Also save draft for:</div>
              {fanOutOthers.map((a) => (
                <label class="cos-tool-menu-item" key={a.id}>
                  <input
                    type="checkbox"
                    checked={fanOutSelected.has(a.id)}
                    onChange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      const next = new Set(fanOutSelected);
                      if (checked) next.add(a.id); else next.delete(a.id);
                      setFanOutSelected(next);
                    }}
                  />
                  {a.name}
                </label>
              ))}
              <button
                type="button"
                class="cos-tool-menu-item cos-tool-menu-btn"
                onClick={saveDraftToFanOut}
                disabled={!canSend || disabled || fanOutSelected.size === 0}
                title="Save this draft to each selected agent's drafts list"
              >
                Save to selected
              </button>
            </>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div class={`cos-composer${className ? ` ${className}` : ''}`} ref={wrapperRef}>
      {prefix}
      {(pendingAttachments.length > 0 || (!inlineMode && pendingElementRefs.length > 0) || pendingContextHasAny(pendingContext)) && (
        <div class="cos-attach-strip">
          {pendingAttachments.map((att) => (
            <div class="cos-attach-thumb" key={att.id}>
              <img
                src={att.dataUrl}
                alt={att.name || 'attachment'}
                style={onAttachmentClick ? { cursor: 'pointer' } : undefined}
                title={onAttachmentClick ? 'Click to edit' : undefined}
                onClick={onAttachmentClick ? () => onAttachmentClick(att.id, att.dataUrl) : undefined}
              />
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                title="Remove attachment"
                aria-label="Remove attachment"
              >&times;</button>
            </div>
          ))}
          {!inlineMode && pendingElementRefs.map((ref, idx) => {
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
          {pendingContextHasAny(pendingContext) && (
            <div class="cos-element-chip" title={summarizeBrowserContext(pendingContext as CosBrowserContext)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <code>{summarizeBrowserContext(pendingContext as CosBrowserContext)}</code>
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => setPendingContext(null)}
                title="Remove browser context"
                aria-label="Remove browser context"
              >&times;</button>
            </div>
          )}
        </div>
      )}
      <div class="cos-composer-input-wrap" style={{ position: 'relative' }}>
        {inlineMode ? (
          <CosInlineEditor
            ref={inlineEditorRef}
            placeholder={placeholder}
            disabled={disabled || submitting}
            style={inputStyle}
            autoGrow={autoGrow}
            initialText={text}
            onChange={(nextText, refs) => {
              setText(nextText);
              setPendingElementRefs(refs);
            }}
            onSubmit={() => { void submit(); }}
            onEscape={() => onEscape ? onEscape() : false}
            onPaste={onPaste}
          />
        ) : (
          <textarea
            ref={setTextareaEl}
            class={`cos-input${submitting ? ' cos-input-submitting' : ''}`}
            value={text}
            placeholder={placeholder}
            disabled={disabled || submitting}
            style={inputStyle}
            onInput={onTextareaInput}
            onClick={(e) => {
              const ta = e.target as HTMLTextAreaElement;
              refreshMentionState(ta.value, ta.selectionStart ?? ta.value.length);
            }}
            onKeyUp={(e) => {
              // Arrow keys can move caret without changing value — keep the
              // mention picker in sync.
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                const ta = e.target as HTMLTextAreaElement;
                refreshMentionState(ta.value, ta.selectionStart ?? ta.value.length);
              }
            }}
            onBlur={() => {
              // Close the picker on blur, but defer so a click on a row still
              // fires its handler before the dropdown unmounts.
              setTimeout(() => setMentionPrefix(null), 120);
            }}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            rows={rows}
          />
        )}
        {mentionPrefix !== null && mentionCandidates.length > 0 && (
          <div
            class="cos-mention-picker"
            style={{
              position: 'absolute',
              left: 0,
              bottom: '100%',
              marginBottom: '4px',
              minWidth: '220px',
              maxHeight: '240px',
              overflowY: 'auto',
              background: '#1e293b',
              border: '1px solid var(--pw-border)',
              borderRadius: '4px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              zIndex: 50,
              padding: '4px 0',
            }}
            role="listbox"
          >
            {mentionCandidates.map((c, idx) => (
              <div
                key={c.key}
                class={`cos-mention-row${idx === mentionHighlight ? ' cos-mention-row-active' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 10px',
                  cursor: 'pointer',
                  background: idx === mentionHighlight ? 'rgba(255,255,255,0.08)' : 'transparent',
                  fontSize: '13px',
                  color: 'var(--pw-text)',
                }}
                role="option"
                aria-selected={idx === mentionHighlight}
                onMouseEnter={() => setMentionHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(c.slug);
                }}
              >
                <span aria-hidden="true">{c.icon}</span>
                <span style={{ fontWeight: 500 }}>{c.slug}</span>
                <span style={{ color: 'var(--pw-text-muted)', fontSize: '11px', marginLeft: 'auto' }}>
                  {c.sublabel}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <CosInputToolbar
        cameraGroupRef={cameraGroupRef}
        pickerGroupRef={pickerGroupRef}
        micGroupRef={micGroupRef}
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
        consoleGroupRef={consoleGroupRef}
        consoleCount={(() => {
          if (!pendingContext) return 0;
          let n = 0;
          if (pendingContext.console) n += pendingContext.console.length;
          if (pendingContext.network) n += pendingContext.network.length;
          if (pendingContext.performance) n += 1;
          if (pendingContext.environment) n += 1;
          return n;
        })()}
        captureConsole={captureConsole}
        consoleMenuOpen={consoleMenuOpen}
        setConsoleMenuOpen={setConsoleMenuOpen}
        consoleMenuPos={consoleMenuPos}
        setConsoleMenuPos={setConsoleMenuPos}
        micRecording={voice.recording}
        micElapsed={voice.elapsed}
        micInterim={voice.interim}
        toggleMicRecord={voice.toggleRecord}
        micBrainstorm={voice.brainstorm}
        setMicBrainstorm={voice.setBrainstorm}
        micMenuOpen={micMenuOpen}
        setMicMenuOpen={setMicMenuOpen}
        micMenuPos={micMenuPos}
        setMicMenuPos={setMicMenuPos}
        canSend={canSend && !submitting}
        onSubmit={submit}
        streaming={streaming}
        onStop={onStop}
        beforeSend={saveDraftSlot}
      />
    </div>
  );
});
