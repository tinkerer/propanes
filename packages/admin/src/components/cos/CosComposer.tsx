import { useEffect, useImperativeHandle, useRef, useState, useMemo } from 'preact/hooks';
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
import {
  useComposerCore,
  type ComposerDraftBinding,
  type ComposerImage,
} from '../../lib/use-composer-core.js';

/**
 * Shared composer used by the bubble's main chat row and the thread side
 * panel. Thin wrapper around `useComposerCore` that adds CoS-specific
 * features:
 *   - voice recording (useCosVoice), screenshot capture (useCosScreenshot),
 *     element picker (useCosElementPicker) hooks
 *   - CosInputToolbar with camera/picker/console/mic buttons
 *   - CosInlineEditor for inline element chip mode
 *   - @mention picker
 *   - browser-context capture (console + network + perf + page info)
 *   - save-draft, fan-out, enqueue-after-current, send-and-interrupt modes
 *   - imperative handle (getSnapshot / loadSnapshot / updateAttachmentDataUrl)
 */

// Re-export the draft binding type so callers keep importing from here.
export type CosComposerDraftBinding = ComposerDraftBinding;

/** Imperative handle for callers (mostly the bubble) that need to mutate
 *  composer-owned state without lifting it. Kept intentionally narrow. */
export interface CosComposerHandle {
  updateAttachmentDataUrl: (id: string, dataUrl: string) => void;
  getSnapshot: () => { text: string; attachments: CosImageAttachment[]; elementRefs: CosElementRef[] };
  loadSnapshot: (snapshot: { text: string; attachments?: CosImageAttachment[]; elementRefs?: CosElementRef[] }) => void;
}

