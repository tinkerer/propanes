# Cmd+K Keyboard Shortcut - Complete Code Path Analysis

## 1. REGISTRATION PHASE

### Location: Layout.tsx:287-293

```typescript
registerShortcut({
  key: 'k',
  modifiers: { meta: true },
  label: 'Spotlight search',
  category: 'General',
  action: () => setShowSpotlight((v) => !v),
}),
```

**What happens:**
- Called during `useEffect(() => { const cleanups = [ registerShortcut(...), ... ]; return () => cleanups.forEach(f => f()); }, []);` (line 259)
- Shortcut pushed into `registry` array in shortcuts.ts
- Returns cleanup function that will unregister on component unmount

---

## 2. HANDLER INSTALLATION

### Location: shortcuts.ts:239-241

```typescript
// Install global handler
// Capture phase so we intercept before xterm.js processes the event
document.addEventListener('keydown', (e) => { 
  handleStickyShortcut(e); 
  if (stickyMode) { handleStickyKeys(e); return; } 
  updateCtrlShift(e); 
  handleKeyDown(e); 
}, true);  // ← CAPTURE PHASE

document.addEventListener('keyup', handleStickyKeyUp, true);
window.addEventListener('blur', clearCtrlShift);
```

**Key details:**
- Third parameter `true` = capture phase (before bubbling)
- Theoretically should catch events from anywhere in document tree
- **BUT: This only works for events in the parent document**
- **iframe events are isolated and never reach parent's document listener**

---

## 3. EVENT RECEPTION (THE PROBLEM)

### When user presses Cmd+K in normal context:

```
Cmd+K pressed in parent document
  ↓
Browser fires keydown event on focused element
  ↓
Event bubbles up through DOM tree
  ↓
CAPTURE PHASE listener intercepts (line 239)
  ↓
handleStickyShortcut(e) runs
  ↓
(not a shift-tap, returns)
  ↓
updateCtrlShift(e) runs
  ↓
handleKeyDown(e) runs ← MAIN HANDLER
```

### When user presses Cmd+K inside companion iframe:

```
Cmd+K pressed inside <iframe>
  ↓
Browser fires keydown event in IFRAME'S document context
  ↓
Event is isolated within iframe's DOM tree
  ↓
Parent document's CAPTURE PHASE listener DOES NOT receive this event
  ↓
(browser security boundary - events don't cross iframe boundary)
  ↓
handleKeyDown(e) NEVER RUNS
  ↓
Spotlight doesn't open
```

---

## 4. MAIN HANDLER LOGIC

### Location: shortcuts.ts:65-137

```typescript
function handleKeyDown(e: KeyboardEvent) {
  if (!shortcutsEnabled.value) return;  // Early return if disabled
  
  const code = normalizeCode(e.code);
  const ctrlOrMeta = stickyMode || e.ctrlKey || e.metaKey;  // ← Detects Cmd
  const shiftHeld = stickyMode || e.shiftKey;
  const inXterm = !!document.activeElement?.closest?.('.xterm');
  
  // CRITICAL: This check runs regardless of whether we're in iframe
  if (!stickyMode && isInputFocused() && (e.key !== 'Escape' || inXterm)) {
    // Allow-list for shortcuts that work even when input is focused
    if (ctrlOrMeta && shiftHeld && e.code === 'Space') { /* allow through */ }
    else if (ctrlOrMeta && e.key === 'k') { /* allow through */ }  // ← Cmd+K allowed
    else {
      // ... other checks ...
      return; // EXIT - don't process shortcut
    }
  }

  // Handle sequence starters (e.g., 'g' for 'g f')
  const sequenceStarters = new Set(...);
  if (sequenceStarters.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const directMatch = registry.find(s => !s.sequence && s.key === e.key && matchesModifiers(e, s.modifiers));
    if (!directMatch) {
      e.preventDefault();
      pendingSequence = e.key;
      sequenceTimer = setTimeout(clearSequence, 1000);
      return;
    }
  }

  // MATCH SHORTCUT IN REGISTRY
  for (const s of registry) {
    if (s.sequence) continue;  // Skip sequence shortcuts
    const keyMatch = s.code ? s.code === code : s.key === e.key;
    if (keyMatch && matchesModifiers(e, s.modifiers)) {
      e.preventDefault();
      e.stopPropagation();
      s.action();  // ← EXECUTE: setShowSpotlight((v) => !v)
      return;
    }
  }
}
```

**The allow-list check (lines 71-88):**
- When `isInputFocused()` returns true AND you're typing in something
- Most shortcuts are blocked (to not interfere with text input)
- **EXCEPT** Cmd+k is explicitly allowed (line 74)
- This means: Cmd+K works even when typing in input fields

**But this is moot if the event never reaches this function in the first place!**

---

## 5. HELPER: isInputFocused()

### Location: shortcuts.ts:32-48

```typescript
function isInputFocused(): boolean {
  let el: Element | null = document.activeElement;  // ← Gets active element
  if (!el) return false;
  
  // Traverse into shadow roots (handles web components)
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable) {
    return true;
  }
  
  // xterm.js terminals live inside .xterm containers
  if (el.closest?.('.xterm')) return true;
  
  return false;
}
```

