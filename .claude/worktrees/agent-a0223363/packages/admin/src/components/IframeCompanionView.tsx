import { signal } from '@preact/signals';
import { useRef } from 'preact/hooks';

export function IframeCompanionView({ url }: { url: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loading = signal(true);

  return (
    <div class="iframe-companion">
      <div class="iframe-companion-toolbar">
        <span class="iframe-companion-url" title={url}>{url}</span>
        <button
          class="iframe-companion-reload"
          onClick={() => {
            const iframe = iframeRef.current;
            if (iframe) {
              iframe.src = url;
              loading.value = true;
            }
          }}
          title="Reload"
        >
          {'\u21BB'}
        </button>
        <a
          class="iframe-companion-open"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in new tab"
        >
          {'\u2197'}
        </a>
      </div>
      <iframe
        ref={iframeRef}
        src={url}
        class="iframe-companion-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onLoad={() => { loading.value = false; }}
      />
    </div>
  );
}
