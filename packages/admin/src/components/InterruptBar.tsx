import { useState } from 'preact/hooks';
import { resumeSession, allSessions, exitedSessions, lastResumeError } from '../lib/sessions.js';
import { api } from '../lib/api.js';
import { formatConsoleEntries } from '../lib/console-buffer.js';
import { UnifiedComposer, type UnifiedComposerData } from './UnifiedComposer.js';

interface Props {
  sessionId: string;
  permissionProfile?: string;
}

const TERMINAL_STATUSES = new Set(['completed', 'exited', 'failed', 'deleted', 'archived', 'killed']);

// Bottom-of-pane composer for resume/interrupt. Two modes:
//   - Running + headless: "Interrupt" — kills the current session and resumes
//     with the new prompt. Interactive/yolo TTY sessions are skipped (the
//     terminal accepts live input directly).
//   - Terminated (any profile): "Resume with prompt" — restarts the session
//     with full context plus the new prompt appended.
//
// All input UI (textarea, paste, screenshot, DOM picker, console, mic, attach
// chips, expand menu) is delegated to <UnifiedComposer>. This wrapper owns
// the mode-toggle logic, screenshot upload, extras serialization, and the
// resumeSession dispatch.
export function InterruptBar({ sessionId, permissionProfile }: Props) {
  const [error, setError] = useState<string | null>(null);

  const sess = allSessions.value.find((s: any) => s.id === sessionId);
  const profile = permissionProfile || sess?.permissionProfile;
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

  if (!mode) return null;

  const placeholder = mode === 'interrupt' ? 'Interrupt with new prompt…' : 'Resume with new prompt…';
  const submitTitle = mode === 'interrupt'
    ? 'Kill the current session and restart with this additional prompt (Enter to send, Shift+Enter for newline)'
    : 'Resume this session with full context plus the new prompt appended (Enter to send, Shift+Enter for newline)';

  async function handleSubmit(data: UnifiedComposerData) {
    setError(null);
    const { text, images, imageNames, elements, consoleEntries, voice } = data;
    const extras: string[] = [];

    // Pull voice screenshot blobs into the same upload batch as regular images
    // so the agent gets a single list of URLs.
    const allImageBlobs: Blob[] = [...images];
    const voiceShotIndexStart = allImageBlobs.length;
    if (voice && voice.screenshots.length > 0) {
      for (const s of voice.screenshots) allImageBlobs.push(s.blob);
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
    void imageNames; // names retained for parity but the upload uses fixed attach-N filenames

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

    if (consoleEntries && consoleEntries.length > 0) {
      const body = formatConsoleEntries(consoleEntries).slice(-4000);
      extras.push(`Recent browser console output:\n\`\`\`\n${body}\n\`\`\``);
    }

    if (voice) {
      const transcriptText = voice.transcript
        .filter((t) => t.isFinal)
        .map((t) => t.text.trim())
        .filter(Boolean)
        .join(' ');
      const parts: string[] = [];
      parts.push(`Voice capture (${Math.round(voice.duration / 1000)}s, ${voice.transcript.filter((t) => t.isFinal).length} final segments, ${voice.interactions.length} interactions, ${voice.screenshots.length} screenshots):`);
      if (transcriptText) parts.push(`Transcript: "${transcriptText}"`);
      if (voice.interactions.length > 0) {
        const ixLines = voice.interactions.slice(0, 30).map((ev, i) => {
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
      if (voice.consoleLogs.length > 0) {
        const body = voice.consoleLogs.slice(-30).map((e) => {
          const t = (e.timestamp / 1000).toFixed(1);
          return `  [${t}s] ${e.level}: ${e.args.join(' ').slice(0, 200)}`;
        }).join('\n');
        parts.push(`Console during capture:\n${body}`);
      }
      extras.push(parts.join('\n'));
    }

    const enriched = extras.length > 0
      ? `${text}${text ? '\n\n' : ''}---\n${extras.join('\n\n')}`
      : text;

    try {
      const newId = await resumeSession(sessionId, { additionalPrompt: enriched });
      if (!newId) {
        const real = lastResumeError.value;
        const fallback = mode === 'interrupt' ? 'Restart failed' : 'Resume failed';
        const realMsg = real && real.sessionId === sessionId ? real.message : null;
        throw new Error(realMsg ? `${fallback}: ${realMsg}` : fallback);
      }
    } catch (err: any) {
      // Surface to the inline error banner. Re-throw so UnifiedComposer keeps
      // the textarea contents (only success path resets) — the user can fix
      // the issue and retry without retyping.
      const msg = err?.message || String(err);
      setError(msg);
      throw err;
    }
  }

  return (
    <UnifiedComposer
      className={`interrupt-bar interrupt-bar--${mode}`}
      placeholder={placeholder}
      submitTitle={submitTitle}
      submitIcon={mode === 'interrupt' ? 'interrupt' : 'send'}
      submitAriaLabel={mode === 'interrupt' ? 'Interrupt' : 'Resume'}
      draftKey={`interrupt:${sessionId}`}
      error={error}
      onSubmit={handleSubmit}
    />
  );
}
