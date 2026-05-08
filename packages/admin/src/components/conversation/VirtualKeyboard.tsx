import { useState, useCallback } from 'preact/hooks';
import { api } from '../../lib/api.js';

export interface VirtualKeyboardProps {
  sessionId: string;
  /** Currently visible or collapsed */
  visible: boolean;
  onToggle: () => void;
}

interface KeyDef {
  label: string;
  keys: string;
  enter?: boolean;
  flex?: number;
}

const ROW_NUMBERS: KeyDef[] = [
  { label: '1', keys: '1', enter: true },
  { label: '2', keys: '2', enter: true },
  { label: '3', keys: '3', enter: true },
  { label: '4', keys: '4', enter: true },
  { label: '5', keys: '5', enter: true },
  { label: '6', keys: '6', enter: true },
  { label: '7', keys: '7', enter: true },
  { label: '8', keys: '8', enter: true },
  { label: '9', keys: '9', enter: true },
];

const ROW_NAV: KeyDef[] = [
  { label: '\u2191', keys: '\x1b[A' },
  { label: '\u2193', keys: '\x1b[B' },
  { label: '\u2190', keys: '\x1b[D' },
  { label: '\u2192', keys: '\x1b[C' },
  { label: 'Tab', keys: '\t' },
  { label: 'Esc', keys: '\x1b' },
  { label: '\u232b', keys: '\x7f' },
];

const ROW_CTRL: KeyDef[] = [
  { label: 'Ctrl+C', keys: '\x03', flex: 2 },
  { label: 'Ctrl+D', keys: '\x04', flex: 2 },
  { label: 'Ctrl+Z', keys: '\x1a', flex: 2 },
  { label: 'Ctrl+L', keys: '\x0c', flex: 2 },
  { label: 'Enter \u23ce', keys: '\r', flex: 2 },
];

export function VirtualKeyboard({ sessionId, visible, onToggle }: VirtualKeyboardProps) {
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState('');

  const send = useCallback((keys: string, enter?: boolean) => {
    navigator.vibrate?.(10);
    api.sendKeys(sessionId, { keys, enter: enter ?? false }).catch(() => {});
  }, [sessionId]);

  const handleTextSubmit = useCallback(() => {
    if (!text) return;
    send(text, true);
    setText('');
  }, [text, send]);

  if (!visible) {
    return (
      <button class="conv-vkbd-toggle" onClick={onToggle} title="Show virtual keyboard">
        \u2328
      </button>
    );
  }

  return (
    <div class="conv-vkbd">
      <div class="conv-vkbd-header">
        <button class="conv-vkbd-close" onClick={onToggle} title="Hide virtual keyboard">
          \u2328 \u2715
        </button>
      </div>

      {/* Row 1: Number keys */}
      <div class="conv-vkbd-row">
        {ROW_NUMBERS.map((k) => (
          <button
            key={k.label}
            class="conv-vkbd-key"
            onClick={() => send(k.keys, k.enter)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Row 2: Navigation */}
      <div class="conv-vkbd-row">
        {ROW_NAV.map((k) => (
          <button
            key={k.label}
            class="conv-vkbd-key"
            onClick={() => send(k.keys)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Row 3: Control keys */}
      <div class="conv-vkbd-row">
        {ROW_CTRL.map((k) => (
          <button
            key={k.label}
            class="conv-vkbd-key"
            style={k.flex ? { flex: k.flex } : undefined}
            onClick={() => send(k.keys)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Row 4: Text input toggle / input */}
      <div class="conv-vkbd-row">
        {!textMode ? (
          <button
            class="conv-vkbd-key conv-vkbd-key-text"
            style={{ flex: 1 }}
            onClick={() => setTextMode(true)}
          >
            \u2328 Type...
          </button>
        ) : (
          <div class="conv-vkbd-text-input">
            <input
              type="text"
              class="conv-vkbd-input"
              value={text}
              placeholder="Type text..."
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleTextSubmit();
                }
                if (e.key === 'Escape') {
                  setTextMode(false);
                  setText('');
                }
              }}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
            <button class="conv-vkbd-send" onClick={handleTextSubmit}>
              Send
            </button>
            <button
              class="conv-vkbd-send conv-vkbd-send-cancel"
              onClick={() => { setTextMode(false); setText(''); }}
            >
              \u2715
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
