export interface SelectedElementInfo {
  selector: string;
  tagName: string;
  id: string;
  classes: string[];
  textContent: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;
  childrenHTML?: string;
}

const CAPTURE_ATTRS = [
  'src', 'href', 'alt', 'placeholder', 'type', 'role',
  'aria-label', 'name', 'data-testid', 'title',
];

function generateSelector(el: Element): string {
  const segments: string[] = [];
  let current: Element | null = el;

  for (let depth = 0; current && depth < 5; depth++) {
    if (current.id) {
      segments.unshift(`#${current.id}`);
      const candidate = segments.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }

    let seg = current.tagName.toLowerCase();
    const classList = Array.from(current.classList).filter(c => !c.startsWith('pw-'));
    if (classList.length > 0) {
      seg += '.' + classList.join('.');
    }

    const parent: Element | null = current.parentElement;
    if (parent) {
      const tag = current.tagName;
      const siblings = Array.from(parent.children).filter(
        (c: Element) => c.tagName === tag
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        seg += `:nth-of-type(${idx})`;
      }
    }

    segments.unshift(seg);
    const candidate = segments.join(' > ');
    if (document.querySelectorAll(candidate).length === 1) return candidate;

    current = parent;
  }

  return segments.join(' > ');
}

function captureElementInfo(el: Element, includeChildren?: boolean): SelectedElementInfo {
  const rect = el.getBoundingClientRect();
  const attrs: Record<string, string> = {};
  for (const name of CAPTURE_ATTRS) {
    const val = el.getAttribute(name);
    if (val !== null) attrs[name] = val;
  }

  const info: SelectedElementInfo = {
    selector: generateSelector(el),
    tagName: el.tagName.toLowerCase(),
    id: el.id,
    classes: Array.from(el.classList),
    textContent: (el.textContent || '').trim().slice(0, 200),
    boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    attributes: attrs,
  };
  if (includeChildren) {
    info.childrenHTML = el.innerHTML;
  }
  return info;
}

interface SelectionHighlight {
  element: Element;
  overlay: HTMLDivElement;
  info: SelectedElementInfo;
}

