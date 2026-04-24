import { render } from 'preact';
import { App } from './components/App.js';
import './lib/settings.js';
import { installConsoleBuffer } from './lib/console-buffer.js';
import '@xterm/xterm/css/xterm.css';
import './app.css';

installConsoleBuffer();

render(<App />, document.getElementById('app')!);
