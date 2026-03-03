import { collectContext, getEnvironment, getPerformanceTiming } from './collectors.js';
import { captureScreenshot } from './screenshot.js';
import {
  dispatchMouseMove, dispatchClickAt, dispatchHover, dispatchDrag,
  dispatchMouseDown, dispatchMouseUp, dispatchPressKey, dispatchKeyDown,
  dispatchKeyUp, dispatchTypeText,
} from './input-events.js';
import type { Collector } from '@prompt-widget/shared';

interface CommandMessage {
  type: 'command';
  requestId: string;
  command: string;
  params: Record<string, unknown>;
}

function deepQuerySelector(root: Element | Document | ShadowRoot, selector: string): Element | null {
  const found = root.querySelector(selector);
  if (found) return found;

  const elements = root instanceof Document ? Array.from(root.querySelectorAll('*')) : Array.from(root.querySelectorAll('*'));
  for (const el of elements) {
    if (el.shadowRoot) {
      const deep = deepQuerySelector(el.shadowRoot, selector);
      if (deep) return deep;
    }
  }
  return null;
}

function deepQuerySelectorAll(root: Element | Document | ShadowRoot, selector: string): Element[] {
  const results: Element[] = Array.from(root.querySelectorAll(selector));

  const elements = root.querySelectorAll('*');
  for (const el of elements) {
    if (el.shadowRoot) {
      results.push(...deepQuerySelectorAll(el.shadowRoot, selector));
    }
  }
  return results;
}

