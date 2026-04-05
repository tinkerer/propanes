import { copyWithTooltip } from '../lib/clipboard.js';

interface ElementInfo {
  tagName: string;
  id?: string;
  classes?: string[];
  selector?: string;
  textContent?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
  childrenHTML?: string;
  computedStyles?: Record<string, string>;
}

interface ElementCardProps {
  element: ElementInfo;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onFetchParent?: () => void;
  onFetchChildren?: () => void;
  onFetchSiblings?: () => void;
  onFetchStyles?: () => void;
  onRemove?: () => void;
  onInsertIntoSpec?: () => void;
  inline?: boolean;
  hasLiveSession?: boolean;
  traversalLoading?: string | null;
}

function buildChipLabel(el: ElementInfo): string {
  let label = el.tagName?.toLowerCase() || 'element';
  if (el.id) label += `#${el.id}`;
  if (el.classes?.length) label += `.${el.classes.slice(0, 2).join('.')}`;
  if (el.classes && el.classes.length > 2) label += `…`;
  return label;
}

export function ElementCard({
  element: el,
  index,
  expanded,
  onToggle,
  onFetchParent,
  onFetchChildren,
  onFetchSiblings,
  onFetchStyles,
  onRemove,
  onInsertIntoSpec,
  inline,
  hasLiveSession,
  traversalLoading,
}: ElementCardProps) {
  if (!expanded) {
    return (
      <span
        class={`element-chip${inline ? ' element-chip-inline' : ''}`}
        onClick={onToggle}
        title={el.selector || buildChipLabel(el)}
      >
        <span class="element-chip-badge">element</span>
        <code class="element-chip-label">{buildChipLabel(el)}</code>
        <span class="element-chip-chevron">▸</span>
      </span>
    );
  }

  return (
    <div class="element-card-expanded">
      <div class="element-card-header" onClick={onToggle}>
        <span class="element-chip-badge">element</span>
        <code class="element-chip-label">{buildChipLabel(el)}</code>
        <span class="element-chip-chevron">▾</span>
        <span style="flex:1" />
        {onRemove && (
          <button
            class="element-card-remove"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove element"
          >&times;</button>
        )}
      </div>

      <div class="element-card-body">
        {/* Identity */}
        <div class="element-card-section">
          <div class="field-row">
            <span class="field-label">Tag</span>
            <span class="field-value"><code style="background:var(--pw-code-block-bg);padding:1px 6px;border-radius:3px">{el.tagName}</code></span>
          </div>
          {el.id && (
            <div class="field-row">
              <span class="field-label">ID</span>
              <span class="field-value" style="font-family:monospace">#{el.id}</span>
            </div>
          )}
          {el.classes && el.classes.length > 0 && (
            <div class="field-row">
              <span class="field-label">Classes</span>
              <span class="field-value" style="font-family:monospace">.{el.classes.join(' .')}</span>
            </div>
          )}
        </div>

        {/* Selector */}
        {el.selector && (
          <div class="element-card-section">
            <div class="field-row">
              <span class="field-label">Selector</span>
              <span
                class="field-value element-card-selector"
                title="Click to copy"
                onClick={(e) => copyWithTooltip(el.selector!, e as any)}
              >
                {el.selector}
              </span>
            </div>
          </div>
        )}

        {/* Text content */}
        {el.textContent && (
          <div class="element-card-section">
            <div class="field-row">
              <span class="field-label">Text</span>
              <span class="field-value" style="font-size:12px;color:var(--pw-text-muted)">
                {el.textContent.length > 200 ? el.textContent.slice(0, 200) + '…' : el.textContent}
              </span>
            </div>
          </div>
        )}

        {/* Position */}
        {el.boundingRect && (
          <div class="element-card-section">
            <div class="field-row">
              <span class="field-label">Position</span>
              <span class="field-value" style="font-size:12px">
                {Math.round(el.boundingRect.x)},{Math.round(el.boundingRect.y)} — {Math.round(el.boundingRect.width)}×{Math.round(el.boundingRect.height)}
              </span>
            </div>
          </div>
        )}

        {/* Attributes */}
        {el.attributes && Object.keys(el.attributes).length > 0 && (
          <div class="element-card-section">
            <div style="font-size:11px;color:var(--pw-text-faint);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Attributes</div>
            {Object.entries(el.attributes).map(([k, v]) => (
              <div class="field-row" key={k}>
                <span class="field-label" style="font-family:monospace;font-size:11px">{k}</span>
                <span class="field-value" style="font-size:12px;word-break:break-all">{v}</span>
              </div>
            ))}
          </div>
        )}

        {/* Children HTML */}
        {el.childrenHTML && (
          <div class="element-card-section">
            <div style="font-size:11px;color:var(--pw-text-faint);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Inner HTML</div>
            <pre class="element-card-html">{el.childrenHTML.length > 500 ? el.childrenHTML.slice(0, 500) + '…' : el.childrenHTML}</pre>
          </div>
        )}

        {/* Computed Styles */}
        {el.computedStyles && Object.keys(el.computedStyles).length > 0 && (
          <div class="element-card-section">
            <div style="font-size:11px;color:var(--pw-text-faint);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Computed Styles</div>
            {Object.entries(el.computedStyles).map(([k, v]) => (
              <div class="field-row" key={k}>
                <span class="field-label" style="font-family:monospace;font-size:11px">{k}</span>
                <span class="field-value" style="font-size:12px">{v}</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        {(hasLiveSession || onInsertIntoSpec) && (
          <div class="element-actions">
            {hasLiveSession && onFetchParent && (
              <button
                class="btn btn-sm"
                disabled={traversalLoading === `parent-${index}`}
                onClick={(e) => { e.stopPropagation(); onFetchParent(); }}
              >
                {traversalLoading === `parent-${index}` ? '…' : '↑ Parent'}
              </button>
            )}
            {hasLiveSession && onFetchChildren && (
              <button
                class="btn btn-sm"
                disabled={traversalLoading === `children-${index}`}
                onClick={(e) => { e.stopPropagation(); onFetchChildren(); }}
              >
                {traversalLoading === `children-${index}` ? '…' : '↓ Children'}
              </button>
            )}
            {hasLiveSession && onFetchSiblings && (
              <button
                class="btn btn-sm"
                disabled={traversalLoading === `siblings-${index}`}
                onClick={(e) => { e.stopPropagation(); onFetchSiblings(); }}
              >
                {traversalLoading === `siblings-${index}` ? '…' : '↔ Siblings'}
              </button>
            )}
            {hasLiveSession && onFetchStyles && (
              <button
                class="btn btn-sm"
                disabled={traversalLoading === `styles-${index}`}
                onClick={(e) => { e.stopPropagation(); onFetchStyles(); }}
              >
                {traversalLoading === `styles-${index}` ? '…' : '🎨 Styles'}
              </button>
            )}
            {onInsertIntoSpec && (
              <button
                class="btn btn-sm btn-primary"
                onClick={(e) => { e.stopPropagation(); onInsertIntoSpec(); }}
              >
                + Spec
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
