import { render } from 'preact';
import { App } from './components/App.js';
import './lib/settings.js';
import '@xterm/xterm/css/xterm.css';
import './app.css';

render(<App />, document.getElementById('app')!);
