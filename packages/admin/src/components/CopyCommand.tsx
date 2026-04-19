import { useState } from 'preact/hooks';
import { copyText } from '../lib/clipboard.js';

interface Props {
  text: string;
  title?: string;
  className?: string;
}

export function CopyCommand({ text, title, className }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = (e: MouseEvent) => {
    e.stopPropagation();
    copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      class={`sm-copy-btn ${copied ? 'copied' : ''} ${className || ''}`}
      onClick={onCopy}
      title={title || 'Copy to clipboard'}
      aria-label={title || 'Copy to clipboard'}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <span class="sm-copy-btn-label">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
