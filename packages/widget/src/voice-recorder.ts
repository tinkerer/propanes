export interface TranscriptSegment {
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export interface InteractionEvent {
  type: 'click' | 'scroll' | 'input' | 'focus' | 'navigation';
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

export interface VoiceRecordingResult {
  audioBlob: Blob;
  duration: number;
  transcript: TranscriptSegment[];
  interactions: InteractionEvent[];
  consoleLogs: ConsoleEntry[];
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

export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private recognition: any = null;
  private audioChunks: Blob[] = [];
  private t0 = 0;
  private _recording = false;
  private _transcript: TranscriptSegment[] = [];
  private _interactions: InteractionEvent[] = [];
  private _consoleLogs: ConsoleEntry[] = [];
  private cleanupFns: (() => void)[] = [];
  private originalConsole: Record<string, Function> = {};

  onTranscript: ((segment: TranscriptSegment) => void) | null = null;
  onInteraction: ((event: InteractionEvent) => void) | null = null;

  get recording(): boolean {
    return this._recording;
  }

  async start(): Promise<void> {
    if (this._recording) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.t0 = Date.now();
    this._recording = true;
    this.audioChunks = [];
    this._transcript = [];
    this._interactions = [];
    this._consoleLogs = [];

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
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    this.mediaRecorder = null;

    return {
      audioBlob,
      duration,
      transcript: this._transcript,
      interactions: this._interactions,
      consoleLogs: this._consoleLogs,
    };
  }

  private installDomListeners() {
    const addInteraction = (type: InteractionEvent['type'], el: Element, details?: Record<string, unknown>) => {
      if (el.closest('prompt-widget-host')) return;
      const event: InteractionEvent = {
        type,
        timestamp: Date.now() - this.t0,
        target: getTargetInfo(el),
        details,
      };
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

    document.addEventListener('click', onClick, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusin, true);
    window.addEventListener('popstate', onPopstate);

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
      history.pushState = origPushState;
    });
  }

  private installConsoleCapture() {
    const levels = ['log', 'warn', 'error', 'info', 'debug'] as const;
    for (const level of levels) {
      this.originalConsole[level] = console[level];
      console[level] = (...args: any[]) => {
        this.originalConsole[level].apply(console, args);
        if (this._consoleLogs.length < MAX_CONSOLE_ENTRIES) {
          this._consoleLogs.push({
            level,
            timestamp: Date.now() - this.t0,
            args: args.map(a => {
              try { return typeof a === 'string' ? a : JSON.stringify(a); }
              catch { return String(a); }
            }),
          });
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
}
