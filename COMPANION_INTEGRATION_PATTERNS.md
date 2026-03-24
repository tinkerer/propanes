# Companion Type Integration Patterns & Code Snippets

---

## Exact Code Patterns to Copy

### 1. How tabs.length === 0 works (Default Panel State)

**File**: `GlobalTerminalPanel.tsx` lines 661-674

```typescript
export function GlobalTerminalPanel() {
  const tabs = openTabs.value;
  
  // When no tabs open, panel is hidden (returns null)
  if (tabs.length === 0) {
    // But TerminalPicker can still render if user opened it
    if (termPickerOpen.value) {
      return (
        <TerminalPicker
          mode={termPickerOpen.value}
          onClose={() => { termPickerOpen.value = null; }}
        />
      );
    }
    // No tabs and no picker open → no visible panel
    return null;
  }

  // ... rest of panel rendering with tabs
}
```

**Implication for Admin Chat**:
- When there are no open sessions, an "Admin Chat" button could trigger:
  ```typescript
  toggleCompanion(someId, 'admin-chat')
  ```
  which would:
  1. Add the tab to `openTabs`
  2. Automatically show the panel (no longer tabs.length === 0)
  3. Open the companion in the right pane

---

### 2. Type Extraction Pattern

**File**: `sessions.ts` lines 2013-2019

```typescript
function extractCompanionType(tabId: string): CompanionType | null {
  const idx = tabId.indexOf(':');
  if (idx < 0) return null;  // Not a companion tab (e.g., plain session ID)
  
  const prefix = tabId.slice(0, idx);
  
  // Check against all known types
  if (prefix === 'jsonl' || prefix === 'feedback' || prefix === 'iframe' || 
      prefix === 'terminal' || prefix === 'isolate' || prefix === 'url') {
    return prefix;
  }
  
  return null;  // Unknown type
}
```

**To add admin-chat**:
```typescript
if (prefix === 'jsonl' || prefix === 'feedback' || prefix === 'iframe' || 
    prefix === 'terminal' || prefix === 'isolate' || prefix === 'url' ||
    prefix === 'admin-chat') {  // ← Add this
  return prefix;
}
```

---

### 3. Tab ID Creation Pattern

**File**: `sessions.ts` lines 2003-2005

```typescript
export function companionTabId(sessionId: string, type: CompanionType): string {
  return `${type}:${sessionId}`;
}

// Usage:
const tabId = companionTabId('sess-123', 'admin-chat');  // → 'admin-chat:sess-123'
```

**Session-less Companions**:
For companions not tied to a session (like standalone admin chat):
```typescript
// Option A: Use a fixed ID
const tabId = 'admin-chat:__global__';

// Option B: Use a placeholder
const tabId = companionTabId('admin', 'admin-chat');  // → 'admin-chat:admin'
```

---

### 4. renderTabContent() Dispatch Pattern

**File**: `GlobalTerminalPanel.tsx` lines 612-659

```typescript
function renderTabContent(
  sid: string,  // e.g., 'admin-chat:sess-123'
  isVisible: boolean,
  sessionMap: Map<string, any>,
  onExit: (exitCode: number, terminalText: string) => void,
) {
  // Parse tab ID prefix
  const isJsonl = sid.startsWith('jsonl:');
  const isFeedback = sid.startsWith('feedback:');
  const isIframe = sid.startsWith('iframe:');
  const isTerminal = sid.startsWith('terminal:');
  const isIsolate = sid.startsWith('isolate:');
  const isUrl = sid.startsWith('url:');
  const isCompanion = isJsonl || isFeedback || isIframe || isTerminal || isIsolate || isUrl;
  
  // Extract the actual identifier after the colon
  const realSid = isCompanion ? sid.slice(sid.indexOf(':') + 1) : sid;
  const sess = (isIsolate || isUrl) ? null : sessionMap.get(realSid);

  return (
    <div key={sid} style={{ display: isVisible ? 'flex' : 'none', width: '100%', flex: 1, minHeight: 0 }}>
      {isUrl ? (
        <IframeCompanionView url={realSid} />
      ) : isIsolate ? (
        <IsolateCompanionView componentName={realSid} />
      ) : isJsonl ? (
        <JsonlView sessionId={realSid} />
      ) : isFeedback ? (
        sess?.feedbackId ? <FeedbackCompanionView feedbackId={sess.feedbackId} /> : <div class="companion-error">No feedback linked</div>
      ) : isIframe ? (
        sess?.url ? <IframeCompanionView url={sess.url} /> : <div class="companion-error">No URL available</div>
      ) : isTerminal ? (
        (() => {
          const termSid = getTerminalCompanion(realSid);
          return termSid === '__loading__'
            ? <div class="companion-loading">Starting terminal...</div>
            : termSid ? <TerminalCompanionView companionSessionId={termSid} /> : <div class="companion-error">No companion terminal</div>;
        })()
      ) : (
        // Regular session (not a companion)
        <SessionViewToggle
          sessionId={sid}
          isActive={isVisible}
          onExit={onExit}
          onInputStateChange={(s) => setSessionInputState(sid, s)}
          permissionProfile={sessionMap.get(sid)?.permissionProfile}
          mode={getViewMode(sid)}
        />
      )}
    </div>
  );
}
```

