import { useEffect, useRef, useState } from 'preact/hooks';
import { VoiceRecorder } from '@propanes/widget/voice-recorder';
import { chiefOfStaffError } from './chief-of-staff.js';

/**
 * Mic recording state + lifecycle for the CoS bubble. Owns the VoiceRecorder
 * instance, the elapsed-seconds timer, the rolling interim transcript, the
 * pre-recording input snapshot (so final text appends instead of clobbering),
 * and the start/stop entrypoint that decides between native getUserMedia and
 * the cross-origin mic-bridge popup for insecure HTTP origins.
 *
 * The parent provides:
 *   - getInputBase: snapshot of the textarea value at start-of-recording.
 *     The hook concatenates final transcript onto this base on stop.
 *   - onAppendInput: called once on stop with `${base}${sep}${finalText}`.
 *   - focusInput: called after a successful append so the operator can keep
 *     typing without manually refocusing.
 */
export function useCosVoice(opts: {
  getInputBase: () => string;
  onAppendInput: (next: string) => void;
  focusInput: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [interim, setInterim] = useState('');
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);
  const inputBaseRef = useRef<string>('');
  const finalSegmentsRef = useRef<string[]>([]);

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
    const rec = voiceRecorderRef.current ?? (voiceRecorderRef.current = new VoiceRecorder());
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
      if (rec?.recording) {
        const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
        if (insecure && rec.usingMicBridge) void rec.stopViaIframe().catch(() => {});
        else void rec.stop().catch(() => {});
      }
    };
  }, []);

  return { recording, elapsed, interim, toggleRecord };
}
