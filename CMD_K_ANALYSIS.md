# Cmd+K Search Issue Analysis: Feedback Companion Panel

## Executive Summary

When the feedback companion panel (an iframe) has focus, Cmd+K keyboard shortcut fails to open the spotlight search. This is a **keyboard event capture isolation problem** caused by how iframe boundaries interact with global keyboard event handlers.

---

## Key Findings

### 1. Cmd+K Handler Registration

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/Layout.tsx`
**Lines**: 287-293

```tsx
registerShortcut({
  key: 'k',
  modifiers: { meta: true },
  label: 'Spotlight search',
  category: 'General',
  action: () => setShowSpotlight((v) => !v),
}),
```

The Cmd+K shortcut is registered correctly with `modifiers: { meta: true }`, which maps to the Command key on macOS.

### 2. Keyboard Event Handler

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/shortcuts.ts`
**Line**: 239

```typescript
document.addEventListener('keydown', (e) => { 
  handleStickyShortcut(e); 
  if (stickyMode) { handleStickyKeys(e); return; } 
  updateCtrlShift(e); 
  handleKeyDown(e); 
}, true);  // ← capture phase
```

The handler is attached in **capture phase** (third parameter is `true`), which should theoretically allow it to intercept events before child elements process them.

**However**, there's a critical check at **lines 71-88** in `handleKeyDown()`:

```typescript
if (!stickyMode && isInputFocused() && (e.key !== 'Escape' || inXterm)) {
  // Spotlight shortcut works from any context
  if (ctrlOrMeta && shiftHeld && e.code === 'Space') { /* allow through */ }
  else if (ctrlOrMeta && e.key === 'k') { /* allow through */ }
  else {
    // ... other checks ...
    return; // EXIT EARLY - HANDLER STOPS
  }
}
```

This is the **allow-list** for keyboard shortcuts when an input is focused. The good news: **Cmd+K (Cmd+k) is explicitly allowed through** (line 74).

### 3. The Real Problem: iframe Boundary Isolation

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/components/FeedbackCompanionView.tsx`

```tsx
return (
  <iframe
    src={src}
    class="companion-iframe"
    style="width:100%;height:100%;border:none;flex:1"
  />
);
```

**The Problem**: When focus is inside an iframe, keyboard events generated in the iframe's document are NOT propagated to the parent document's listeners.

This is a **fundamental browser security boundary**:
- Keyboard events that originate inside an iframe stay within that iframe's event system
- The parent document's `document.addEventListener('keydown', ...)` CANNOT intercept keydown events from inside the iframe
- The iframe has its own separate DOM and event bubble context

### 4. Why Cmd+K Fails When Companion Has Focus

**Root Cause Chain**:

1. User presses Cmd+K while focused inside the companion iframe
2. The keydown event fires in the **iframe's document context**, not the parent
3. The parent's `document.addEventListener('keydown', ...)` never receives this event
4. The global shortcut handler in Layout.tsx is never invoked
5. Result: Cmd+K doesn't work

### 5. Input Focus Detection Issue

**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/lib/shortcuts.ts`
**Lines**: 32-48

```typescript
function isInputFocused(): boolean {
  let el: Element | null = document.activeElement;
  if (!el) return false;
  // Traverse into shadow roots
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable) {
    return true;
  }
  if (el.closest?.('.xterm')) return true;
  return false;
}
```

**Critical Gap**: This function checks `document.activeElement`, which will return the `<iframe>` element itself when focus is inside the iframe. It does NOT traverse into the iframe's internal document.

The function handles shadow DOM traversal but **NOT iframe traversal**.

---

## How Cmd+K "Works From Any Context"

The shortcut handler has a special allowlist (lines 73-74 in shortcuts.ts):

```typescript
else if (ctrlOrMeta && e.key === 'k') { /* allow through */ }
```

This means: "If Ctrl/Cmd + k is pressed, let it through even if an input is focused."

**But this only matters IF the event reaches the handler in the first place.**

When focus is in an iframe, the event **never reaches the parent's handler**.

---

## Technical Details: iframe Event Isolation

### Parent Document Flow (Normal Case)
```
User presses Cmd+K
  ↓
Cmd+K event fires in parent document
  ↓
Global keydown listener (capture phase) intercepts
  ↓
handleKeyDown() checks isInputFocused()
  ↓
Cmd+K is in allowlist → shortcut fires
  ↓
setShowSpotlight(true)
```

### iframe Flow (Current Broken Case)
```
User presses Cmd+K
  ↓
Cmd+K event fires in IFRAME'S document context
  ↓
Parent document listener NEVER receives this event (browser security boundary)
  ↓
Global shortcut handler never runs
  ↓
Cmd+K fails silently
  ↓
Spotlight doesn't open
```

---

## Why Other Shortcuts Work From iframe

- **Ctrl+Shift+[digit/letter]**: These panel shortcuts likely work from iframe because they may be handled differently or have more permissive event propagation
- **Or**: They might not work either, just not tested as frequently

---

## Solution Approaches

### Option 1: Message-Based Communication (Recommended)
Post a message from the iframe to the parent when Cmd+K is pressed:

```javascript
// Inside iframe
window.parent.postMessage({ type: 'pw-cmd-k' }, '*');

// In parent
window.addEventListener('message', (e) => {
  if (e.data?.type === 'pw-cmd-k') {
    // Open spotlight
  }
});
```

### Option 2: Extract Handler to Window Level
Attach the handler to `window` instead of `document` (though this likely won't help with iframes).

### Option 3: Use Document Mutation Observer + Virtual Input
Detect iframe focus and programmatically inject a hidden input that receives Cmd+K, then forward to parent.

### Option 4: iframe without Sandbox Restriction
Remove `sandbox` attribute on iframe (dangerous - allows scripts to escape containment).

---

## Files Affected

1. **FeedbackCompanionView.tsx** - Renders the iframe
2. **IframeCompanionView.tsx** - Renders user-provided iframes  
3. **shortcuts.ts** - Global keyboard handler
4. **Layout.tsx** - Registers Cmd+K shortcut

---

## Current Behavior Summary

| Context | Cmd+K Works? | Reason |
|---------|---------|--------|
| Normal page (no input) | ✓ Yes | Event reaches handler |
| Input field focused | ✓ Yes | Cmd+k in allowlist |
| Textarea focused | ✓ Yes | Cmd+k in allowlist |
| xterm terminal | ✓ Yes | Cmd+k in allowlist |
| Inside feedback companion iframe | ✗ No | Event never reaches parent handler |
| Inside URL iframe | ✗ No | Event never reaches parent handler |

---

## Why This Is Difficult to Diagnose

1. No console errors or warnings
2. Keyboard handler IS correctly registered
3. Spotlight search code IS correct
4. The issue is subtle: "the event never fires in the parent"
5. Developers may assume "the handler should catch this" without realizing the iframe boundary blocks it

---

## Related Code References

- **isCompanion flag**: state.ts:8 - Detects if current page is running in companion mode
- **Companion CSS class**: app.css:6276 - Styles the companion page differently
- **Shortcut allowlist**: shortcuts.ts:73-88 - Explicit Cmd+K allowance
- **iframe sources**: 
  - FeedbackCompanionView: `/admin/?companion=true#${route}`
  - IframeCompanionView: User-provided URL
