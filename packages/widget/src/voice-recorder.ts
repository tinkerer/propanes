import { captureScreenshot, stopScreencastStream, cropBlob } from './screenshot.js';

export interface TranscriptSegment {
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export interface InteractionEvent {
  id: string;
  type: 'click' | 'scroll' | 'input' | 'focus' | 'navigation' | 'hover';
  timestamp: number;
  target: {
    tagName: string;
    id: string;
    classes: string[];
    textContent: string;
    selector: string;
  };
  details?: Record<string, unknown>;
}

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  timestamp: number;
  args: string[];
}

export interface ScreenshotCapture {
  id: string;
  timestamp: number;
  blob: Blob;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export type TimelineItem =
  | { kind: 'speech'; segment: TranscriptSegment }
  | { kind: 'interaction'; event: InteractionEvent }
  | { kind: 'console'; entry: ConsoleEntry }
  | { kind: 'hover'; event: InteractionEvent }
  | { kind: 'screenshot'; capture: ScreenshotCapture };

export interface VoiceRecordingResult {
  audioBlob: Blob;
  duration: number;
  transcript: TranscriptSegment[];
  interactions: InteractionEvent[];
  consoleLogs: ConsoleEntry[];
  screenshots: ScreenshotCapture[];
}

type SpeechRecognitionType = typeof window extends { SpeechRecognition: infer T } ? T : any;

function getTargetInfo(el: Element): InteractionEvent['target'] {
  const segments: string[] = [];
  let current: Element | null = el;
  for (let depth = 0; current && depth < 3; depth++) {
    let seg = current.tagName.toLowerCase();
    if (current.id) {
      segments.unshift(`#${current.id}`);
      break;
    }
    const classes = Array.from(current.classList).filter(c => !c.startsWith('pw-')).slice(0, 2);
    if (classes.length) seg += '.' + classes.join('.');
    segments.unshift(seg);
    current = current.parentElement;
  }
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id,
    classes: Array.from(el.classList).slice(0, 5),
    textContent: (el.textContent || '').trim().slice(0, 100),
    selector: segments.join(' > '),
  };
}

const MAX_CONSOLE_ENTRIES = 200;
const MAX_SCREENSHOTS = 10;

export interface AmbientWindow {
  /** 0-based index of this window within the listen-mode session. */
  windowIndex: number;
  /** ISO timestamp when this window started. */
  startedAt: string;
  /** ISO timestamp when this window ended. */
  endedAt: string;
  /** Final transcript text for the window, concatenated. */
  text: string;
}

export interface AmbientChunkOpts {
  /** Window duration in ms (default 30000). */
  windowMs?: number;
  /** Silence gap in ms before auto-chunking (default 10000). */
  silenceMs?: number;
  /** Max text length before auto-chunking (default 500 chars). */
  maxLength?: number;
}

/**
 * Throws a descriptive error with a `.code` property when the browser cannot
 * run getUserMedia — either because we're in an insecure context (HTTP on a
 * non-localhost origin, which iOS Safari and modern Chrome/Safari refuse) or
 * because the Media Devices API is missing entirely.
 */
