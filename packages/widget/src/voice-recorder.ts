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

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private recognition: any = null;
  private audioChunks: Blob[] = [];
  private t0 = 0;
  private _recording = false;
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

  get recording(): boolean {
    return this._recording;
  }

  async start(opts?: { screenCaptures?: boolean }): Promise<void> {
    if (this._recording) return;

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
      if (el.closest('prompt-widget-host')) return;
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
        if (el && !el.closest('prompt-widget-host')) {
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
      if ((e.target as Element)?.closest('prompt-widget-host')) return;
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
        ctx.strokeStyle = '#6366f1';
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