**To add admin-chat**:
```typescript
const isAdminChat = sid.startsWith('admin-chat:');

// In the JSX section:
{isAdminChat ? (
  <AdminChatCompanionView sessionId={realSid} />
) : isUrl ? (
  <IframeCompanionView url={realSid} />
) : ...}
```

---

### 5. Opening a Companion Pattern

**File**: `sessions.ts` lines 2029-2075

```typescript
export function toggleCompanion(sessionId: string, type: CompanionType) {
  const current = getCompanions(sessionId);
  const tabId = companionTabId(sessionId, type);
  const isVisible = rightPaneTabs.value.includes(tabId) && splitEnabled.value;

  if (current.includes(type) && isVisible) {
    // Toggle OFF — only if actually visible
    const next = current.filter((t) => t !== type);
    if (next.length === 0) {
      const { [sessionId]: _, ...rest } = sessionCompanions.value;
      sessionCompanions.value = rest;
    } else {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: next };
    }
    persistCompanions();

    // Clean up terminal companion map when toggling off
    if (type === 'terminal') {
      removeTerminalCompanion(sessionId);
    }

    // Close the tab from right pane
    const remaining = rightPaneTabs.value.filter((id) => id !== tabId);
    rightPaneTabs.value = remaining;
    if (rightPaneActiveId.value === tabId) {
      rightPaneActiveId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    if (remaining.length === 0 && splitEnabled.value) {
      disableSplit();
      return;
    }
    persistSplitState();
    if (openTabs.value.includes(tabId)) {
      openTabs.value = openTabs.value.filter((id) => id !== tabId);
      persistTabs();
    }
  } else {
    // Toggle ON (or re-open if registered but not visible)
    if (!current.includes(type)) {
      sessionCompanions.value = { ...sessionCompanions.value, [sessionId]: [...current, type] };
      persistCompanions();
    }
    openSessionInRightPane(tabId);  // ← This makes the magic happen
  }
}
```

**What `openSessionInRightPane()` does**:
- Adds tab to `rightPaneTabs`
- Enables split view (`splitEnabled.value = true`)
- Sets the tab as active
- Adds to `openTabs` if needed
- Persists state

---

### 6. Floating Popover Position Clamping (SetupAssistButton Pattern)

**File**: `SetupAssistButton.tsx` lines 84-116

```typescript
function clampToViewport(x: number, y: number, w: number, h: number) {
  const pad = 8;  // Padding from edges
  return {
    x: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
    y: Math.max(pad, Math.min(y, window.innerHeight - h - pad)),
  };
}

function SetupAssistPopover({ ... }) {
  // Position near trigger, clamped to viewport
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const pw = 340;  // Popover width
    const ph = el.offsetHeight || 260;  // Popover height
    
    // Try to center horizontally on trigger, prefer above
    let x = trigger.left + trigger.width / 2 - pw / 2;
    let y = trigger.top - ph - 8;
    
    // If no room above, go below
    if (y < 8) y = trigger.bottom + 8;
    
    const clamped = clampToViewport(x, y, pw, ph);
    el.style.left = `${clamped.x}px`;
    el.style.top = `${clamped.y}px`;
    el.style.visibility = 'visible';
  }, [triggerRef]);
}
```

---

### 7. Session Companions Storage Pattern

**File**: `sessions.ts` lines 1996-2027