function preflightMic(): void {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    const err = new Error('Microphone requires HTTPS (or localhost)');
    (err as any).code = 'INSECURE_CONTEXT';
    throw err;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('Microphone API not available in this browser');
    (err as any).code = 'NOT_SUPPORTED';
    throw err;
  }
}

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private recognition: any = null;
  private audioChunks: Blob[] = [];
  private t0 = 0;
  private _recording = false;
  private _ambient = false;
  private ambientStream: MediaStream | null = null;
  private ambientRecognition: any = null;
  private ambientWindowMs = 30_000;
  private ambientSilenceMs = 10_000;
  private ambientMaxLength = 500;
  private ambientWindowIndex = 0;
  private ambientWindowStart = 0;
  private ambientWindowBuffer: string[] = [];
  private ambientFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private ambientSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private ambientLastSpeechAt = 0;
  private micBridgeWindow: Window | null = null;
  private micBridgeListener: ((e: MessageEvent) => void) | null = null;
  private micBridgeCloseWatcher: ReturnType<typeof setInterval> | null = null;
  private _transcript: TranscriptSegment[] = [];
  private _interactions: InteractionEvent[] = [];
  private _consoleLogs: ConsoleEntry[] = [];
  private _screenshots: ScreenshotCapture[] = [];
  private cleanupFns: (() => void)[] = [];
  private gestureCleanupFn: (() => void) | null = null;
  private originalConsole: Record<string, Function> = {};
  private interactionCounter = 0;
  private screenshotCounter = 0;

  onTranscript: ((segment: TranscriptSegment) => void) | null = null;
  onInteraction: ((event: InteractionEvent) => void) | null = null;
  onConsole: ((entry: ConsoleEntry) => void) | null = null;
  onHover: ((event: InteractionEvent) => void) | null = null;
  onScreenshotCapture: ((capture: ScreenshotCapture) => void) | null = null;
  /** Fires when a rolling ambient window closes with captured transcript text. */
  onAmbientWindow: ((win: AmbientWindow) => void) | null = null;
  /** Fires when an interim ambient transcript segment arrives. */
  onAmbientSegment: ((seg: TranscriptSegment) => void) | null = null;

  get recording(): boolean {
    return this._recording;
  }

  get ambient(): boolean {
    return this._ambient;
  }

  /** Last time the ambient recognizer heard anything (Date.now() ms). */
  get ambientLastSpeech(): number {
    return this.ambientLastSpeechAt;
  }

  async start(opts?: { screenCaptures?: boolean }): Promise<void> {
    if (this._recording) return;

    preflightMic();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.t0 = Date.now();
    this._recording = true;
    this.audioChunks = [];
    this._transcript = [];
    this._interactions = [];
    this._consoleLogs = [];
    this._screenshots = [];
    this.interactionCounter = 0;
    this.screenshotCounter = 0;

    // MediaRecorder
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    this.mediaRecorder = new MediaRecorder(stream, { mimeType });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.mediaRecorder.start(1000);

    // SpeechRecognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = document.documentElement.lang || 'en-US';

      this.recognition.onresult = (event: any) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const segment: TranscriptSegment = {
            text: result[0].transcript,
            timestamp: Date.now() - this.t0,
            isFinal: result.isFinal,
          };
          if (result.isFinal) {
            this._transcript.push(segment);
          }
          this.onTranscript?.(segment);
        }
      };

      this.recognition.onend = () => {
        if (this._recording) {
          try { this.recognition.start(); } catch {}
        }
      };

      this.recognition.onerror = (e: any) => {
        if (e.error !== 'no-speech' && e.error !== 'aborted' && this._recording) {
          try { this.recognition.start(); } catch {}
        }
      };

      try { this.recognition.start(); } catch {}
    }

    // DOM event listeners
    this.installDomListeners();

    // Console capture
    this.installConsoleCapture();

    // Gesture detection for area screenshots
    if (opts?.screenCaptures) {
      this.installGestureDetection();
    }

    // Cleanup stream on stop
    this.cleanupFns.push(() => {
      stream.getTracks().forEach(t => t.stop());
    });
  }

  async stop(): Promise<VoiceRecordingResult> {
    this._recording = false;
    const duration = Date.now() - this.t0;

    // Stop recognition
    if (this.recognition) {
      try { this.recognition.stop(); } catch {}
      this.recognition = null;
    }

    // Stop recorder and collect blob
    const audioBlob = await new Promise<Blob>((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(new Blob(this.audioChunks, { type: 'audio/webm' }));
        return;
      }
      this.mediaRecorder.onstop = () => {
        resolve(new Blob(this.audioChunks, { type: 'audio/webm' }));
      };
      this.mediaRecorder.stop();
    });

    // Cleanup
    this.disableScreenCaptures();
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    this.mediaRecorder = null;

    return {
      audioBlob,
      duration,
      transcript: this._transcript,
      interactions: this._interactions,
      consoleLogs: this._consoleLogs,
      screenshots: this._screenshots,
    };
  }

  /**
   * Start ambient listen mode. A lightweight SpeechRecognition loop runs
   * continuously; finalized transcript fragments are buffered into rolling
   * windows (default 30s). When a window closes with any text, onAmbientWindow
   * fires with the window's text so callers can POST it to the server.
   *
   * No audio is uploaded from ambient mode — only transcript text.
   */
  async startAmbient(opts?: AmbientChunkOpts): Promise<void> {
    if (this._ambient) return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('SpeechRecognition API not available in this browser');
    }

    preflightMic();
    this.ambientStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._ambient = true;
    this.ambientWindowMs = opts?.windowMs ?? 30_000;
    this.ambientSilenceMs = opts?.silenceMs ?? 10_000;
    this.ambientMaxLength = opts?.maxLength ?? 500;
    this.ambientWindowIndex = 0;
    this.ambientWindowStart = Date.now();
    this.ambientWindowBuffer = [];
    this.ambientLastSpeechAt = Date.now();

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = document.documentElement.lang || 'en-US';

    rec.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const segment: TranscriptSegment = {
          text: result[0].transcript,
          timestamp: Date.now() - this.ambientWindowStart,
          isFinal: result.isFinal,
        };
        this.ambientLastSpeechAt = Date.now();
        if (result.isFinal) {
          this.ambientWindowBuffer.push(segment.text);
          this.resetSilenceTimer();
          // Auto-chunk if text exceeds max length
          const currentLength = this.ambientWindowBuffer.join(' ').length;
          if (currentLength >= this.ambientMaxLength) {
            this.flushAmbientWindow();
          }
        }
        this.onAmbientSegment?.(segment);
      }
    };

    rec.onend = () => {
      if (this._ambient) {
        try { rec.start(); } catch {}
      }
    };

    rec.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted' && this._ambient) {
        try { rec.start(); } catch {}
      }
    };

    this.ambientRecognition = rec;
    try { rec.start(); } catch {}

    // Max window timer as a hard ceiling
    const tick = () => {
      if (!this._ambient) return;
      this.flushAmbientWindow();
      this.ambientFlushTimer = setTimeout(tick, this.ambientWindowMs);
    };
    this.ambientFlushTimer = setTimeout(tick, this.ambientWindowMs);
  }

  /** Reset the silence-gap timer — called after each finalized segment. */
  private resetSilenceTimer() {
    if (this.ambientSilenceTimer) clearTimeout(this.ambientSilenceTimer);
    if (!this._ambient || this.ambientWindowBuffer.length === 0) return;
    this.ambientSilenceTimer = setTimeout(() => {
      if (this._ambient && this.ambientWindowBuffer.length > 0) {
        this.flushAmbientWindow();
      }
    }, this.ambientSilenceMs);
  }

  /** Manually flush the current ambient buffer — callable from widget UI. */
  manualFlush(): void {
    if (this._ambient) this.flushAmbientWindow();
  }

  /** Close the current rolling window and start a new one. Safe to call repeatedly. */
  private flushAmbientWindow() {
    if (this.ambientSilenceTimer) {
      clearTimeout(this.ambientSilenceTimer);
      this.ambientSilenceTimer = null;
    }
    const now = Date.now();
    const endedAtMs = now;
    const text = this.ambientWindowBuffer.join(' ').trim();
    const windowIndex = this.ambientWindowIndex++;
    if (text.length > 0) {
      const win: AmbientWindow = {
        windowIndex,
        startedAt: new Date(this.ambientWindowStart).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        text,
      };
      try { this.onAmbientWindow?.(win); } catch {}
    }
    this.ambientWindowBuffer = [];
    this.ambientWindowStart = now;
    // Reset the hard-ceiling timer on flush so it doesn't double-fire
    if (this.ambientFlushTimer) {
      clearTimeout(this.ambientFlushTimer);
      if (this._ambient) {
        this.ambientFlushTimer = setTimeout(() => {
          if (this._ambient) this.flushAmbientWindow();
        }, this.ambientWindowMs);
      }
    }
  }

  async stopAmbient(): Promise<void> {
    if (!this._ambient) return;
    this._ambient = false;
    if (this.ambientFlushTimer) {
      clearTimeout(this.ambientFlushTimer);
      this.ambientFlushTimer = null;
    }
    if (this.ambientSilenceTimer) {
      clearTimeout(this.ambientSilenceTimer);
      this.ambientSilenceTimer = null;
    }
    // Flush any remaining buffered speech.
    this.flushAmbientWindow();
    if (this.ambientRecognition) {
      try { this.ambientRecognition.stop(); } catch {}
      this.ambientRecognition = null;
    }
    if (this.ambientStream) {
      this.ambientStream.getTracks().forEach((t) => t.stop());
      this.ambientStream = null;
    }
  }

  /**
   * Open the mic-bridge popup window. Returns the opened window or throws if
   * the browser blocked the popup. The popup runs on localhost (a secure
   * context) so getUserMedia + SpeechRecognition work even when the opener is
   * on an insecure HTTP origin.
   */
  private openMicBridgeWindow(bridgeUrl: string): Window {
    const features = 'popup=yes,width=380,height=420,left=40,top=40';
    const win = window.open(bridgeUrl, 'pw-mic-bridge', features);
    if (!win) {
      const err = new Error('Mic bridge popup was blocked — allow popups for this site');
      (err as any).code = 'POPUP_BLOCKED';
      throw err;
    }
    this.micBridgeWindow = win;
    this.micBridgeCloseWatcher = setInterval(() => {
      if (this.micBridgeWindow?.closed) this.cleanupMicBridge();
    }, 500);
    return win;
  }

  /**
   * Mirror a log line from the bridge popup into the parent window's console.
   * Keeps a `[mic-bridge]` prefix so the source is obvious when reading the
   * unified output.
   */
  private handleBridgeLog(level: string, ts: string, message: string) {
    const fn = (console as any)[level] || console.log;
    try { fn.call(console, '[mic-bridge ' + ts + ']', message); }
    catch { console.log('[mic-bridge ' + ts + '] ' + message); }
  }

  /**
   * Start ambient listen mode via a popup window on localhost. Used when the
   * host page is on an insecure (HTTP) origin where getUserMedia /
   * SpeechRecognition are blocked. The popup loads from the PropPanes server
   * on localhost (secure context), runs the mic + recognition there, and
   * relays results back via postMessage to its opener.
   */
  async startAmbientViaIframe(bridgeUrl: string, opts?: AmbientChunkOpts): Promise<void> {
    if (this._ambient) return;

    this._ambient = true;
    this.ambientWindowIndex = 0;
    this.ambientLastSpeechAt = Date.now();

    let popup: Window;
    try {
      popup = this.openMicBridgeWindow(bridgeUrl);
    } catch (err) {
      this._ambient = false;
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.cleanupMicBridge();
          reject(new Error('Mic bridge popup timed out'));
        }
      }, 15_000);

      const listener = (e: MessageEvent) => {
        const d = e.data;
        if (!d || d.source !== 'pw-mic-bridge') return;

        if (d.type === 'log') {
          this.handleBridgeLog(d.level, d.ts, d.message);
          return;
        }
        if (d.type === 'ready' && !resolved) {
          popup.postMessage({
            source: 'pw-mic-bridge-cmd',
            type: 'start',
            opts: {
              windowMs: opts?.windowMs ?? 30_000,
              silenceMs: opts?.silenceMs ?? 10_000,
              maxLength: opts?.maxLength ?? 500,
              lang: document.documentElement.lang || 'en-US',
            },
          }, '*');
        } else if (d.type === 'started' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        } else if (d.type === 'error' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          // Leave the popup open with the error visible so the user can
          // inspect logs / copy them. The popup stays alive until manually
          // closed; the close watcher will null the ref then.
          this.cleanupMicBridge({ keepWindow: true });
          const err = new Error(d.message || 'Mic bridge error');
          (err as any).code = d.code;
          reject(err);
        } else if (d.type === 'segment') {
          this.ambientLastSpeechAt = Date.now();
          this.onAmbientSegment?.(d.segment);
        } else if (d.type === 'ambientWindow') {
          const win: AmbientWindow = {
            windowIndex: d.windowIndex,
            startedAt: d.startedAt,
            endedAt: d.endedAt,
            text: d.text,
          };
          try { this.onAmbientWindow?.(win); } catch {}
        }
      };

      window.addEventListener('message', listener);
      this.micBridgeListener = listener;
    });
  }

  async stopAmbientViaIframe(): Promise<void> {
    if (!this._ambient) return;
    this._ambient = false;

    if (this.micBridgeWindow && !this.micBridgeWindow.closed) {
      this.micBridgeWindow.postMessage({
        source: 'pw-mic-bridge-cmd',
        type: 'stop',
      }, '*');
      await new Promise(r => setTimeout(r, 200));
    }
    this.cleanupMicBridge();
  }

  /**
   * Start one-shot recording via the popup bridge — used by the regular mic
   * button on insecure (HTTP) origins. Audio blob capture is skipped (the mic
   * stream lives in the popup), but transcript + DOM interactions + console
   * capture still work in the parent.
   */
  async startViaIframe(bridgeUrl: string, _opts?: { screenCaptures?: boolean }): Promise<void> {
    if (this._recording) return;

    this.t0 = Date.now();
    this._recording = true;
    this.audioChunks = [];
    this._transcript = [];
    this._interactions = [];
    this._consoleLogs = [];
    this._screenshots = [];
    this.interactionCounter = 0;
    this.screenshotCounter = 0;

    this.installDomListeners();
    this.installConsoleCapture();
    // getDisplayMedia also requires a secure context, so screen captures are
    // unavailable in this mode.

    let popup: Window;
    try {
      popup = this.openMicBridgeWindow(bridgeUrl);
    } catch (err) {
      this._recording = false;
      for (const fn of this.cleanupFns) fn();
      this.cleanupFns = [];
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.cleanupMicBridge();
          this._recording = false;
          for (const fn of this.cleanupFns) fn();
          this.cleanupFns = [];
          reject(new Error('Mic bridge popup timed out'));
        }
      }, 15_000);

      const listener = (e: MessageEvent) => {
        const d = e.data;
        if (!d || d.source !== 'pw-mic-bridge') return;

        if (d.type === 'log') {
          this.handleBridgeLog(d.level, d.ts, d.message);
          return;
        }
        if (d.type === 'ready' && !resolved) {
          popup.postMessage({
            source: 'pw-mic-bridge-cmd',
            type: 'start',
            opts: {
              // Long window — we never flush during a one-shot recording.
              windowMs: 24 * 60 * 60 * 1000,
              silenceMs: 24 * 60 * 60 * 1000,
              maxLength: Number.MAX_SAFE_INTEGER,
              lang: document.documentElement.lang || 'en-US',
            },
          }, '*');
        } else if (d.type === 'started' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        } else if (d.type === 'error' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          // Leave the popup open with the error visible so the user can
          // inspect logs / copy them.
          this.cleanupMicBridge({ keepWindow: true });
          this._recording = false;
          for (const fn of this.cleanupFns) fn();
          this.cleanupFns = [];
          const err = new Error(d.message || 'Mic bridge error');
          (err as any).code = d.code;
          reject(err);
        } else if (d.type === 'segment') {
          const seg: TranscriptSegment = {
            text: d.segment.text,
            timestamp: Date.now() - this.t0,
            isFinal: d.segment.isFinal,
          };
          if (seg.isFinal) this._transcript.push(seg);
          this.onTranscript?.(seg);
        }
      };

      window.addEventListener('message', listener);
      this.micBridgeListener = listener;
    });
  }

  /** Stop a recording started with startViaIframe; returns the same result shape as stop(). */
  async stopViaIframe(): Promise<VoiceRecordingResult> {
    if (!this._recording) {
      return {
        audioBlob: new Blob([], { type: 'audio/webm' }),
        duration: 0,
        transcript: [],
        interactions: [],
        consoleLogs: [],
        screenshots: [],
      };
    }
    this._recording = false;
    const duration = Date.now() - this.t0;

    if (this.micBridgeWindow && !this.micBridgeWindow.closed) {
      this.micBridgeWindow.postMessage({
        source: 'pw-mic-bridge-cmd',
        type: 'stop',
      }, '*');
      await new Promise(r => setTimeout(r, 200));
    }
    this.cleanupMicBridge();

    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];

    return {
      audioBlob: new Blob([], { type: 'audio/webm' }),
      duration,
      transcript: this._transcript,
      interactions: this._interactions,
      consoleLogs: this._consoleLogs,
      screenshots: this._screenshots,
    };
  }

  /** Manually flush the bridge's current buffer. */
  manualFlushViaIframe(): void {
    if (this._ambient && this.micBridgeWindow && !this.micBridgeWindow.closed) {
      this.micBridgeWindow.postMessage({
        source: 'pw-mic-bridge-cmd',
        type: 'flush',
      }, '*');
    }
  }

  /** Whether we're running in popup-bridge mode. */
  get usingMicBridge(): boolean {
    return this.micBridgeWindow !== null;
  }

  private cleanupMicBridge(opts?: { keepWindow?: boolean }) {
    const keepWindow = !!opts?.keepWindow;
    if (this.micBridgeCloseWatcher) {
      clearInterval(this.micBridgeCloseWatcher);
      this.micBridgeCloseWatcher = null;
    }
    if (this.micBridgeWindow && !keepWindow) {
      if (this.micBridgeListener) {
        window.removeEventListener('message', this.micBridgeListener);
        this.micBridgeListener = null;
      }
      try { if (!this.micBridgeWindow.closed) this.micBridgeWindow.close(); } catch {}
      this.micBridgeWindow = null;
    } else if (this.micBridgeWindow && keepWindow) {
      // Leave popup + message listener alive so trailing logs from the bridge
      // continue to surface in the parent console while the user reads the
      // error. Re-arm a close watcher that *only* nulls the ref when the user
      // closes the popup manually — no further state cleanup needed.
      const watch = setInterval(() => {
        if (!this.micBridgeWindow || this.micBridgeWindow.closed) {
          clearInterval(watch);
          if (this.micBridgeListener) {
            window.removeEventListener('message', this.micBridgeListener);
            this.micBridgeListener = null;
          }
          this.micBridgeWindow = null;
        }
      }, 500);
      this.micBridgeCloseWatcher = watch;
    }
    // If the user closed the popup mid-recording, also tear down DOM listeners.
    if (this._recording) {
      this._recording = false;
      for (const fn of this.cleanupFns) fn();
      this.cleanupFns = [];
    }
    this._ambient = false;
  }

  removeInteraction(id: string) {
    const idx = this._interactions.findIndex(e => e.id === id);
    if (idx >= 0) this._interactions.splice(idx, 1);
  }

  removeScreenshot(id: string) {
    const idx = this._screenshots.findIndex(s => s.id === id);
    if (idx >= 0) this._screenshots.splice(idx, 1);
  }

  enableScreenCaptures() {
    if (!this._recording || this.gestureCleanupFn) return;
    this.installGestureDetection();
  }

  disableScreenCaptures() {
    if (this.gestureCleanupFn) {
      this.gestureCleanupFn();
      this.gestureCleanupFn = null;
    }
  }

  private installDomListeners() {
    const addInteraction = (type: InteractionEvent['type'], el: Element, details?: Record<string, unknown>) => {
      if (el.closest('propanes-host')) return;
      const event: InteractionEvent = {
        id: `int-${this.interactionCounter++}`,
        type,
        timestamp: Date.now() - this.t0,
        target: getTargetInfo(el),
        details,
      };
      if (type === 'hover') {
        this._interactions.push(event);
        this.onHover?.(event);
        return;
      }
      this._interactions.push(event);
      this.onInteraction?.(event);
    };

    const onClick = (e: MouseEvent) => {
      const el = e.target as Element;
      if (el) addInteraction('click', el);
    };

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        addInteraction('scroll', document.scrollingElement || document.body, {
          scrollY: window.scrollY,
          scrollX: window.scrollX,
        });
      }, 300);
    };

    const onInput = (e: Event) => {
      const el = e.target as Element;
      if (el) addInteraction('input', el);
    };

    const onFocusin = (e: FocusEvent) => {
      const el = e.target as Element;
      if (el) addInteraction('focus', el);
    };

    const onPopstate = () => {
      addInteraction('navigation', document.body, { url: location.href });
    };

    // Throttled hover — only emit when hovered element changes
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHoverSelector = '';
    const onMousemove = (e: MouseEvent) => {
      if (hoverTimer) return;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && !el.closest('propanes-host')) {
          const info = getTargetInfo(el);
          if (info.selector !== lastHoverSelector) {
            lastHoverSelector = info.selector;
            addInteraction('hover', el);
          }
        }
      }, 300);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusin, true);
    window.addEventListener('popstate', onPopstate);
    document.addEventListener('mousemove', onMousemove, { passive: true });

    const origPushState = history.pushState;
    history.pushState = function (...args) {
      origPushState.apply(this, args);
      addInteraction('navigation', document.body, { url: location.href });
    };

    this.cleanupFns.push(() => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('focusin', onFocusin, true);
      window.removeEventListener('popstate', onPopstate);
      document.removeEventListener('mousemove', onMousemove);
      history.pushState = origPushState;
      if (hoverTimer) clearTimeout(hoverTimer);
    });
  }

  private installConsoleCapture() {
    const levels = ['log', 'warn', 'error', 'info', 'debug'] as const;
    for (const level of levels) {
      this.originalConsole[level] = console[level];
      console[level] = (...args: any[]) => {
        this.originalConsole[level].apply(console, args);
        if (this._consoleLogs.length < MAX_CONSOLE_ENTRIES) {
          const entry: ConsoleEntry = {
            level,
            timestamp: Date.now() - this.t0,
            args: args.map(a => {
              try { return typeof a === 'string' ? a : JSON.stringify(a); }
              catch { return String(a); }
            }),
          };
          this._consoleLogs.push(entry);
          this.onConsole?.(entry);
        }
      };
    }

    this.cleanupFns.push(() => {
      for (const level of levels) {
        if (this.originalConsole[level]) {
          console[level] = this.originalConsole[level] as any;
        }
      }
      this.originalConsole = {};
    });
  }

  private installGestureDetection() {
    let pending = false;
    let tracking = false;
    let startX = 0;
    let startY = 0;
    let points: { x: number; y: number }[] = [];
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let gestureCompleted = false;
    const ACTIVATE_DIST = 30;

    const onMousedown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as Element)?.closest('propanes-host')) return;
      pending = true;
      tracking = false;
      gestureCompleted = false;
      startX = e.clientX;
      startY = e.clientY;
      points = [{ x: e.clientX, y: e.clientY }];
    };

    const activateCanvas = () => {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;';
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      document.body.appendChild(canvas);
      ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.strokeStyle = '#1d9bf0';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
      }
    };

    const onMousemove = (e: MouseEvent) => {
      if (!pending && !tracking) return;
      points.push({ x: e.clientX, y: e.clientY });

      if (pending && !tracking) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.sqrt(dx * dx + dy * dy) >= ACTIVATE_DIST) {
          pending = false;
          tracking = true;
          activateCanvas();
        }
        return;
      }

      if (tracking && ctx) {
        ctx.lineTo(e.clientX, e.clientY);
        ctx.stroke();
      }
    };

    const onMouseup = async (e: MouseEvent) => {
      if (!tracking && !pending) return;
      const wasTracking = tracking;
      pending = false;
      tracking = false;
      if (canvas) {
        canvas.remove();
        canvas = null;
      }
      ctx = null;

      if (!wasTracking || points.length < 5) return;

      const start = points[0];
      const end = points[points.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const closeDist = Math.sqrt(dx * dx + dy * dy);

      let totalDist = 0;
      for (let i = 1; i < points.length; i++) {
        const px = points[i].x - points[i - 1].x;
        const py = points[i].y - points[i - 1].y;
        totalDist += Math.sqrt(px * px + py * py);
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const bboxW = maxX - minX;
      const bboxH = maxY - minY;

      if (closeDist < 80 && totalDist > 300 && bboxW > 50 && bboxH > 50) {
        gestureCompleted = true;

        if (this._screenshots.length >= MAX_SCREENSHOTS) return;

        try {
          const fullBlob = await captureScreenshot({ excludeWidget: true, method: 'display-media', keepStream: true });
          if (!fullBlob) return;

          const rect = { x: Math.round(minX), y: Math.round(minY), width: Math.round(bboxW), height: Math.round(bboxH) };
          const cropped = await cropBlob(fullBlob, rect);
          if (!cropped) return;

          const capture: ScreenshotCapture = {
            id: `ss-${this.screenshotCounter++}`,
            timestamp: Date.now() - this.t0,
            blob: cropped,
            boundingBox: rect,
          };
          this._screenshots.push(capture);
          this.onScreenshotCapture?.(capture);
        } catch {}
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      if (gestureCompleted) {
        e.stopPropagation();
        e.preventDefault();
        gestureCompleted = false;
      }
    };

    document.addEventListener('mousedown', onMousedown, true);
    document.addEventListener('mousemove', onMousemove, true);
    document.addEventListener('mouseup', onMouseup, true);
    document.addEventListener('click', onClickCapture, true);

    this.gestureCleanupFn = () => {
      document.removeEventListener('mousedown', onMousedown, true);
      document.removeEventListener('mousemove', onMousemove, true);
      document.removeEventListener('mouseup', onMouseup, true);
      document.removeEventListener('click', onClickCapture, true);
      if (canvas) canvas.remove();
      stopScreencastStream();
    };
  }
}