export interface CosComposerProps {
  placeholder: string;
  onSend: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void | Promise<void>;
  draft?: CosComposerDraftBinding;
  onEscapeWhenEmpty?: () => void;
  onEscape?: () => boolean;
  disabled?: boolean;
  rows?: number;
  className?: string;
  prefix?: ComponentChildren;
  inputStyle?: JSX.CSSProperties;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  autoGrow?: { maxPx: number };
  onAttachmentClick?: (id: string, dataUrl: string) => void;
  onTextChange?: (text: string) => void;
  onSaveDraft?: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  fanOutAgents?: Array<{ id: string; name: string; current?: boolean }>;
  onSaveDraftToAgents?: (agentIds: string[], text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  streaming?: boolean;
  onStop?: () => void;
  onEnqueueAfterCurrent?: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  onSendAndInterrupt?: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert ComposerImage[] to CosImageAttachment[] for the onSend callback. */
function imagesToAttachments(images: ComposerImage[]): CosImageAttachment[] {
  return images.map((img) => {
    if (img.kind === 'dataUrl') {
      return { kind: 'image' as const, dataUrl: img.dataUrl, name: img.name };
    }
    // blob mode shouldn't happen in CosComposer (we use dataUrl mode), but
    // handle gracefully by dropping — callers only accept dataUrl.
    return { kind: 'image' as const, dataUrl: '', name: img.name };
  });
}

/** Check if a CosBrowserContext has any content. */
function contextHasAny(c: CosBrowserContext | null): boolean {
  if (!c) return false;
  return !!(
    (c.console && c.console.length > 0) ||
    (c.network && c.network.length > 0) ||
    (c.performance && Object.keys(c.performance).length > 0) ||
    c.environment
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const inlineMode = inlineElementChipsEnabled.value;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inlineEditorRef = useRef<CosInlineEditorHandle>(null);
  const setTextareaEl = (el: HTMLTextAreaElement | null) => {
    (textareaRef as { current: HTMLTextAreaElement | null }).current = el;
    if (externalTextareaRef) {
      (externalTextareaRef as { current: HTMLTextAreaElement | null }).current = el;
    }
  };

  // Toolbar group refs
  const cameraGroupRef = useRef<HTMLDivElement>(null);
  const pickerGroupRef = useRef<HTMLDivElement>(null);
  const consoleGroupRef = useRef<HTMLDivElement>(null);
  const micGroupRef = useRef<HTMLDivElement>(null);
  const sendModeGroupRef = useRef<HTMLDivElement>(null);

  // Toolbar menu state
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

  // ---- Shared core: text, images, elements, context, submit guard ----
  const core = useComposerCore<CosElementRef, CosBrowserContext | null>({
    draft,
    onTextChange,
    autoGrowMaxPx: autoGrow?.maxPx,
    textareaRef,
    imageMode: 'dataUrl',
    contextHasContent: contextHasAny,
    onEscapeWhenEmpty,
    onEscape,
  });

  // Sync inline editor when draft binding changes (scope switch)
  const prevDraftForEditor = useRef<ComposerDraftBinding | undefined>(undefined);
  useEffect(() => {
    if (!inlineMode || !draft) return;
    if (prevDraftForEditor.current !== draft) {
      prevDraftForEditor.current = draft;
      inlineEditorRef.current?.setText(core.text);
    }
  }, [draft, core.text, inlineMode]);

  // ---- @mention picker ----
  const [mentionPrefix, setMentionPrefix] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number>(0);
  const [mentionHighlight, setMentionHighlight] = useState<number>(0);
  const [channelMembers, setChannelMembers] = useState<
    Array<{ kind: 'user' | 'agent'; refId: string; role: string }>
  >([]);
  const channelId = activeChannel.value?.id ?? null;
  useEffect(() => {
    if (!channelId) { setChannelMembers([]); return; }
    let cancelled = false;
    api.getChannelMembers(channelId)
      .then((res) => { if (!cancelled) setChannelMembers(res.members); })
      .catch(() => { if (!cancelled) setChannelMembers([]); });
    return () => { cancelled = true; };
  }, [channelId]);

  function refreshMentionState(value: string, caret: number) {
    if (caret <= 0) { if (mentionPrefix !== null) setMentionPrefix(null); return; }
    let i = caret;
    while (i > 0) {
      const ch = value[i - 1];
      if (ch === '@') {
        const before = i >= 2 ? value[i - 2] : '';
        if (!(i === 1 || /\s/.test(before))) break;
        setMentionStart(i);
        setMentionPrefix(value.slice(i, caret));
        setMentionHighlight(0);
        return;
      }
      if (!/[a-zA-Z0-9_-]/.test(ch)) break;
      i--;
    }
    if (mentionPrefix !== null) setMentionPrefix(null);
  }

  type MentionCandidate = { key: string; slug: string; label: string; sublabel: string; icon: string };
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (mentionPrefix === null) return [];
    const lower = mentionPrefix.toLowerCase();
    const out: MentionCandidate[] = [];
    const seenSlugs = new Set<string>();
    for (const a of chiefOfStaffAgents.value) {
      const slug = (a.name || a.id).toLowerCase().replace(/\s+/g, '-');
      if (lower && !slug.startsWith(lower) && !a.id.toLowerCase().startsWith(lower) && !a.name.toLowerCase().startsWith(lower)) continue;
      seenSlugs.add(slug);
      out.push({ key: `agent:${a.id}`, slug, label: a.name, sublabel: 'agent', icon: '\uD83E\uDD16' });
    }
    for (const m of channelMembers) {
      if (lower && !m.refId.toLowerCase().startsWith(lower)) continue;
      const slug = m.refId.toLowerCase().replace(/\s+/g, '-');
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      out.push({
        key: `member:${m.kind}:${m.refId}`, slug: m.refId, label: m.refId,
        sublabel: m.kind === 'agent' ? 'agent member' : 'user member',
        icon: m.kind === 'agent' ? '\uD83E\uDD16' : '\uD83D\uDC64',
      });
    }
    return out.slice(0, 8);
  }, [mentionPrefix, channelMembers]);

  function insertMention(slug: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const before = core.text.slice(0, mentionStart);
    const afterStart = ta.selectionStart ?? mentionStart;
    const after = core.text.slice(afterStart);
    const insertion = `${slug} `;
    const next = `${before}${insertion}${after}`;
    core.setText(next);
    setMentionPrefix(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      const pos = before.length + insertion.length;
      node.setSelectionRange(pos, pos);
    });
  }

