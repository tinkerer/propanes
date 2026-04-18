import { toSvg } from 'html-to-image';

/* ── mouse position tracking for synthetic cursor ── */
let lastMouseX = -1;
let lastMouseY = -1;
let mouseTracking = false;

function ensureMouseTracking() {
  if (mouseTracking) return;
  mouseTracking = true;
  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, { passive: true });
}

// Start tracking immediately on import
ensureMouseTracking();

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><path fill="white" stroke="black" stroke-width="1.5" d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35Z"/></svg>`;

function createSyntheticCursor(): HTMLElement | null {
  if (lastMouseX < 0 || lastMouseY < 0) return null;
  const el = document.createElement('div');
  el.id = '__pw-synthetic-cursor';
  el.style.cssText = `position:fixed;left:${lastMouseX}px;top:${lastMouseY}px;width:20px;height:20px;z-index:2147483647;pointer-events:none;`;
  el.innerHTML = CURSOR_SVG;
  document.body.appendChild(el);
  return el;
}

/* ── persistent getDisplayMedia stream ── */
let persistentStream: MediaStream | null = null;
let persistentVideo: HTMLVideoElement | null = null;

const CHROME_INDICATOR_DELAY_SEC = 3;

function isStreamAlive(): boolean {
  if (!persistentStream) return false;
  const track = persistentStream.getVideoTracks()[0];
  return !!track && track.readyState === 'live';
}

function countdownDelay(seconds: number, onTick?: (remaining: number) => void): Promise<void> {
  return new Promise(resolve => {
    let remaining = seconds;
    onTick?.(remaining);
    const iv = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(iv);
        resolve();
      } else {
        onTick?.(remaining);
      }
    }, 1000);
  });
}

async function ensureStream(onStatus?: (msg: string) => void): Promise<{ stream: MediaStream; video: HTMLVideoElement }> {
  if (isStreamAlive() && persistentVideo) {
    return { stream: persistentStream!, video: persistentVideo };
  }

  persistentStream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    preferCurrentTab: true,
  } as any);

  persistentStream.getVideoTracks()[0].addEventListener('ended', () => {
    persistentStream = null;
    persistentVideo = null;
  });

  const video = document.createElement('video');
  video.srcObject = persistentStream;
  video.autoplay = true;
  await new Promise<void>(r => { video.onloadeddata = () => r(); });

  await countdownDelay(CHROME_INDICATOR_DELAY_SEC, n => onStatus?.(`${n}…`));
  persistentVideo = video;

  return { stream: persistentStream, video };
}

export type ScreenshotMethod = 'html-to-image' | 'display-media';

export interface CaptureOptions {
  excludeWidget?: boolean;
  excludeCursor?: boolean;
  keepStream?: boolean;
  onStatus?: (msg: string) => void;
  method?: ScreenshotMethod;
}

/* ── html-to-image capture ── */
async function captureHtmlToImage(opts?: CaptureOptions): Promise<Blob | null> {
  const host = opts?.excludeWidget ? document.querySelector('prompt-widget-host') as HTMLElement | null : null;
  if (host) host.style.display = 'none';

  const cursor = opts?.excludeCursor ? document.getElementById('__pw-virtual-cursor') : null;
  const prevCursorDisplay = cursor?.style.display;
  if (cursor) cursor.style.display = 'none';

  // Add synthetic OS cursor when user wants cursor included
  const syntheticCursor = !opts?.excludeCursor ? createSyntheticCursor() : null;

  // Compensate for scroll offsets — html-to-image resets scrollTop/scrollLeft to 0
  const restores: Array<() => void> = [];
  const scrollY = window.scrollY;
  if (scrollY > 0) {
    const prev = document.documentElement.style.transform;
    document.documentElement.style.transform = prev
      ? `${prev} translateY(-${scrollY}px)`
      : `translateY(-${scrollY}px)`;
    restores.push(() => { document.documentElement.style.transform = prev; });
  }
  document.body.querySelectorAll('*').forEach((el) => {
    if (el.scrollTop > 0 || el.scrollLeft > 0) {
      const htmlEl = el as HTMLElement;
      const prev = htmlEl.style.transform;
      const offset = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
      htmlEl.style.transform = prev ? `${prev} ${offset}` : offset;
      restores.push(() => { htmlEl.style.transform = prev; });
    }
  });

  const cleanup = () => {
    restores.forEach(fn => fn());
    if (host) host.style.display = '';
    if (cursor) cursor.style.display = prevCursorDisplay ?? '';
    syntheticCursor?.remove();
  };

  try {
    const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const w = window.innerWidth;
    const h = window.innerHeight;

    // html-to-image copies ALL computed CSS properties (hundreds per element) as
    // inline styles, producing SVG data URIs that exceed 100 MB on complex pages.
    // We monkey-patch getComputedStyle during capture to return only the visual
    // properties that matter for screenshot fidelity.
    const VISUAL_PROPS = [
      'background-color', 'background-image', 'background-position',
      'background-size', 'background-repeat',
      'border-radius',
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'box-shadow',
      'color', 'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'letter-spacing', 'text-align', 'text-decoration',
      'text-transform', 'text-overflow', 'white-space', 'word-break', 'overflow-wrap',
      'display', 'position', 'top', 'right', 'bottom', 'left',
      'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
      'align-items', 'justify-content', 'align-self', 'gap', 'order',
      'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
      'overflow-x', 'overflow-y',
      'opacity', 'visibility', 'z-index',
      'transform', 'transform-origin',
      'box-sizing', 'vertical-align',
    ];

    const origGCS = window.getComputedStyle;
    (window as any).getComputedStyle = function (elt: Element, pseudo?: string | null) {
      const real = origGCS.call(window, elt, pseudo);
      return new Proxy(real, {
        get(target: CSSStyleDeclaration, prop: string | symbol) {
          if (prop === 'cssText') {
            const parts: string[] = [];
            for (const p of VISUAL_PROPS) {
              const v = target.getPropertyValue(p);
              if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px'
                && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent' && v !== 'static'
                && v !== 'visible' && v !== 'baseline' && v !== 'content-box') {
                parts.push(`${p}:${v}`);
              }
            }
            return parts.join(';');
          }
          const val = (target as any)[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
    };

    const opts = {
      cacheBust: true,
      pixelRatio: 1,
      skipFonts: true,
      imagePlaceholder: TRANSPARENT_PIXEL,
      width: w,
      height: h,
      filter: (node: HTMLElement) => {
        if (!node.tagName) return true;
        const tag = node.tagName.toLowerCase();
        if (tag === 'prompt-widget-host') return false;
        if (tag === 'canvas') return false;
        if (tag === 'video') return false;
        if (tag === 'iframe') return false;
        if (tag === 'script' || tag === 'link') return false;
        if (node.classList?.contains('xterm')) return false;
        // Exclude elements fully outside viewport
        if (typeof node.getBoundingClientRect === 'function') {
          const r = node.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 &&
              (r.bottom < -50 || r.top > h + 50 || r.right < -50 || r.left > w + 50)) {
            return false;
          }
        }
        return true;
      },
    };

    let svgDataUri: string;
    try {
      svgDataUri = await toSvg(document.documentElement, opts);
    } finally {
      window.getComputedStyle = origGCS;
    }
    cleanup();

    // Re-encode SVG as base64 to avoid character-escaping issues that break
    // Image loading (unescaped &, #, unicode, etc. in the charset=utf-8 data URI)
    const svgPrefix = 'data:image/svg+xml;charset=utf-8,';
    let safeSrc: string;
    if (svgDataUri.startsWith(svgPrefix)) {
      const rawSvg = decodeURIComponent(svgDataUri.slice(svgPrefix.length));
      const sanitized = rawSvg.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      safeSrc = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(sanitized)));
    } else {
      // Fallback: sanitize in place
      safeSrc = svgDataUri.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    // Load as image, draw to canvas, convert to blob
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`SVG image load failed (SVG ${(safeSrc.length / 1024 / 1024).toFixed(1)}MB)`));
      image.src = safeSrc;
    });

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);

    return new Promise<Blob | null>(r => canvas.toBlob(b => r(b), 'image/png'));
  } catch (err) {
    cleanup();
    console.error('[pw] screenshot: html-to-image failed:', err);
    return null;
  }
}