**When focus is in companion iframe:**
- `document.activeElement` = the `<iframe>` element itself
- Can't traverse into iframe (browser security)
- `el.tagName.toLowerCase()` = 'iframe'
- Doesn't match input/textarea/select
- Returns `false`

**This means:**
- Function correctly reports "not in an input"
- But it has no way to detect "inside an iframe"
- Doesn't matter because event never reaches this function anyway

---

## 6. HELPER: matchesModifiers()

### Location: shortcuts.ts:50-58

```typescript
function matchesModifiers(e: KeyboardEvent, mods?: Shortcut['modifiers']): boolean {
  const ctrl = mods?.ctrl || false;
  const shift = mods?.shift || false;
  const alt = mods?.alt || false;
  const meta = mods?.meta || false;
  const eCtrl = stickyMode || e.ctrlKey;
  const eShift = stickyMode || e.shiftKey;
  // Note: ignores e.metaKey in stickyMode comparison, but checks it directly
  return eCtrl === ctrl && eShift === shift && e.altKey === alt && e.metaKey === meta;
}
```

**For Cmd+K shortcut:**
- Expected: `{ meta: true }` (no ctrl, no shift, no alt)
- On macOS when user presses Cmd+K:
  - `e.metaKey = true` ✓
  - `e.ctrlKey = false` ✓
  - `e.shiftKey = false` ✓
  - `e.altKey = false` ✓
- Result: Modifiers match, shortcut would execute

**But again, only if event reaches this function!**

---

## 7. SPOTLIGHT TOGGLE

### Location: Layout.tsx:195, 277

```typescript
// State
const [showSpotlight, setShowSpotlight] = useState(false);

// Handler
registerShortcut({
  key: 'k',
  modifiers: { meta: true },
  label: 'Spotlight search',
  category: 'General',
  action: () => setShowSpotlight((v) => !v),  // ← TOGGLE
}),

// Close on Escape
registerShortcut({
  key: 'Escape',
  label: 'Close modal',
  category: 'General',
  action: () => { setShowShortcutHelp(false); setShowSpotlight(false); },
}),

// Render
{showSpotlight && <SpotlightSearch onClose={() => setShowSpotlight(false)} />}
```

**When shortcut executes:**
1. `setShowSpotlight((v) => !v)` flips state
2. Component re-renders with `showSpotlight = true`
3. Spotlight modal appears
4. User can search

---

## 8. SPOTLIGHT SEARCH COMPONENT

### Location: SpotlightSearch.tsx:128-154

The spotlight component itself handles Escape and arrow keys:

```typescript
function handleKeyDown(e: KeyboardEvent) {
  const showingRecent = !query && recentResults.value.length > 0;
  const listLen = showingRecent ? recentResults.value.length : results.length;
  if (e.key === 'Escape') {
    e.preventDefault();
    onClose();  // ← Close spotlight
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSelectedIndex((i) => Math.min(i + 1, listLen - 1));
  } else if (e.key === 'ArrowUp') {
    // ...
  } else if (e.key === 'Enter') {
    // ...
  }
}
```

**This listener is attached to the input element inside the spotlight modal**
- Only handles Escape, Arrow, Enter
- Doesn't interfere with global shortcuts

---

## SUMMARY: Why Cmd+K Fails in iframe

### The Chain of Failure:

```
1. FeedbackCompanionView renders an <iframe> in the DOM
2. iframe has its own document context and event system
3. User clicks inside iframe, focus moves to iframe
4. User presses Cmd+K
5. Browser fires keydown event in IFRAME'S document
6. Parent's document.addEventListener('keydown', ...) DOES NOT receive this event
   (fundamental browser security boundary)
7. handleKeyDown() is never called
8. matchesModifiers() is never called
9. Registry search is never executed
10. setShowSpotlight() is never called
11. Spotlight modal never opens
12. User sees no visual feedback - silent failure
```

### The "Allow-list" is Irrelevant:

The fact that Cmd+K is on the allow-list (line 74) doesn't matter because:
- Allow-list only matters IF the handler runs
- Handler doesn't run because event never reaches parent document
- It's like having a security check on a door that's never opened

---

## Files Involved in the Problem

| File | Role | Key Code |
|------|------|----------|
| Layout.tsx | Registers shortcut | Lines 287-293 |
| shortcuts.ts | Global handler | Lines 239, 65-137 |
| FeedbackCompanionView.tsx | Creates iframe | Lines 10-16 |
| GlobalTerminalPanel.tsx | Renders companion | Lines 430-456 |
| state.ts | Detects companion mode | Line 8 |
| app.css | Styles companion | Lines 6704-6754 |

---

## Why Console Shows No Errors

- No exceptions thrown
- Listener is properly registered
- Handler logic is correct
- Event just never fires in parent context
- Completely silent failure

This is why it's hard to debug without understanding iframe event isolation!