  // ---- Imperative handle ----
  useImperativeHandle(handleRef, () => ({
    updateAttachmentDataUrl(id: string, dataUrl: string) {
      core.updateImageDataUrl(id, dataUrl);
    },
    getSnapshot() {
      return {
        text: core.text,
        attachments: imagesToAttachments(core.images),
        elementRefs: core.elements,
      };
    },
    loadSnapshot(snapshot) {
      core.setText(snapshot.text);
      core.setImages(
        (snapshot.attachments ?? []).map((att) => ({
          id: `cos-att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'dataUrl' as const,
          dataUrl: att.dataUrl,
          name: att.name,
        })),
      );
      core.setElements(snapshot.elementRefs ?? []);
      core.setContext(null);
      if (inlineMode) inlineEditorRef.current?.setText(snapshot.text);
    },
  }), [core.text, core.images, core.elements, inlineMode]);

  // ---- CoS hooks: voice, screenshot, element picker ----
  const voice = useCosVoice({
    getInputBase: () => core.text,
    onAppendInput: (next) => {
      if (inlineMode) inlineEditorRef.current?.setText(next);
      else core.setText(next);
    },
    focusInput: () => {
      if (inlineMode) inlineEditorRef.current?.focus();
      else textareaRef.current?.focus();
    },
  });
  const screenshot = useCosScreenshot({
    onAttachBlob: (blob, name) => core.addImageBlob(blob, name),
    closeCameraMenu: () => setCameraMenuOpen(false),
  });
  const picker = useCosElementPicker({
    wrapperRef,
    appendElementRefs: (refs) => {
      if (inlineMode) inlineEditorRef.current?.insertChips(refs);
      else core.setElements((prev) => [...prev, ...refs]);
    },
    focusInput: () => {
      if (inlineMode) inlineEditorRef.current?.focus();
      else textareaRef.current?.focus();
    },
    closePickerMenu: () => setPickerMenuOpen(false),
  });

  // ---- Browser context capture ----
  function captureConsole() {
    const snap = snapshotBrowserContext(cosSelectedCollectors.value);
    core.setContext(snap);
    setMicMenuOpen(false);
    setCameraMenuOpen(false);
    setPickerMenuOpen(false);
    setConsoleMenuOpen(false);
    textareaRef.current?.focus();
  }

  // ---- Build final text with context ----
  function buildFinalText(): string {
    let finalText = core.text.trim();
    if (contextHasAny(core.context)) {
      const block = formatBrowserContext(core.context as CosBrowserContext);
      finalText = finalText ? `${finalText}\n\n---\n${block}` : block;
    }
    return finalText;
  }

  function clearAfterSend() {
    core.clearAll();
    if (inlineMode) inlineEditorRef.current?.setText('');
  }

  // ---- Submit actions ----
  async function submit() {
    if (!core.hasContent || disabled || core.submittingRef.current) return;
    core.submittingRef.current = true;
    const finalText = buildFinalText();
    const atts = imagesToAttachments(core.images);
    const refs = core.elements;
    const result = onSend(finalText, atts, refs);
    if (!(result instanceof Promise)) {
      clearAfterSend();
      core.submittingRef.current = false;
      return;
    }
    core.setSubmitting(true);
    try {
      await result;
      clearAfterSend();
    } catch { /* caller surfaces error */ }
    finally {
      core.setSubmitting(false);
      core.submittingRef.current = false;
    }
  }

  function saveDraft() {
    if (!onSaveDraft || !core.hasContent || disabled) return;
    onSaveDraft(buildFinalText(), imagesToAttachments(core.images), core.elements);
    clearAfterSend();
  }

  function enqueueAfterCurrent() {
    if (!onEnqueueAfterCurrent || !core.hasContent || disabled) return;
    onEnqueueAfterCurrent(buildFinalText(), imagesToAttachments(core.images), core.elements);
    setSendModeOpen(false);
    clearAfterSend();
  }

  async function sendAndInterrupt() {
    if (!onSendAndInterrupt || !core.hasContent || disabled || core.submittingRef.current) return;
    core.submittingRef.current = true;
    const finalText = buildFinalText();
    const atts = imagesToAttachments(core.images);
    const refs = core.elements;
    setSendModeOpen(false);
    const result = onSendAndInterrupt(finalText, atts, refs);
    if (!(result instanceof Promise)) {
      clearAfterSend();
      core.submittingRef.current = false;
      return;
    }
    core.setSubmitting(true);
    try { await result; clearAfterSend(); }
    catch { /* see submit() */ }
    finally { core.setSubmitting(false); core.submittingRef.current = false; }
  }

  function saveDraftToFanOut() {
    const ids = Array.from(fanOutSelected);
    if (!onSaveDraftToAgents || !core.hasContent || disabled || ids.length === 0) return;
    onSaveDraftToAgents(ids, buildFinalText(), imagesToAttachments(core.images), core.elements);
    setSendModeOpen(false);
    setFanOutSelected(new Set());
    clearAfterSend();
  }

  // ---- Keyboard ----
  function onTextareaInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    core.setText(ta.value);
    refreshMentionState(ta.value, ta.selectionStart ?? ta.value.length);
  }

  function onKeyDown(e: KeyboardEvent) {
    core.onKeyDown(e, {
      mentionActive: mentionPrefix !== null && mentionCandidates.length > 0,
      onMentionKey: (ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); setMentionHighlight((h) => Math.min(h + 1, mentionCandidates.length - 1)); return true; }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); setMentionHighlight((h) => Math.max(h - 1, 0)); return true; }
        if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); const pick = mentionCandidates[mentionHighlight]; if (pick) insertMention(pick.slug); return true; }
        if (ev.key === 'Escape') { ev.preventDefault(); setMentionPrefix(null); return true; }
        return false;
      },
      submit: () => { void submit(); },
    });
  }

  // ---- Save-draft + send-mode dropdown slot ----
  const fanOutOthers = (fanOutAgents ?? []).filter((a) => !a.current);
  const showFanOut = !!onSaveDraftToAgents && fanOutOthers.length > 0;
  const showEnqueue = !!streaming && !!onEnqueueAfterCurrent;
  const showInterruptSend = !!streaming && !!onSendAndInterrupt;
  const hasSendModeMenu = showFanOut || showEnqueue || showInterruptSend;
  const canSend = core.hasContent && !core.submitting;
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
            <button type="button" class="cos-tool-menu-item cos-tool-menu-btn" onClick={sendAndInterrupt} disabled={!canSend || disabled} title="Stop the running turn, then send this message">
              Send & interrupt current
            </button>
          )}
          {showEnqueue && (
            <button type="button" class="cos-tool-menu-item cos-tool-menu-btn" onClick={enqueueAfterCurrent} disabled={!canSend || disabled} title="Send automatically when the current turn finishes">
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
              <button type="button" class="cos-tool-menu-item cos-tool-menu-btn" onClick={saveDraftToFanOut} disabled={!canSend || disabled || fanOutSelected.size === 0} title="Save this draft to each selected agent's drafts list">
                Save to selected
              </button>
            </>
          )}
        </div>
      )}
    </div>
  ) : null;

  // ---- Render ----
  const pendingContext = core.context;
  return (
    <div class={`cos-composer${className ? ` ${className}` : ''}`} ref={wrapperRef}>
      {prefix}
      {(core.images.length > 0 || (!inlineMode && core.elements.length > 0) || contextHasAny(pendingContext)) && (
        <div class="cos-attach-strip">
          {core.images.map((att) => (
            <div class="cos-attach-thumb" key={att.id}>
              <img
                src={att.kind === 'dataUrl' ? att.dataUrl : att.previewUrl}
                alt={att.name || 'attachment'}
                style={onAttachmentClick ? { cursor: 'pointer' } : undefined}
                title={onAttachmentClick ? 'Click to edit' : undefined}
                onClick={onAttachmentClick && att.kind === 'dataUrl' ? () => onAttachmentClick(att.id, att.dataUrl) : undefined}
              />
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => core.removeImage(att.id)}
                title="Remove attachment"
                aria-label="Remove attachment"
              >&times;</button>
            </div>
          ))}
          {!inlineMode && core.elements.map((ref, idx) => {
            let display = ref.tagName || 'element';
            if (ref.id) display += `#${ref.id}`;
            const cls = (ref.classes || []).filter((c: string) => !c.startsWith('pw-')).slice(0, 2);
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
                  onClick={() => core.setElements((prev) => prev.filter((_, i) => i !== idx))}
                  title="Remove element reference"
                  aria-label="Remove element reference"
                >&times;</button>
              </div>
            );
          })}
          {contextHasAny(pendingContext) && (
            <div class="cos-element-chip" title={summarizeBrowserContext(pendingContext as CosBrowserContext)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <code>{summarizeBrowserContext(pendingContext as CosBrowserContext)}</code>
              <button
                type="button"
                class="cos-attach-remove"
                onClick={() => core.setContext(null)}
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
            disabled={disabled || core.submitting}
            style={inputStyle}
            autoGrow={autoGrow}
            initialText={core.text}
            onChange={(nextText, refs) => {
              core.setText(nextText);
              core.setElements(refs);
            }}
            onSubmit={() => { void submit(); }}
            onEscape={() => onEscape ? onEscape() : false}
            onPaste={core.onPaste}
          />
        ) : (
          <textarea
            ref={setTextareaEl}
            class={`cos-input${core.submitting ? ' cos-input-submitting' : ''}`}
            value={core.text}
            placeholder={placeholder}
            disabled={disabled || core.submitting}
            style={inputStyle}
            onInput={onTextareaInput}
            onClick={(e) => {
              const ta = e.target as HTMLTextAreaElement;
              refreshMentionState(ta.value, ta.selectionStart ?? ta.value.length);
            }}
            onKeyUp={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                const ta = e.target as HTMLTextAreaElement;
                refreshMentionState(ta.value, ta.selectionStart ?? ta.value.length);
              }
            }}
            onBlur={() => { setTimeout(() => setMentionPrefix(null), 120); }}
            onPaste={core.onPaste}
            onKeyDown={onKeyDown}
            rows={rows}
          />
        )}
        {mentionPrefix !== null && mentionCandidates.length > 0 && (
          <div
            class="cos-mention-picker"
            style={{
              position: 'absolute', left: 0, bottom: '100%', marginBottom: '4px',
              minWidth: '220px', maxHeight: '240px', overflowY: 'auto',
              background: '#1e293b', border: '1px solid var(--pw-border)',
              borderRadius: '4px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              zIndex: 50, padding: '4px 0',
            }}
            role="listbox"
          >
            {mentionCandidates.map((c, idx) => (
              <div
                key={c.key}
                class={`cos-mention-row${idx === mentionHighlight ? ' cos-mention-row-active' : ''}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
                  cursor: 'pointer', background: idx === mentionHighlight ? 'rgba(255,255,255,0.08)' : 'transparent',
                  fontSize: '13px', color: 'var(--pw-text)',
                }}
                role="option"
                aria-selected={idx === mentionHighlight}
                onMouseEnter={() => setMentionHighlight(idx)}
                onMouseDown={(e) => { e.preventDefault(); insertMention(c.slug); }}
              >
                <span aria-hidden="true">{c.icon}</span>
                <span style={{ fontWeight: 500 }}>{c.slug}</span>
                <span style={{ color: 'var(--pw-text-muted)', fontSize: '11px', marginLeft: 'auto' }}>{c.sublabel}</span>
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
        canSend={canSend}
        onSubmit={() => { void submit(); }}
        streaming={streaming}
        onStop={onStop}
        beforeSend={saveDraftSlot}
      />
    </div>
  );
});
