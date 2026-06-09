import { render } from 'preact';
import { App } from './components/shell/App.js';
import './lib/settings.js';
import { installConsoleBuffer, installNetworkCollector } from './lib/console-buffer.js';
import { installBrowserFreezeInstrumentation } from './lib/perf.js';
import '@xterm/xterm/css/xterm.css';
import './app.css';

declare global {
  interface Window {
    __PROPANES_ADMIN_API_KEY__?: string;
  }
}

installConsoleBuffer();
installNetworkCollector();
installBrowserFreezeInstrumentation();

render(<App />, document.getElementById('app')!);

const ADMIN_KEY_SENTINEL = '__ADMIN_API_KEY__';

async function resolveAdminWidgetApiKey(): Promise<string | undefined> {
  const injected = window.__PROPANES_ADMIN_API_KEY__;
  if (injected && injected !== ADMIN_KEY_SENTINEL) return injected;

  try {
    const res = await fetch('/api/v1/admin/applications');
    if (!res.ok) return undefined;
    const apps = await res.json() as Array<{ name?: string; apiKey?: string; projectDir?: string }>;
    const adminApp =
      apps.find((app) => app.name === 'Propanes Admin') ||
      apps.find((app) => typeof app.projectDir === 'string' && /\/propanes\/?$/.test(app.projectDir)) ||
      apps[0];
    return adminApp?.apiKey;
  } catch {
    return undefined;
  }
}

async function installAdminFeedbackWidget() {
  const widgetScript = document.createElement('script');
  widgetScript.src = '/widget/propanes.js';
  widgetScript.dataset.endpoint = '/api/v1/feedback';
  widgetScript.dataset.mode = 'always';
  widgetScript.dataset.position = 'bottom-right';
  const appKey = await resolveAdminWidgetApiKey();
  if (appKey) widgetScript.dataset.appKey = appKey;
  widgetScript.dataset.collectors = 'console,network,performance,environment';
  widgetScript.dataset.noEmbed = 'true';
  widgetScript.dataset.screenshotIncludeWidget = 'true';
  document.body.appendChild(widgetScript);
}

void installAdminFeedbackWidget();
