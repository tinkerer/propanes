import { signal } from '@preact/signals';
import { marked } from 'marked';
import { ElementCard } from './ElementCard.js';

type BlockKind = 'text' | 'element' | 'screenshot';

interface Block {
  kind: BlockKind;
  content: string; // markdown text, element index, or screenshot ID
}

interface SpecViewProps {
  description: string;
  elements: any[];
  screenshots: { id: string; filename?: string }[];
  expandedElements: Set<number>;
  onToggleElement: (index: number) => void;
  onFetchParent?: (index: number) => void;
  onFetchChildren?: (index: number) => void;
  onFetchSiblings?: (index: number) => void;
  onFetchStyles?: (index: number) => void;
  onRemoveElement?: (index: number) => void;
  onScreenshotClick?: (screenshot: { id: string; filename?: string }) => void;
  hasLiveSession?: boolean;
  traversalLoading?: string | null;
  mode: 'inline' | 'side';
  cacheBuster?: number;
}

function parseDescription(description: string): Block[] {
  if (!description) return [];

  const TOKEN_RE = /\{\{(element|screenshot):([^}]+)\}\}/g;
  const blocks: Block[] = [];
  let lastIndex = 0;

  let match;
  while ((match = TOKEN_RE.exec(description)) !== null) {
    // Text before the token
    if (match.index > lastIndex) {
      const text = description.slice(lastIndex, match.index).trim();
      if (text) blocks.push({ kind: 'text', content: text });
    }
    blocks.push({ kind: match[1] as BlockKind, content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  // Trailing text
  if (lastIndex < description.length) {
    const text = description.slice(lastIndex).trim();
    if (text) blocks.push({ kind: 'text', content: text });
  }

  return blocks;
}

export function SpecView({
  description,
  elements,
  screenshots,
  expandedElements,
  onToggleElement,
  onFetchParent,
  onFetchChildren,
  onFetchSiblings,
  onFetchStyles,
  onRemoveElement,
  onScreenshotClick,
  hasLiveSession,
  traversalLoading,
  mode,
  cacheBuster,
}: SpecViewProps) {
  const blocks = parseDescription(description);

  // Track which elements/screenshots are referenced in tokens
  const referencedElements = new Set<number>();
  const referencedScreenshots = new Set<string>();
  for (const b of blocks) {
    if (b.kind === 'element') referencedElements.add(parseInt(b.content, 10));
    if (b.kind === 'screenshot') referencedScreenshots.add(b.content);
  }

  // Unreferenced items go at the bottom
  const unreferencedElements = elements
    .map((_, i) => i)
    .filter((i) => !referencedElements.has(i));
  const unreferencedScreenshots = screenshots.filter(
    (s) => !referencedScreenshots.has(s.id)
  );

  const renderBlock = (block: Block, i: number, margin?: boolean) => {
    if (block.kind === 'text') {
      return (
        <div
          key={`text-${i}`}
          class="spec-block spec-block-text markdown-body"
          dangerouslySetInnerHTML={{ __html: marked.parse(block.content) as string }}
        />
      );
    }

    if (block.kind === 'element') {
      const idx = parseInt(block.content, 10);
      const el = elements[idx];
      if (!el) return <span key={`el-${i}`} class="spec-block spec-block-missing">[element {idx} not found]</span>;
      return (
        <div key={`el-${i}`} class={`spec-block spec-block-element${margin ? ' spec-margin-item' : ''}`}>
          <ElementCard
            element={el}
            index={idx}
            expanded={expandedElements.has(idx)}
            onToggle={() => onToggleElement(idx)}
            onFetchParent={onFetchParent ? () => onFetchParent(idx) : undefined}
            onFetchChildren={onFetchChildren ? () => onFetchChildren(idx) : undefined}
            onFetchSiblings={onFetchSiblings ? () => onFetchSiblings(idx) : undefined}
            onFetchStyles={onFetchStyles ? () => onFetchStyles(idx) : undefined}
            onRemove={onRemoveElement ? () => onRemoveElement(idx) : undefined}
            inline={!margin}
            hasLiveSession={hasLiveSession}
            traversalLoading={traversalLoading}
          />
        </div>
      );
    }

    if (block.kind === 'screenshot') {
      const ss = screenshots.find((s) => s.id === block.content);
      if (!ss) return <span key={`ss-${i}`} class="spec-block spec-block-missing">[screenshot {block.content} not found]</span>;
      const src = `/api/v1/images/${ss.id}${cacheBuster ? `?t=${cacheBuster}` : ''}`;
      return (
        <div key={`ss-${i}`} class={`spec-block spec-block-screenshot${margin ? ' spec-margin-item' : ''}`}>
          <img
            class="spec-embed-screenshot"
            src={src}
            alt={ss.filename || 'Screenshot'}
            onClick={() => onScreenshotClick?.(ss)}
          />
        </div>
      );
    }

    return null;
  };

  if (mode === 'side') {
    const textBlocks: { block: Block; idx: number }[] = [];
    const marginBlocks: { block: Block; idx: number; afterTextIdx: number }[] = [];
    let lastTextIdx = 0;

    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].kind === 'text') {
        textBlocks.push({ block: blocks[i], idx: i });
        lastTextIdx = textBlocks.length - 1;
      } else {
        marginBlocks.push({ block: blocks[i], idx: i, afterTextIdx: lastTextIdx });
      }
    }

    return (
      <div class="spec-view spec-view-side">
        <div class="spec-side-text">
          {textBlocks.map((tb) => renderBlock(tb.block, tb.idx))}
          {/* Unreferenced items at the bottom of text column */}
          {unreferencedElements.length > 0 && (
            <div class="spec-unreferenced-section">
              <div class="spec-unreferenced-label">Additional Elements</div>
              {unreferencedElements.map((idx) => (
                <div key={`unref-el-${idx}`} class="spec-block spec-block-element">
                  <ElementCard
                    element={elements[idx]}
                    index={idx}
                    expanded={expandedElements.has(idx)}
                    onToggle={() => onToggleElement(idx)}
                    onFetchParent={onFetchParent ? () => onFetchParent(idx) : undefined}
                    onFetchChildren={onFetchChildren ? () => onFetchChildren(idx) : undefined}
                    onFetchSiblings={onFetchSiblings ? () => onFetchSiblings(idx) : undefined}
                    onFetchStyles={onFetchStyles ? () => onFetchStyles(idx) : undefined}
                    onRemove={onRemoveElement ? () => onRemoveElement(idx) : undefined}
                    hasLiveSession={hasLiveSession}
                    traversalLoading={traversalLoading}
                  />
                </div>
              ))}
            </div>
          )}
          {unreferencedScreenshots.length > 0 && (
            <div class="spec-unreferenced-section">
              <div class="spec-unreferenced-label">Additional Screenshots</div>
              <div class="spec-unreferenced-screenshots">
                {unreferencedScreenshots.map((ss) => (
                  <img
                    key={ss.id}
                    class="spec-embed-screenshot"
                    src={`/api/v1/images/${ss.id}${cacheBuster ? `?t=${cacheBuster}` : ''}`}
                    alt={ss.filename || 'Screenshot'}
                    onClick={() => onScreenshotClick?.(ss)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <div class="spec-side-margin">
          {marginBlocks.map((mb) => renderBlock(mb.block, mb.idx, true))}
        </div>
      </div>
    );
  }

  // Inline mode (default)
  return (
    <div class="spec-view spec-view-inline">
      {blocks.map((block, i) => renderBlock(block, i))}

      {/* Unreferenced items */}
      {unreferencedElements.length > 0 && (
        <div class="spec-unreferenced-section">
          <div class="spec-unreferenced-label">Additional Elements</div>
          {unreferencedElements.map((idx) => (
            <div key={`unref-el-${idx}`} class="spec-block spec-block-element">
              <ElementCard
                element={elements[idx]}
                index={idx}
                expanded={expandedElements.has(idx)}
                onToggle={() => onToggleElement(idx)}
                onFetchParent={onFetchParent ? () => onFetchParent(idx) : undefined}
                onFetchChildren={onFetchChildren ? () => onFetchChildren(idx) : undefined}
                onFetchSiblings={onFetchSiblings ? () => onFetchSiblings(idx) : undefined}
                onFetchStyles={onFetchStyles ? () => onFetchStyles(idx) : undefined}
                onRemove={onRemoveElement ? () => onRemoveElement(idx) : undefined}
                hasLiveSession={hasLiveSession}
                traversalLoading={traversalLoading}
              />
            </div>
          ))}
        </div>
      )}
      {unreferencedScreenshots.length > 0 && (
        <div class="spec-unreferenced-section">
          <div class="spec-unreferenced-label">Additional Screenshots</div>
          <div class="spec-unreferenced-screenshots">
            {unreferencedScreenshots.map((ss) => (
              <img
                key={ss.id}
                class="spec-embed-screenshot"
                src={`/api/v1/images/${ss.id}${cacheBuster ? `?t=${cacheBuster}` : ''}`}
                alt={ss.filename || 'Screenshot'}
                onClick={() => onScreenshotClick?.(ss)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SpecToolbarProps {
  elements: any[];
  screenshots: { id: string; filename?: string }[];
  textareaRef: { current: HTMLTextAreaElement | null };
  onInsert: (token: string) => void;
}

export function SpecToolbar({ elements, screenshots, textareaRef, onInsert }: SpecToolbarProps) {
  function insertAtCursor(token: string) {
    const ta = textareaRef.current;
    if (!ta) {
      onInsert(token);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const newVal = before + token + after;
    onInsert(newVal);
    // Restore cursor after the token
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + token.length;
      ta.focus();
    });
  }

  return (
    <div class="spec-toolbar">
      <span class="spec-toolbar-label">Insert:</span>
      {elements.map((_, i) => (
        <button
          key={i}
          class="btn btn-sm spec-toolbar-btn"
          onClick={() => insertAtCursor(`{{element:${i}}}`)}
          title={`Insert element ${i}`}
        >
          E{i}
        </button>
      ))}
      {screenshots.map((ss) => (
        <button
          key={ss.id}
          class="btn btn-sm spec-toolbar-btn"
          onClick={() => insertAtCursor(`{{screenshot:${ss.id}}}`)}
          title={`Insert screenshot ${ss.filename || ss.id.slice(-6)}`}
        >
          📷{ss.id.slice(-4)}
        </button>
      ))}
    </div>
  );
}
