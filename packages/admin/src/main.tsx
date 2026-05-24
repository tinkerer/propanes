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
