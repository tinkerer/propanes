const API_BASE = '/api/v1/agent/sessions';

async function executeInSession(sessionId: string, expression: string): Promise<any> {
  const res = await fetch(`${API_BASE}/${sessionId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression }),
  });
  if (!res.ok) throw new Error(`Execute failed: ${res.status}`);
  return res.json();
}

// Self-contained JS that captures element info — runs in the page context
const CAPTURE_ELEMENT_JS = `
function __captureEl(el) {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const attrs = {};
  for (const a of el.attributes || []) attrs[a.name] = a.value;
  // Build a selector
  let sel = el.tagName.toLowerCase();
  if (el.id) sel += '#' + el.id;
  else if (el.className && typeof el.className === 'string') {
    sel += '.' + el.className.trim().split(/\\s+/).join('.');
  }
  return {
    tagName: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.className && typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean) : [],
    selector: sel,
    textContent: (el.textContent || '').trim().slice(0, 300),
    boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    attributes: attrs,
    childrenHTML: el.innerHTML ? el.innerHTML.slice(0, 1000) : undefined,
  };
}
`;

export interface CapturedElement {
  tagName: string;
  id?: string;
  classes?: string[];
  selector?: string;
  textContent?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
  childrenHTML?: string;
}

export async function fetchParent(sessionId: string, selector: string): Promise<CapturedElement | null> {
  const expression = `
    ${CAPTURE_ELEMENT_JS}
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !el.parentElement) return null;
      return __captureEl(el.parentElement);
    })()
  `;
  const result = await executeInSession(sessionId, expression);
  return result?.result ?? null;
}

export async function fetchChildren(sessionId: string, selector: string): Promise<CapturedElement[]> {
  const expression = `
    ${CAPTURE_ELEMENT_JS}
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return [];
      return Array.from(el.children).slice(0, 20).map(__captureEl).filter(Boolean);
    })()
  `;
  const result = await executeInSession(sessionId, expression);
  return result?.result ?? [];
}

export async function fetchSiblings(sessionId: string, selector: string): Promise<CapturedElement[]> {
  const expression = `
    ${CAPTURE_ELEMENT_JS}
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !el.parentElement) return [];
      return Array.from(el.parentElement.children).slice(0, 20).map(__captureEl).filter(Boolean);
    })()
  `;
  const result = await executeInSession(sessionId, expression);
  return result?.result ?? [];
}

export async function fetchComputedStyles(sessionId: string, selector: string): Promise<Record<string, string>> {
  const STYLE_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding',
    'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight',
    'border', 'borderRadius', 'overflow', 'zIndex', 'opacity',
    'flexDirection', 'justifyContent', 'alignItems', 'gap', 'gridTemplateColumns',
  ];
  const expression = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return {};
      const cs = window.getComputedStyle(el);
      const result = {};
      ${JSON.stringify(STYLE_PROPS)}.forEach(function(p) {
        const v = cs.getPropertyValue(p.replace(/([A-Z])/g, '-$1').toLowerCase());
        if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') {
          result[p] = v;
        }
      });
      return result;
    })()
  `;
  const result = await executeInSession(sessionId, expression);
  return result?.result ?? {};
}
