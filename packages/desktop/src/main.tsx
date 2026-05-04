import { render } from 'preact';
import './app.css';

function App() {
  return (
    <div class="pp-root">
      <div class="pp-status">
        ProPanes Desktop
        <span class="pp-dot" />
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