function isElementVisible(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export class SessionBridge {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private endpoint: string;
  private collectors: Collector[];
  private apiKey: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  public screenshotIncludeWidget = true;
  public autoDispatch = true;
  public hostUrl: string | undefined;

  constructor(endpoint: string, sessionId: string, collectors: Collector[], apiKey?: string) {
    this.endpoint = endpoint;
    this.sessionId = sessionId;
    this.collectors = collectors;
    this.apiKey = apiKey;
  }

  connect() {
    let wsUrl = this.endpoint
      .replace(/^http/, 'ws')
      .replace(/\/api\/v1\/feedback$/, `/ws?sessionId=${encodeURIComponent(this.sessionId)}`);
    if (this.apiKey) {
      wsUrl += `&apiKey=${encodeURIComponent(this.apiKey)}`;
    }

    try {
      this.ws = new WebSocket(wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.sendMeta();
      this.listenForNavigation();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'config') {
          if ('screenshotIncludeWidget' in msg) {
            this.screenshotIncludeWidget = this.screenshotIncludeWidget || !!msg.screenshotIncludeWidget;
          }
          if ('autoDispatch' in msg) {
            this.autoDispatch = !!msg.autoDispatch;
          }
        } else if (msg.type === 'command') {
          this.handleCommand(msg as CommandMessage);
        }
      } catch {
        // ignore
      }
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }

  private navHandler: (() => void) | null = null;

  private listenForNavigation() {
    this.stopListeningForNavigation();
    this.navHandler = () => this.sendMeta();
    window.addEventListener('hashchange', this.navHandler);
    window.addEventListener('popstate', this.navHandler);
  }

  private stopListeningForNavigation() {
    if (this.navHandler) {
      window.removeEventListener('hashchange', this.navHandler);
      window.removeEventListener('popstate', this.navHandler);
      this.navHandler = null;
    }
  }

  private sendMeta() {
    this.send({
      type: 'meta',
      url: this.hostUrl || location.href,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  }

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private respond(requestId: string, data: unknown) {
    this.send({ type: 'response', requestId, data });
  }

  private respondError(requestId: string, error: string) {
    this.send({ type: 'response', requestId, error });
  }

  private async handleCommand(msg: CommandMessage) {
    const { requestId, command, params } = msg;

    try {
      switch (command) {
        case 'screenshot': {
          const blob = await captureScreenshot({ excludeWidget: this.screenshotIncludeWidget, excludeCursor: !!params.excludeCursor, method: params.method === 'display-media' ? 'display-media' : 'html-to-image' });
          if (!blob) {
            this.respondError(requestId, 'Screenshot capture failed');
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            this.respond(requestId, {
              dataUrl: reader.result,
              mimeType: blob.type,
              size: blob.size,
            });
          };
          reader.readAsDataURL(blob);
          break;
        }

        case 'execute': {
          const expression = params.expression as string;
          // Run in an async IIFE so await works
          const fn = new Function('return (async () => { ' + expression + ' })()');
          const result = await fn();
          this.respond(requestId, {
            result: result !== undefined ? JSON.parse(JSON.stringify(result)) : undefined,
          });
          break;
        }

        case 'getConsole': {
          const ctx = collectContext(['console'] as Collector[]);
          this.respond(requestId, { logs: ctx.consoleLogs || [] });
          break;
        }

        case 'getNetwork': {
          const ctx = collectContext(['network'] as Collector[]);
          this.respond(requestId, { errors: ctx.networkErrors || [] });
          break;
        }

        case 'getEnvironment': {
          this.respond(requestId, getEnvironment());
          break;
        }

        case 'getPerformance': {
          this.respond(requestId, getPerformanceTiming());
          break;
        }

        case 'getDom': {
          const selector = (params.selector as string) || 'body';
          const pierce = !!params.pierceShadow;
          const el = pierce ? deepQuerySelector(document, selector) : document.querySelector(selector);
          if (!el) {
            this.respondError(requestId, `Element not found: ${selector}`);
            return;
          }
          this.respond(requestId, {
            html: el.outerHTML.slice(0, 50_000),
            text: el.textContent?.slice(0, 10_000) || '',
            tagName: el.tagName,
            childCount: el.children.length,
            attributes: getAttributes(el),
            accessibilityTree: buildA11yTree(el, 3, pierce),
          });
          break;
        }

        case 'navigate': {
          const url = params.url as string;
          window.location.href = url;
          this.respond(requestId, { navigated: true, url });
          break;
        }

        case 'click': {
          const selector = params.selector as string;
          const pierce = !!params.pierceShadow;
          const el = (pierce ? deepQuerySelector(document, selector) : document.querySelector(selector)) as HTMLElement | null;
          if (!el) {
            this.respondError(requestId, `Element not found: ${selector}`);
            return;
          }
          el.click();
          this.respond(requestId, {
            clicked: true,
            selector,
            tagName: el.tagName,
            text: el.textContent?.slice(0, 200) || '',
          });
          break;
        }

        case 'type': {
          const selector = params.selector as string | undefined;
          const text = params.text as string;
          const pierce = !!params.pierceShadow;
          let el: HTMLElement | null;
          if (selector) {
            el = (pierce ? deepQuerySelector(document, selector) : document.querySelector(selector)) as HTMLElement | null;
          } else {
            el = document.activeElement as HTMLElement;
          }
          if (!el || !('value' in el)) {
            this.respondError(requestId, selector ? `Element not found or not typeable: ${selector}` : 'No active element');
            return;
          }
          (el as HTMLInputElement).value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          this.respond(requestId, { typed: true, selector, length: text.length });
          break;
        }

        case 'moveMouse': {
          const result = dispatchMouseMove(params.x as number, params.y as number);
          this.respond(requestId, result);
          break;
        }

        case 'clickAt': {
          const result = dispatchClickAt(params.x as number, params.y as number, params.button as number | undefined);
          this.respond(requestId, result);
          break;
        }

        case 'hover': {
          const result = dispatchHover({
            selector: params.selector as string | undefined,
            x: params.x as number | undefined,
            y: params.y as number | undefined,
            pierceShadow: !!params.pierceShadow,
          });
          this.respond(requestId, result);
          break;
        }

        case 'drag': {
          const from = params.from as { x: number; y: number };
          const to = params.to as { x: number; y: number };
          const result = await dispatchDrag(from, to, params.steps as number | undefined, params.stepDelayMs as number | undefined);
          this.respond(requestId, result);
          break;
        }

        case 'mouseDown': {
          const result = dispatchMouseDown(params.x as number, params.y as number, params.button as number | undefined);
          this.respond(requestId, result);
          break;
        }

        case 'mouseUp': {
          const result = dispatchMouseUp(params.x as number, params.y as number, params.button as number | undefined);
          this.respond(requestId, result);
          break;
        }

        case 'pressKey': {
          const result = dispatchPressKey(params.key as string, params.modifiers as any);
          this.respond(requestId, result);
          break;
        }

        case 'keyDown': {
          const result = dispatchKeyDown(params.key as string, params.modifiers as any);
          this.respond(requestId, result);
          break;
        }

        case 'keyUp': {
          const result = dispatchKeyUp(params.key as string, params.modifiers as any);
          this.respond(requestId, result);
          break;
        }

        case 'typeText': {
          const result = await dispatchTypeText(params.text as string, params.selector as string | undefined, params.charDelayMs as number | undefined);
          this.respond(requestId, result);
          break;
        }

        case 'openAdmin': {
          const panel = (params.panel as string) || 'feedback';
          const param = params.param as string | undefined;
          if (window.promptWidget) {
            window.promptWidget.openAdmin(panel as any, { param });
            this.respond(requestId, { opened: true, panel });
          } else {
            this.respondError(requestId, 'Widget not initialized');
          }
          break;
        }

        case 'closeAdmin': {
          if (window.promptWidget) {
            window.promptWidget.closeAdmin();
            this.respond(requestId, { closed: true });
          } else {
            this.respondError(requestId, 'Widget not initialized');
          }
          break;
        }

        case 'waitFor': {
          const selector = params.selector as string;
          const condition = (params.condition as string) || 'exists';
          const text = params.text as string | undefined;
          const timeout = Math.min((params.timeout as number) || 5000, 30000);
          const pollInterval = Math.max((params.pollInterval as number) || 100, 50);
          const pierce = !!params.pierceShadow;

          const startTime = Date.now();

          const check = (): { met: boolean; element?: Element | null } => {
            const el = pierce ? deepQuerySelector(document, selector) : document.querySelector(selector);
            switch (condition) {
              case 'exists':
                return { met: !!el, element: el };
              case 'absent':
                return { met: !el, element: null };
              case 'visible':
                return { met: !!el && isElementVisible(el), element: el };
              case 'hidden':
                return { met: !el || !isElementVisible(el), element: el };
              case 'textContains':
                return { met: !!el && (el.textContent || '').includes(text || ''), element: el };
              case 'textEquals':
                return { met: !!el && (el.textContent || '').trim() === (text || ''), element: el };
              default:
                return { met: false };
            }
          };

          const poll = () => {
            const result = check();
            if (result.met) {
              this.respond(requestId, {
                found: true,
                selector,
                condition,
                elapsedMs: Date.now() - startTime,
                element: result.element ? {
                  tagName: result.element.tagName,
                  text: result.element.textContent?.slice(0, 200) || '',
                  visible: result.element ? isElementVisible(result.element) : false,
                } : null,
              });
              return;
            }
            if (Date.now() - startTime >= timeout) {
              this.respond(requestId, {
                found: false,
                selector,
                condition,
                elapsedMs: Date.now() - startTime,
                timedOut: true,
              });
              return;
            }
            setTimeout(poll, pollInterval);
          };
          poll();
          break;
        }

        case 'widgetSubmit': {
          if (!window.promptWidget) {
            this.respondError(requestId, 'Widget not initialized');
            break;
          }
          const description = (params.description as string) || '';
          const doScreenshot = !!params.screenshot;
          const type = (params.type as string) || 'manual';
          const tags = (params.tags as string[]) || [];
          try {
            await window.promptWidget.submit({
              description,
              screenshot: doScreenshot,
              type: type as any,
              tags,
            });
            this.respond(requestId, { submitted: true });
          } catch (err) {
            this.respondError(requestId, err instanceof Error ? err.message : 'Submit failed');
          }
          break;
        }

        case 'appendFeedback': {
          if (!window.promptWidget) {
            this.respondError(requestId, 'Widget not initialized');
            break;
          }
          const feedbackId = params.feedbackId as string;
          if (!feedbackId) {
            this.respondError(requestId, 'Missing feedbackId');
            break;
          }
          window.promptWidget.appendToFeedback(feedbackId);
          this.respond(requestId, { appendMode: true, feedbackId });
          break;
        }

        default:
          this.respondError(requestId, `Unknown command: ${command}`);
      }
    } catch (err) {
      this.respondError(requestId, err instanceof Error ? err.message : 'Command failed');
    }
  }

  disconnect() {
    this.stopListeningForNavigation();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'destroyed');
    this.ws = null;
  }
}

function getAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

interface A11yNode {
  role: string;
  name: string;
  tag: string;
  children?: A11yNode[];
}

function buildA11yTree(el: Element, maxDepth: number, pierceShadow = false): A11yNode {
  const role = el.getAttribute('role') || inferRole(el);
  const name =
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    el.getAttribute('title') ||
    (el.tagName === 'INPUT' ? (el as HTMLInputElement).placeholder : '') ||
    el.textContent?.trim().slice(0, 80) ||
    '';

  const node: A11yNode = { role, name, tag: el.tagName.toLowerCase() };

  if (maxDepth > 0) {
    const children: Element[] = [];
    if (pierceShadow && el.shadowRoot) {
      children.push(...Array.from(el.shadowRoot.children));
    }
    children.push(...Array.from(el.children));

    if (children.length > 0) {
      node.children = [];
      for (const child of children) {
        node.children.push(buildA11yTree(child, maxDepth - 1, pierceShadow));
      }
    }
  }

  return node;
}

function inferRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const roleMap: Record<string, string> = {
    a: 'link',
    button: 'button',
    input: 'textbox',
    textarea: 'textbox',
    select: 'combobox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading',
  };
  return roleMap[tag] || 'generic';
}
