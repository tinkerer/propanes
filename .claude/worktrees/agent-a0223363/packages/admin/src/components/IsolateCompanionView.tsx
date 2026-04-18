import { signal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { getIsolateEntry } from '../lib/isolate.js';

export function IsolateCompanionView({ componentName }: { componentName: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loading = signal(true);
  const entry = getIsolateEntry(componentName);
  const label = entry?.label || componentName;
  const src = `${window.location.origin}${window.location.pathname}?isolate=${encodeURIComponent(componentName)}`;

  return (
    <div class="iframe-companion">
      <div class="iframe-companion-toolbar">
        <span class="iframe-companion-url" title={label}>{label}</span>
        <button
          class="iframe-companion-reload"
          onClick={() => {
            const iframe = iframeRef.current;
            if (iframe) {
              iframe.src = src;
              loading.value = true;
            }
          }}
          title="Reload"
        >
          {'\u21BB'}
        </button>
        <a
          class="iframe-companion-open"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in new tab"
        >
          {'\u2197'}
        </a>
      </div>
      <iframe
        ref={iframeRef}
        src={src}
        class="iframe-companion-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onLoad={() => { loading.value = false; }}
      />
    </div>
  );
}
