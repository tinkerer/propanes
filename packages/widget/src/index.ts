import { ProPanesElement } from './widget.js';

declare global {
  interface Window {
    promptWidget: ProPanesElement;
  }
}

const script = document.currentScript || document.querySelector('script[data-endpoint]');
const noEmbed = script instanceof HTMLScriptElement && script.dataset.noEmbed === 'true';
const params = new URLSearchParams(window.location.search);
const inEmbedIframe = window !== window.top && params.get('embed') === 'true';
const isCompanion = params.get('companion') === 'true';
// The CoS embed (?embed=cos) opens the admin's chat surface in its own tab and
// already exposes screenshot/voice/dispatch via CosComposer; the widget overlay
// would be a redundant second toolset.
const isCosEmbed = params.get('embed') === 'cos';

if ((!noEmbed || !inEmbedIframe) && !isCompanion && !isCosEmbed) {
  const widget = new ProPanesElement();
  window.promptWidget = widget;
}

export { ProPanesElement };
