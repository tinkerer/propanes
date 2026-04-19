import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface ExpandableProps {
  children: ComponentChildren;
  collapsedHeight?: number;
  className?: string;
  moreLabel?: (collapsed: boolean) => string;
}

export function Expandable({ children, collapsedHeight = 240, className, moreLabel }: ExpandableProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);

  const measure = (el: HTMLDivElement | null) => {
    if (!el) return;
    requestAnimationFrame(() => {
      const innerHeight = el.scrollHeight;
      setOverflow(innerHeight > collapsedHeight + 8);
    });
  };

  const label = moreLabel
    ? moreLabel(!expanded)
    : (expanded ? 'show less' : 'show more');

  return (
    <div class={`sm-expandable ${className || ''}`}>
      <div
        class="sm-expandable-body"
        style={expanded || !overflow ? undefined : { maxHeight: `${collapsedHeight}px`, overflow: 'hidden' }}
        ref={measure}
      >
        {children}
      </div>
      {overflow && (
        <button
          class="sm-expandable-toggle"
          type="button"
          onClick={() => setExpanded(v => !v)}
        >
          {label}
        </button>
      )}
    </div>
  );
}

interface ExpandableLinesProps {
  content: string;
  maxLines: number;
  renderLines: (lines: string[], startIdx: number) => any;
  className?: string;
}

export function ExpandableLines({ content, maxLines, renderLines, className }: ExpandableLinesProps) {
  const [expanded, setExpanded] = useState(false);
  const allLines = content.split('\n');
  const total = allLines.length;

  if (total <= maxLines) {
    return <div class={className}>{renderLines(allLines, 0)}</div>;
  }

  const visible = expanded ? allLines : allLines.slice(0, maxLines);
  const remaining = total - maxLines;

  return (
    <div class={className}>
      {renderLines(visible, 0)}
      <button
        class="sm-expandable-toggle"
        type="button"
        onClick={() => setExpanded(v => !v)}
      >
        {expanded ? 'show less' : `… ${remaining} more lines`}
      </button>
    </div>
  );
}
