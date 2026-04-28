import { useEffect, useRef, useState } from 'preact/hooks';
import { VoiceRecorder } from '@propanes/widget/voice-recorder';
import { chiefOfStaffError } from './chief-of-staff.js';

const BRAINSTORM_PREF_KEY = 'pw-cos-mic-brainstorm';

function readBrainstormPref(): boolean {
  try { return localStorage.getItem(BRAINSTORM_PREF_KEY) === '1'; } catch { return false; }
}
function writeBrainstormPref(on: boolean): void {
  try { localStorage.setItem(BRAINSTORM_PREF_KEY, on ? '1' : '0'); } catch { /* quota */ }
}

/**
 * Mic recording state + lifecycle for the CoS bubble. Owns the VoiceRecorder
 * instance, the elapsed-seconds timer, the rolling interim transcript, the
 * pre-recording input snapshot (so final text appends instead of clobbering),
 * and the start/stop entrypoint that decides between native getUserMedia and
 * the cross-origin mic-bridge popup for insecure HTTP origins.
 *
 * Two modes:
 *   - One-shot (default): start → stop returns a blob + final transcript;
 *     transcript is appended once on stop.
 *   - Brainstorm: ambient listen mode mirroring the widget. Rolling 30s
 *     windows; each window's finalized text is appended to the input as it
 *     closes, so ideas accumulate while the operator keeps talking.
 *
 * The parent provides:
 *   - getInputBase: snapshot of the textarea value (read at start-of-session
 *     in one-shot mode, re-read on every ambient window in brainstorm mode).
 *   - onAppendInput: called with the new text value to write into the input.
 *   - focusInput: called after a successful append.
 */
export function useCosVoice(opts: {
  getInputBase: () => string;
  onAppendInput: (next: string) => void;
  focusInput: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [interim, setInterim] = useState('');
  const [brainstorm, setBrainstormState] = useState<boolean>(() => readBrainstormPref());
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  const inputBaseRef = useRef<string>('');
  const finalSegmentsRef = useRef<string[]>([]);
  // Locked at start-of-session so toggling the dropdown mid-record doesn't
  // confuse the stop path about which API to call.
  const sessionModeRef = useRef<'oneshot' | 'brainstorm'>('oneshot');

  function setBrainstorm(on: boolean) {
    setBrainstormState(on);
    writeBrainstormPref(on);
  }

  function appendToInput(addition: string) {
    const trimmed = addition.trim();
    if (!trimmed) return;
    const base = opts.getInputBase();
    const sep = base && !/\s$/.test(base) ? ' ' : '';
    opts.onAppendInput(base + sep + trimmed);
  }

  function computeMicBridgeUrl(): string {
    const originUrl = new URL(window.location.origin);
    originUrl.hostname = 'localhost';
    return `${originUrl.origin}/api/v1/local/mic-bridge`;
  }

  function micErrorMessage(err: unknown): string {
    const message = (err as any)?.message ? String((err as any).message) : '';
    const code = (err as any)?.code ? String((err as any).code) : '';
    const name = (err as any)?.name ? String((err as any).name) : '';
    if (code === 'INSECURE_CONTEXT') return 'Microphone requires HTTPS (or localhost)';
    if (code === 'POPUP_BLOCKED') return 'Mic bridge popup was blocked — allow popups for this site';
    if (code === 'NOT_FOUND' || name === 'NotFoundError') return 'No microphone found';
    if (name === 'NotAllowedError') return 'Microphone permission denied';
    return message || 'Could not start microphone';
  }

  async function toggleRecord() {
    if (recording) {
      const rec = voiceRecorderRef.current;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecording(false);
      setInterim('');
      if (!rec) return;
      try {
        const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
        if (sessionModeRef.current === 'brainstorm') {
          // Brainstorm windows have already been streamed into the input. Stop
          // ambient cleanly; any trailing buffered window flushes during stop.
          if (insecure && rec.usingMicBridge) await rec.stopAmbientViaIframe();
          else await rec.stopAmbient();
          opts.focusInput();
          return;
        }
        const result = insecure && rec.usingMicBridge
          ? await rec.stopViaIframe()
          : await rec.stop();
        const finalText = result.transcript
          .filter((t: any) => t.isFinal)
          .map((t: any) => t.text.trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        if (finalText) {
          const base = inputBaseRef.current;
          const sep = base && !/\s$/.test(base) ? ' ' : '';
          opts.onAppendInput(base + sep + finalText);
          opts.focusInput();
        }
      } catch (err: any) {
        chiefOfStaffError.value = micErrorMessage(err);
      }
      return;
    }

    chiefOfStaffError.value = '';
    inputBaseRef.current = opts.getInputBase();
    finalSegmentsRef.current = [];
    sessionModeRef.current = brainstorm ? 'brainstorm' : 'oneshot';
    const rec = voiceRecorderRef.current ?? (voiceRecorderRef.current = new VoiceRecorder());

    if (sessionModeRef.current === 'brainstorm') {
      rec.onTranscript = null;
      rec.onAmbientSegment = (seg: any) => {
        if (!seg.isFinal) setInterim(seg.text);
        else setInterim('');
      };
      rec.onAmbientWindow = (win: any) => {
        if (win?.text) appendToInput(win.text);
      };
      try {
        const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
        const ambientOpts = { windowMs: 30_000, silenceMs: 10_000, maxLength: 500 };
        if (insecure) await rec.startAmbientViaIframe(computeMicBridgeUrl(), ambientOpts);
        else await rec.startAmbient(ambientOpts);
        startRef.current = Date.now();
        setElapsed(0);
        setRecording(true);
        timerRef.current = setInterval(() => {
          setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
        }, 500);
      } catch (err: any) {
        chiefOfStaffError.value = micErrorMessage(err);
      }
      return;
    }

    rec.onAmbientSegment = null;
    rec.onAmbientWindow = null;
    rec.onTranscript = (seg: any) => {
      if (seg.isFinal) {
        finalSegmentsRef.current.push(seg.text.trim());
        setInterim('');
      } else {
        setInterim(seg.text);
      }
    };
    try {
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
      if (insecure) {
        await rec.startViaIframe(computeMicBridgeUrl());
      } else {
        await rec.start();
      }
      startRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 500);
    } catch (err: any) {
      chiefOfStaffError.value = micErrorMessage(err);
    }
  }

  // Clean up on unmount: kill timer and stop any in-flight recording so we
  // don't leak a hot mic when the bubble unmounts mid-record.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const rec = voiceRecorderRef.current;
      if (!rec) return;
      const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
      if (rec.ambient) {
        if (insecure && rec.usingMicBridge) void rec.stopAmbientViaIframe().catch(() => {});
        else void rec.stopAmbient().catch(() => {});
      } else if (rec.recording) {
        if (insecure && rec.usingMicBridge) void rec.stopViaIframe().catch(() => {});
        else void rec.stop().catch(() => {});
      }
    };
  }, []);

  return { recording, elapsed, interim, toggleRecord, brainstorm, setBrainstorm };
}