/* ── getDisplayMedia one-shot capture ── */
async function captureOneShot(opts?: CaptureOptions): Promise<Blob | null> {
  const host = opts?.excludeWidget ? document.querySelector('prompt-widget-host') as HTMLElement | null : null;
  if (host) host.style.display = 'none';

  const cursor = opts?.excludeCursor ? document.getElementById('__pw-virtual-cursor') : null;
  const prevCursorDisplay = cursor?.style.display;
  if (cursor) cursor.style.display = 'none';

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      preferCurrentTab: true,
    } as any);

    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    await new Promise<void>(r => { video.onloadeddata = () => r(); });

    await countdownDelay(CHROME_INDICATOR_DELAY_SEC, n => opts?.onStatus?.(`${n}…`));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);

    track.stop();
    if (host) host.style.display = '';
    if (cursor) cursor.style.display = prevCursorDisplay ?? '';

    return new Promise(r => canvas.toBlob(b => r(b), 'image/png'));
  } catch (err) {
    if (host) host.style.display = '';
    if (cursor) cursor.style.display = prevCursorDisplay ?? '';
    console.error('[pw] screenshot: getDisplayMedia failed:', err);
    return null;
  }
}

/* ── getDisplayMedia persistent-stream capture ── */
async function capturePersistent(opts?: CaptureOptions): Promise<Blob | null> {
  const host = opts?.excludeWidget ? document.querySelector('prompt-widget-host') as HTMLElement | null : null;
  if (host) host.style.display = 'none';

  const cursor = opts?.excludeCursor ? document.getElementById('__pw-virtual-cursor') : null;
  const prevCursorDisplay = cursor?.style.display;
  if (cursor) cursor.style.display = 'none';

  try {
    const { video } = await ensureStream(opts?.onStatus);

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);

    if (host) host.style.display = '';
    if (cursor) cursor.style.display = prevCursorDisplay ?? '';

    return new Promise(r => canvas.toBlob(b => r(b), 'image/png'));
  } catch (err) {
    if (host) host.style.display = '';
    if (cursor) cursor.style.display = prevCursorDisplay ?? '';
    console.error('[pw] screenshot: getDisplayMedia failed:', err);
    return null;
  }
}

/* ── public API ── */
export async function captureScreenshot(opts?: CaptureOptions): Promise<Blob | null> {
  const method = opts?.method ?? 'html-to-image';

  if (method === 'html-to-image') {
    return captureHtmlToImage(opts);
  }

  if (opts?.keepStream) {
    return capturePersistent(opts);
  }
  return captureOneShot(opts);
}

export function stopScreencastStream() {
  if (persistentStream) {
    persistentStream.getTracks().forEach(t => t.stop());
    persistentStream = null;
    persistentVideo = null;
  }
}

export function hasActiveDisplayMediaStream(): boolean {
  return isStreamAlive();
}
