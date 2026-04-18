import { ComponentChildren } from 'preact';
import { useState, useRef, useCallback } from 'preact/hooks';
import { tooltipsEnabled } from '../lib/settings.js';

interface TooltipProps {
  text: string;
  shortcut?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  children: ComponentChildren;
}

export function Tooltip({ text, shortcut, position = 'top', children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (!tooltipsEnabled.value) return;
    timerRef.current = setTimeout(() => setVisible(true), 400);
  }, []);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }, []);

  return (
    <span class="tooltip-wrapper" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      <span class={`tooltip-content pos-${position} ${visible ? 'visible' : ''}`}>
        {text}
        {shortcut && <kbd>{shortcut}</kbd>}
      </span>
    </span>
  );
}
