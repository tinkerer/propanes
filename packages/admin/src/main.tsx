import { render } from 'preact';
import { App } from './components/shell/App.js';
import './lib/settings.js';
import { installConsoleBuffer, installNetworkCollector } from './lib/console-buffer.js';
import { installBrowserFreezeInstrumentation } from './lib/perf.js';
import '@xterm/xterm/css/xterm.css';
import './app.css';

installConsoleBuffer();
installNetworkCollector();
installBrowserFreezeInstrumentation();

render(<App />, document.getElementById('app')!);

const widgetScript = document.createElement('script');
widgetScript.src = '/widget/propanes.js';
widgetScript.dataset.endpoint = '/api/v1/feedback';
widgetScript.dataset.mode = 'always';
widgetScript.dataset.position = 'bottom-right';
widgetScript.dataset.appKey = '__ADMIN_API_KEY__';
widgetScript.dataset.collectors = 'console,network,performance,environment';
widgetScript.dataset.noEmbed = 'true';
widgetScript.dataset.screenshotIncludeWidget = 'true';
document.body.appendChild(widgetScript);