export function startPicker(
  callback: (infos: SelectedElementInfo[]) => void,
  widgetHost: Element,
  options?: { multiSelect?: boolean; excludeWidget?: boolean; includeChildren?: boolean; onSelectionChange?: (infos: SelectedElementInfo[]) => void },
): () => void {
  const multiSelect = options?.multiSelect ?? false;
  const excludeWidget = options?.excludeWidget ?? true;
  const includeChildren = options?.includeChildren ?? false;
  const onSelectionChange = options?.onSelectionChange;
  const selected: SelectionHighlight[] = [];

  const highlight = document.createElement('div');
  Object.assign(highlight.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483646',
    border: '2px solid #6366f1',
    background: 'rgba(99, 102, 241, 0.08)',
    borderRadius: '3px',
    transition: 'top 0.05s, left 0.05s, width 0.05s, height 0.05s',
    display: 'none',
  });

  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483646',
    background: '#312e81',
    color: '#e0e7ff',
    fontSize: '11px',
    fontFamily: 'monospace',
    padding: '2px 6px',
    borderRadius: '3px',
    whiteSpace: 'nowrap',
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'none',
  });

  const bar = document.createElement('div');
  Object.assign(bar.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    zIndex: '2147483646',
    background: '#1e1b4b',
    color: '#c7d2fe',
    fontSize: '13px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    textAlign: 'center',
    padding: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
  });

  const barText = document.createElement('span');
  barText.style.pointerEvents = 'none';
  const updateBarText = () => {
    if (!multiSelect) {
      barText.textContent = 'Click or press Space to select \u00b7 Esc to cancel';
      return;
    }
    const count = selected.length;
    barText.textContent = count === 0
      ? 'Press Space to select \u00b7 Esc to cancel'
      : `${count} selected \u00b7 Space to add/remove`;
  };
  updateBarText();

  const doneBtn = document.createElement('button');
  Object.assign(doneBtn.style, {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '4px 12px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
  });
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    finish();
  });

  const hideBtn = document.createElement('button');
  Object.assign(hideBtn.style, {
    background: 'transparent',
    color: '#818cf8',
    border: '1px solid #4338ca',
    borderRadius: '4px',
    padding: '4px 10px',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    marginLeft: '4px',
  });
  hideBtn.textContent = 'Hide';
  hideBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    bar.style.display = 'none';
  });

  if (multiSelect) {
    bar.append(barText, doneBtn, hideBtn);
  } else {
    bar.append(barText, hideBtn);
  }

  document.body.appendChild(highlight);
  document.body.appendChild(label);
  document.body.appendChild(bar);

  let lastTarget: Element | null = null;

  function isPickerOverlay(el: Element | null): boolean {
    while (el) {
      if (el === highlight || el === label || el === bar) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isWidgetElement(el: Element | null): boolean {
    while (el) {
      if (el === widgetHost) return true;
      el = el.parentElement;
    }
    return false;
  }

  function resolveTarget(x: number, y: number): Element | null {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (isPickerOverlay(el)) return null;
    if (excludeWidget && isWidgetElement(el)) return null;
    if (!excludeWidget && el === widgetHost && widgetHost.shadowRoot) {
      const inner = widgetHost.shadowRoot.elementFromPoint(x, y);
      if (inner) return inner;
    }
    return el;
  }

  function isAlreadySelected(el: Element): number {
    return selected.findIndex(s => s.element === el);
  }

  function createSelectionOverlay(el: Element): HTMLDivElement {
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147483645',
      border: '2px solid #22c55e',
      background: 'rgba(34, 197, 94, 0.12)',
      borderRadius: '3px',
      top: rect.top + 'px',
      left: rect.left + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function updateSelectionOverlays() {
    for (const s of selected) {
      const rect = s.element.getBoundingClientRect();
      s.overlay.style.top = rect.top + 'px';
      s.overlay.style.left = rect.left + 'px';
      s.overlay.style.width = rect.width + 'px';
      s.overlay.style.height = rect.height + 'px';
    }
  }

  function onMouseMove(e: MouseEvent) {
    const el = resolveTarget(e.clientX, e.clientY);
    if (!el) {
      highlight.style.display = 'none';
      label.style.display = 'none';
      lastTarget = null;
      return;
    }
    lastTarget = el;
    const rect = el.getBoundingClientRect();
    const alreadyIdx = isAlreadySelected(el);

    highlight.style.display = 'block';
    highlight.style.top = rect.top + 'px';
    highlight.style.left = rect.left + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    if (alreadyIdx >= 0) {
      highlight.style.border = '2px solid #ef4444';
      highlight.style.background = 'rgba(239, 68, 68, 0.08)';
    } else {
      highlight.style.border = '2px solid #6366f1';
      highlight.style.background = 'rgba(99, 102, 241, 0.08)';
    }

    let labelText = el.tagName.toLowerCase();
    if (el.id) labelText += '#' + el.id;
    const cls = Array.from(el.classList).filter(c => !c.startsWith('pw-')).slice(0, 3);
    if (cls.length) labelText += '.' + cls.join('.');
    if (alreadyIdx >= 0) labelText = '\u2713 ' + labelText;
    label.textContent = labelText;
    label.style.display = 'block';
    label.style.top = Math.max(0, rect.top - 22) + 'px';
    label.style.left = rect.left + 'px';
  }

  function selectTarget(target: Element) {
    if (!multiSelect) {
      const info = captureElementInfo(target, includeChildren);
      selected.push({ element: target, overlay: createSelectionOverlay(target), info });
      finish();
      return;
    }

    const idx = isAlreadySelected(target);
    if (idx >= 0) {
      selected[idx].overlay.remove();
      selected.splice(idx, 1);
    } else {
      const info = captureElementInfo(target, includeChildren);
      const overlay = createSelectionOverlay(target);
      selected.push({ element: target, overlay, info });
    }
    updateBarText();
    if (onSelectionChange) {
      onSelectionChange(selected.map(s => s.info));
    }
  }

  function onClick(e: MouseEvent) {
    if (bar.contains(e.target as Node)) return;
    if (multiSelect) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = lastTarget || resolveTarget(e.clientX, e.clientY);
    if (!target) return;
    selectTarget(target);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (selected.length > 0) {
        finish();
      } else {
        callback([]);
        cleanup();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (lastTarget) selectTarget(lastTarget);
    }
  }

  function onScroll() {
    updateSelectionOverlays();
  }

  function finish() {
    const infos = selected.map(s => {
      // Re-capture bounding rect at finish time
      const rect = s.element.getBoundingClientRect();
      s.info.boundingRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      return s.info;
    });
    callback(infos);
    cleanup();
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    highlight.remove();
    label.remove();
    bar.remove();
    for (const s of selected) {
      s.overlay.remove();
    }
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);

  return cleanup;
}
