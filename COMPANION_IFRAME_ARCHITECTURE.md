# Companion iframe Architecture Reference

## Where Companions Are Rendered

### 1. GlobalTerminalPanel.tsx (lines 430-456)
```tsx
// Session tabs in the bottom panel can show different companion types
{isJsonl ? (
  <JsonlView sessionId={realSid} />
) : isFeedback ? (
  sess?.feedbackId ? <FeedbackCompanionView feedbackId={sess.feedbackId} /> : <div class="companion-error">No feedback linked</div>
) : isIframe ? (
  sess?.url ? <IframeCompanionView url={sess.url} /> : <div class="companion-error">No URL available</div>
) : isTerminal ? (
  // Terminal companion...
) : (
  <SessionViewToggle sessionId={sid} />
)}
```

### 2. PopoutPanel.tsx (lines 223-229)
Same companion rendering logic as GlobalTerminalPanel, but for floating/docked panels.

---

## iframe Components

### FeedbackCompanionView (13 lines)
**Purpose**: Render feedback detail page inside parent panel
**Source**: `/admin/?companion=true#${route}`
**Type**: Admin page in companion mode (self-referential)

```tsx
export function FeedbackCompanionView({ feedbackId }: { feedbackId: string }) {
  const appId = selectedAppId.value;
  const route = appId
    ? `/app/${appId}/feedback/${feedbackId}`
    : `/feedback/${feedbackId}`;
  const src = `/admin/?companion=true#${route}`;  // ← Self-referential URL
  
  return (
    <iframe
      src={src}
      class="companion-iframe"
      style="width:100%;height:100%;border:none;flex:1"
    />
  );
}
```

### IframeCompanionView (45 lines)
**Purpose**: Render user-provided URLs (e.g., deployed apps)
**Source**: User-provided `url` prop
**Type**: External web page

```tsx
export function IframeCompanionView({ url }: { url: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  return (
    <div class="iframe-companion">
      <div class="iframe-companion-toolbar">
        <span class="iframe-companion-url" title={url}>{url}</span>
        <button>Reload</button>
        <a href={url} target="_blank">Open</a>
      </div>
      <iframe
        ref={iframeRef}
        src={url}
        class="iframe-companion-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onLoad={() => { loading.value = false; }}
      />
    </div>
  );
}
```

---

## Companion Mode Detection

### In state.ts (line 8)
```typescript
export const isCompanion = signal(params.get('companion') === 'true');
```

When a page loads with `?companion=true`, it enters a special mode:

### In App.tsx (lines 114-116)
```tsx
if (isCompanion.value) {
  return <div class="pw-companion-root">{page}</div>;
}
```

Result: Companion mode pages skip the Layout wrapper and show content-only.

### In app.css (lines 6276-6286)
```css
body.pw-companion {
  margin: 0;
  padding: 0;
  background: var(--pw-bg-body);
  overflow: auto;
}

body.pw-companion .pw-companion-root {
  min-height: 100vh;
  padding: 8px 12px;
}
```

Result: Companion pages have no chrome/headers, just content.

---

## How Sessions Decide What Companion to Show

Session type is determined by `session.permissionProfile`:

- **`'feedback'`** → FeedbackCompanionView (show feedback)
- **`'plain'`** → IframeCompanionView (show `session.url`)
- **`'terminal'`** → TerminalCompanionView (show terminal)
- **`'jsonl'`** → JsonlView (show structured log)
- Default → SessionViewToggle (normal terminal view)

The `permissionProfile` is set when the session is created and determines the UI mode.

---

## Event Flow in Companion iframes

### FeedbackCompanionView (Self-Referential)

```
Parent: setShowSpotlight(true)
  ↓
Parent renders <iframe src="/admin/?companion=true#/app/xyz/feedback/123" />
  ↓
iframe document loads App.tsx
  ↓
iframe detects isCompanion=true
  ↓
iframe renders FeedbackDetailPage directly (no Layout)
  ↓
iframe has its own document context and event listeners
  ↓
iframe runs App component code independently
  ↓
When user presses Cmd+K in iframe:
  - Event fires in iframe's document
  - Parent's global shortcut handler doesn't receive it
  - Cmd+K fails silently
```

### IframeCompanionView (External URL)

```
Parent: <iframe src="https://app.example.com" />
  ↓
External page loads in iframe
  ↓
External page has its own JS context
  ↓
Parent has NO control over external page
  ↓
Keyboard events are completely isolated
  ↓
Only postMessage() can communicate
```

---

## The Cmd+K Problem in Context

When a feedback companion is showing:

```
┌─────────────────────────────────────────────┐
│  Parent Document (main admin page)          │
│  • Layout component with shortcuts.ts       │
│  • Registers Cmd+K → setShowSpotlight(v)    │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │ FeedbackCompanionView iframe         │   │
│  │ • Renders /admin?companion=true      │   │
│  │ • Has focus (user clicks in it)      │   │
│  │ • Cmd+K event fires HERE             │   │
│  │ • Event DOES NOT bubble to parent    │   │
│  │ • Parent's Cmd+K handler never runs  │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

## Why Shadow DOM Traversal Exists

shortcuts.ts has logic to traverse shadow DOM:

```typescript
while (el?.shadowRoot?.activeElement) {
  el = el.shadowRoot.activeElement;
}
```

This handles cases where focus is inside a web component's shadow DOM.
But it does NOT handle iframes because:
- Shadow DOM: Content belongs to same document, event bubbles normally
- iframe: Separate document, events don't bubble across boundary

---

## Why Other Shortcuts May Work/Fail From iframe

If a panel-related shortcut is being tested from the parent (not inside iframe):
- Ctrl+Shift+[0-9] (tab switching)
- Ctrl+Shift+W (close tab)
- Ctrl+Shift+_ (dock/undock)

These shortcuts fire in the parent's context, so they work.

But if you press them while focused in the companion iframe, they'll also fail for the same reason as Cmd+K.

---

## isInputFocused() Gap

Current implementation:
```typescript
function isInputFocused(): boolean {
  let el: Element | null = document.activeElement;  // ← Gets iframe element
  if (!el) return false;
  
  // Traverses shadow DOM but NOT iframe
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  
  const tag = el.tagName.toLowerCase();  // ← Would be 'iframe'
  // ... checks for input/textarea/select/contentEditable
  // iframe tag doesn't match, so returns false
  return false;  // ← No way to know if focus is inside iframe
}
```

When focus is in an iframe:
- `document.activeElement` returns the `<iframe>` element
- Function can't traverse into iframe (browser security)
- Function returns `false` (not focused on input)
- But shortcut handler never gets called anyway due to event isolation

---

## Key Code Locations for Debugging

| Problem | File | Lines |
|---------|------|-------|
| Cmd+K registration | Layout.tsx | 287-293 |
| Global handler | shortcuts.ts | 239 |
| Handler allowlist | shortcuts.ts | 71-88 |
| isInputFocused() | shortcuts.ts | 32-48 |
| FeedbackCompanion | FeedbackCompanionView.tsx | 1-17 |
| IframeCompanion | IframeCompanionView.tsx | 1-45 |
| Companion rendering | GlobalTerminalPanel.tsx | 430-456 |
| Companion CSS | app.css | 6704-6754 |
| isCompanion flag | state.ts | 8 |

