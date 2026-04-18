/** Fallback copy for non-secure contexts where navigator.clipboard is unavailable */
function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/** Copy text to clipboard, works in both secure and non-secure contexts */
export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text);
  } else {
    fallbackCopy(text);
  }
}

export function copyWithTooltip(text: string, e: MouseEvent) {
  copyText(text);
  const tip = document.createElement('div');
  tip.className = 'copy-tooltip';
  tip.textContent = 'Copied!';
  tip.style.left = `${e.clientX}px`;
  tip.style.top = `${e.clientY - 8}px`;
  document.body.appendChild(tip);
  requestAnimationFrame(() => tip.classList.add('visible'));
  setTimeout(() => {
    tip.classList.remove('visible');
    setTimeout(() => tip.remove(), 150);
  }, 800);
}
