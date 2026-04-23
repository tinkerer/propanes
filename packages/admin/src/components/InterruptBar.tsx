import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { resumeSession, allSessions, exitedSessions } from '../lib/sessions.js';
import { api } from '../lib/api.js';
import { captureScreenshot, type ScreenshotMethod } from '@propanes/widget/screenshot';
import { startPicker, type SelectedElementInfo } from '@propanes/widget/element-picker';
import { VoiceRecorder, type VoiceRecordingResult } from '@propanes/widget/voice-recorder';
import { snapshotConsole, formatConsoleEntries, type ConsoleEntry } from '../lib/console-buffer.js';

interface Props {
  sessionId: string;
  permissionProfile?: string;
}

type PendingImage = {
  id: string;
  blob: Blob;
  previewUrl: string;
  name: string;
};

const TERMINAL_STATUSES = new Set(['completed', 'exited', 'failed', 'deleted', 'archived', 'killed']);

// Text input pinned to the bottom of the session view. Two modes:
//   - Running + headless: "Interrupt" — kills the session and resumes with the
//     new prompt. Interactive/yolo TTY sessions skip this because the terminal
//     already accepts live input.
//   - Terminated (any profile): "Resume with prompt" — restarts the session
//     with full context plus the new prompt appended.
// Modeled on the widget dispatch/submit button: paper-plane submit + a left-
// arrow toggle that reveals Screenshot / DOM select / Console capture / Mic
// actions — each with inline option toggles mirroring the widget menus.
export function InterruptBar({ sessionId, permissionProfile }: Props) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const sess = allSessions.value.find((s: any) => s.id === sessionId);
  const profile = permissionProfile || sess?.permissionProfile;
  // "Headless" here means one-shot pipe mode — the session doesn't answer
  // user input after it starts, so the bar shows Interrupt while it runs.
  // headless-stream-* keep stdin open, so they behave like interactive for
  // this UI affordance.
  const isHeadless = profile === 'headless-yolo';
  const isPlain = profile === 'plain';
  const markedExited = exitedSessions.value.has(sessionId);
  const hasTerminalStatus = !!sess?.status && TERMINAL_STATUSES.has(sess.status);
  const isTerminated = markedExited || hasTerminalStatus;
  const isRunning = sess && (sess.status === 'running' || sess.status === 'pending') && !markedExited;

  const mode: 'interrupt' | 'resume' | null = !isPlain && isRunning && isHeadless
    ? 'interrupt'
    : !isPlain && isTerminated
      ? 'resume'
      : null;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [text]);

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

  useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      if (pickerCleanupRef.current) pickerCleanupRef.current();
      if (micTimerRef.current) clearInterval(micTimerRef.current);
      // Best-effort stop if component unmounts mid-recording.
      if (voiceRecorderRef.current?.recording) {
        voiceRecorderRef.current.stop().catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!mode) return null;

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
      setError(err?.message || 'Screenshot failed');
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
        setError(err?.message || 'Mic stop failed');
      }
      return;
    }

    // Start
    setMenuOpen(false);
    setError(null);
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
      setError(err?.message || 'Mic start failed');
    }
  }

  function discardVoice() {
    setVoiceResult(null);
  }

  function removeElement(idx: number) {
    setElements((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    const prompt = text.trim();
    const hasAttach = images.length > 0
      || elements.length > 0
      || (consoleCap && consoleCap.length > 0)
      || !!voiceResult;
    if (!prompt && !hasAttach) return;
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let enriched = prompt;
      const extras: string[] = [];

      // Pull voice screenshot blobs into the same upload batch as regular images
      // so the agent gets a single list of URLs.
      const allImageBlobs: Blob[] = images.map((i) => i.blob);
      const voiceShotIndexStart = allImageBlobs.length;
      if (voiceResult && voiceResult.screenshots.length > 0) {
        for (const s of voiceResult.screenshots) allImageBlobs.push(s.blob);
      }

      let screenshotUrls: string[] = [];
      let screenshotPaths: string[] = [];
      if (allImageBlobs.length > 0) {
        const uploaded = await api.uploadScreenshots(allImageBlobs, {
          sessionId,
          appId: sess?.appId || undefined,
          sourceUrl: typeof window !== 'undefined' ? window.location.href : undefined,
        });
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        screenshotUrls = uploaded.screenshots.map((s) => `${origin}/api/v1/screenshots/${s.id}`);
        screenshotPaths = uploaded.screenshots.map((s) => s.path).filter(Boolean);
      }

      const pastedUrls = screenshotUrls.slice(0, voiceShotIndexStart);
      const voiceUrls = screenshotUrls.slice(voiceShotIndexStart);
      const pastedPaths = screenshotPaths.slice(0, voiceShotIndexStart);

      if (pastedUrls.length > 0) {
        const pathBlock = pastedPaths.length
          ? `\nLocal tmp paths (if agent is on the server host):\n${pastedPaths.map((p) => `- ${p}`).join('\n')}`
          : '';
        extras.push(`Attached screenshots (GET to fetch PNG):\n${pastedUrls.map((u) => `- ${u}`).join('\n')}${pathBlock}`);
      }

      if (elements.length > 0) {
        const lines = elements.map((e, i) => {
          const classes = (e.classes || []).filter((c) => !c.startsWith('pw-')).join('.');
          const tag = `${e.tagName || 'elem'}${e.id ? `#${e.id}` : ''}${classes ? `.${classes}` : ''}`;
          const rect = e.boundingRect
            ? `{x:${Math.round(e.boundingRect.x)}, y:${Math.round(e.boundingRect.y)}, w:${Math.round(e.boundingRect.width)}, h:${Math.round(e.boundingRect.height)}}`
            : '';
          const txt = e.textContent ? ` — "${e.textContent.slice(0, 80).replace(/\s+/g, ' ')}"` : '';
          const childHtml = e.childrenHTML
            ? `\n   children HTML (truncated to 500 chars):\n   ${e.childrenHTML.slice(0, 500).replace(/\n/g, '\n   ')}`
            : '';
          return `${i + 1}. ${tag}${txt}\n   selector: ${e.selector}${rect ? `\n   rect: ${rect}` : ''}${childHtml}`;
        }).join('\n');
        extras.push(`Selected DOM elements:\n${lines}`);
      }

      if (consoleCap && consoleCap.length > 0) {
        const body = formatConsoleEntries(consoleCap).slice(-4000);
        extras.push(`Recent browser console output:\n\`\`\`\n${body}\n\`\`\``);
      }

      if (voiceResult) {
        const transcriptText = voiceResult.transcript
          .filter((t) => t.isFinal)
          .map((t) => t.text.trim())
          .filter(Boolean)
          .join(' ');
        const parts: string[] = [];
        parts.push(`Voice capture (${Math.round(voiceResult.duration / 1000)}s, ${voiceResult.transcript.filter((t) => t.isFinal).length} final segments, ${voiceResult.interactions.length} interactions, ${voiceResult.screenshots.length} screenshots):`);
        if (transcriptText) parts.push(`Transcript: "${transcriptText}"`);
        if (voiceResult.interactions.length > 0) {
          const ixLines = voiceResult.interactions.slice(0, 30).map((ev, i) => {
            const t = (ev.timestamp / 1000).toFixed(1);
            const sel = ev.target.selector || ev.target.tagName;
            const txt = ev.target.textContent ? ` "${ev.target.textContent.slice(0, 40)}"` : '';
            return `  ${i + 1}. [${t}s] ${ev.type} ${sel}${txt}`;
          }).join('\n');
          parts.push(`Interactions:\n${ixLines}`);
        }
        if (voiceUrls.length > 0) {
          parts.push(`Gesture screenshots:\n${voiceUrls.map((u) => `- ${u}`).join('\n')}`);
        }
        if (voiceResult.consoleLogs.length > 0) {
          const body = voiceResult.consoleLogs.slice(-30).map((e) => {
            const t = (e.timestamp / 1000).toFixed(1);
            return `  [${t}s] ${e.level}: ${e.args.join(' ').slice(0, 200)}`;
          }).join('\n');
          parts.push(`Console during capture:\n${body}`);
        }
        extras.push(parts.join('\n'));
      }

      if (extras.length > 0) {
        enriched = `${prompt}${prompt ? '\n\n' : ''}---\n${extras.join('\n\n')}`;
      }

      const newId = await resumeSession(sessionId, { additionalPrompt: enriched });
      if (!newId) throw new Error(mode === 'interrupt' ? 'Restart failed' : 'Resume failed');
      setText('');
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
      setImages([]);
      setElements([]);
      setConsoleCap(null);
      setVoiceResult(null);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submit();
    }
  }

  const placeholder = mode === 'interrupt' ? 'Interrupt with new prompt…' : 'Resume with new prompt…';
  const buttonTitle = mode === 'interrupt'
    ? 'Kill the current session and restart with this additional prompt (Enter to send, Shift+Enter for newline)'
    : 'Resume this session with full context plus the new prompt appended (Enter to send, Shift+Enter for newline)';
  const hasContent = !!text.trim()
    || images.length > 0
    || elements.length > 0
    || !!(consoleCap && consoleCap.length > 0)
    || !!voiceResult;
  const consoleCount = consoleCap?.length ?? 0;
  const showChips = images.length > 0 || elements.length > 0 || consoleCap !== null || !!voiceResult || micRecording;

  const voiceFinalCount = voiceResult?.transcript.filter((t) => t.isFinal).length ?? 0;
  const voiceIxCount = voiceResult?.interactions.length ?? 0;
  const voiceShotCount = voiceResult?.screenshots.length ?? 0;

  return (
    <div class={`interrupt-bar interrupt-bar--${mode}`} ref={containerRef}>
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
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={submitting}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div class="interrupt-bar-submit-group" ref={submitGroupRef}>
          <button
            type="button"
            class={`interrupt-bar-expand-toggle${menuOpen ? ' is-open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            disabled={submitting}
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
            disabled={submitting || !hasContent}
            onClick={submit}
            title={buttonTitle}
            aria-label={mode === 'interrupt' ? 'Interrupt' : 'Resume'}
          >
            {submitting
              ? (
                <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true" style={{ fill: 'none' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" style={{ fill: 'none' }}>
                    <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                  </path>
                </svg>
              )
              : (
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
