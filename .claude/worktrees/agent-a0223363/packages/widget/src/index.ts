import { PromptWidgetElement } from './widget.js';

declare global {
  interface Window {
    promptWidget: PromptWidgetElement;
  }
}

const script = document.currentScript || document.querySelector('script[data-endpoint]');
const noEmbed = script instanceof HTMLScriptElement && script.dataset.noEmbed === 'true';
const params = new URLSearchParams(window.location.search);
const inEmbedIframe = window !== window.top && params.get('embed') === 'true';
const isCompanion = params.get('companion') === 'true';

if ((!noEmbed || !inEmbedIframe) && !isCompanion) {
  const widget = new PromptWidgetElement();
  window.promptWidget = widget;
}

export { PromptWidgetElement };