```typescript
// Signal: maps sessionId → array of companion types
export const sessionCompanions = signal<Record<string, CompanionType[]>>(
  loadJson('pw-session-companions', {})
);

function persistCompanions() {
  localStorage.setItem('pw-session-companions', JSON.stringify(sessionCompanions.value));
}

export function getCompanions(sessionId: string): CompanionType[] {
  return sessionCompanions.value[sessionId] || [];
}

// Example state:
// {
//   'sess-abc': ['jsonl', 'terminal'],
//   'sess-def': ['feedback', 'admin-chat'],
// }
```

**Accessing companions**:
```typescript
// Get all companions for a session
const companions = getCompanions('sess-123');  // → ['jsonl', 'terminal']

// Check if a specific companion is active
if (companions.includes('admin-chat')) {
  // admin-chat is registered for this session
}

// Add a companion
sessionCompanions.value = {
  ...sessionCompanions.value,
  'sess-123': [...companions, 'admin-chat']
};
persistCompanions();
```

---

### 8. SetupAssistButton Submit Pattern

**File**: `SetupAssistButton.tsx` lines 158-176

```typescript
function submit(requestText?: string) {
  const finalText = requestText || text.trim();
  if (!finalText || submitting) return;
  
  onClose();  // Close popover immediately
  
  // Fire-and-forget: async load session when ready
  (async () => {
    try {
      const { sessionId } = await api.setupAssist({
        request: finalText,
        entityType,
        ...(entityId ? { entityId } : {}),
      });
      await loadAllSessions();  // Refresh session list
      openSession(sessionId);   // Open the new session in panel
    } catch (err: any) {
      console.error('Admin Assist failed:', err.message);
    }
  })();
}
```

---

## Companion Component Template

### Basic Structure

```typescript
// File: packages/admin/src/components/AdminChatCompanionView.tsx

import { useEffect, useRef, useState } from 'preact/hooks';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export function AdminChatCompanionView({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    if (!inputText.trim() || submitting) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: inputText,
      timestamp: Date.now(),
    };

    setMessages([...messages, userMessage]);
    setInputText('');
    setSubmitting(true);

    try {
      // Call API or LLM here
      const response = await fetch('/api/admin-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: inputText, sessionId }),
      });

      const { reply } = await response.json();
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: reply,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: any) {
      console.error('Chat error:', err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="admin-chat-companion" style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      background: 'var(--pw-bg)',
      borderLeft: '1px solid var(--pw-border)',
    }}>
      {/* Messages */}
      <div class="admin-chat-messages" style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        {messages.map((msg) => (
          <div
            key={msg.timestamp}
            style={{
              textAlign: msg.role === 'user' ? 'right' : 'left',
              marginBottom: '8px',
            }}
          >
            <div style={{
              display: 'inline-block',
              maxWidth: '80%',
              padding: '8px 12px',
              borderRadius: '6px',
              background: msg.role === 'user' 
                ? 'var(--pw-primary)' 
                : 'var(--pw-bg-alt)',
              color: msg.role === 'user'
                ? 'var(--pw-bg)'
                : 'var(--pw-text)',
              fontSize: '13px',
            }}>
              {msg.content}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        borderTop: '1px solid var(--pw-border)',
        padding: '8px',
        display: 'flex',
        gap: '4px',
      }}>
        <input
          type="text"
          placeholder="Ask something..."
          value={inputText}
          onInput={(e) => setInputText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              sendMessage();
            }
          }}
          disabled={submitting}
          style={{
            flex: 1,
            padding: '6px 8px',
            fontSize: '12px',
            border: '1px solid var(--pw-border)',
            borderRadius: '4px',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!inputText.trim() || submitting}
          style={{
            padding: '6px 12px',
            background: 'var(--pw-primary)',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          {submitting ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
```

---

## Integration Checklist

- [ ] Add `'admin-chat'` to `CompanionType` union in `sessions.ts:1954`
- [ ] Update `extractCompanionType()` in `sessions.ts:2017`
- [ ] Create `AdminChatCompanionView.tsx`
- [ ] Import in `GlobalTerminalPanel.tsx`
- [ ] Add type check + rendering in `renderTabContent()` (lines 618-659)
- [ ] Import in `PopoutPanel.tsx`
- [ ] Add same type check + rendering in PopoutPanel's `renderTabContent()`
- [ ] Add button to trigger: `toggleCompanion(sessionId, 'admin-chat')`
- [ ] Test with: `toggleCompanion('sess-test', 'admin-chat')` in browser console

---
