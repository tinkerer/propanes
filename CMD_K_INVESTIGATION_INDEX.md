# Cmd+K Search Issue - Complete Investigation Index

## Overview

This investigation analyzes why Cmd+K (Command+K) search fails when the feedback companion panel has focus in the admin UI. The issue is caused by **iframe event isolation** - a browser security boundary that prevents keyboard events from crossing between parent and iframe documents.

## Documents in This Investigation

### 1. **CMD_K_ISSUE_SUMMARY.txt** (START HERE)
   - Plain text format for quick reading
   - Executive summary of the problem
   - Key findings in 3 points
   - Testing procedures
   - Why it's hard to diagnose
   
   **Best for**: Getting a quick overview without diving into code

### 2. **CMD_K_ANALYSIS.md** (TECHNICAL DEEP DIVE)
   - Executive summary with code snippets
   - Cmd+K handler registration (Layout.tsx:287-293)
   - Global keyboard handler (shortcuts.ts:239)
   - iframe boundary isolation explanation
   - Input focus detection gap
   - Why the allow-list is irrelevant
   - Solution approaches (4 options)
   - Files affected
   - Behavior table
   
   **Best for**: Understanding the technical details and seeing code in context

### 3. **CMD_K_CODE_PATHS.md** (COMPLETE EXECUTION TRACE)
   - Step-by-step code path from registration to execution
   - 8 phases of the Cmd+K shortcut system:
     1. Registration (Layout.tsx)
     2. Handler installation (shortcuts.ts)
     3. Event reception (the problem)
     4. Main handler logic
     5. isInputFocused() helper
     6. matchesModifiers() helper
     7. Spotlight toggle
     8. SpotlightSearch component
   - Why console shows no errors
   - Complete chain of failure
   
   **Best for**: Tracing exactly where the shortcut execution breaks

### 4. **COMPANION_IFRAME_ARCHITECTURE.md** (SYSTEM DESIGN)
   - Where companions are rendered
   - Three types of companion views:
     - FeedbackCompanionView (self-referential admin page)
     - IframeCompanionView (external URLs)
     - TerminalCompanionView (no iframe)
   - Companion mode detection (isCompanion flag)
   - Session decision tree
   - Event flow diagrams
   - isInputFocused() gap
   - Key code locations
   
   **Best for**: Understanding how the companion system works and why it causes the problem

### 5. **CMD_K_VISUAL_DIAGRAMS.md** (VISUAL EXPLANATIONS)
   - 9 detailed ASCII diagrams:
     1. Event isolation boundary
     2. Companion panel layout
     3. Working vs broken event flows
     4. Component rendering decision tree
     5. Shortcut handler call stack
     6. iframe nesting diagram
     7. Focus state explanation
     8. Allow-list context
     9. postMessage solution diagram
   
   **Best for**: Visual learners who want to see the architecture and flow

## Quick Navigation

### I want to understand...

**...the root cause**
→ Start with `CMD_K_ISSUE_SUMMARY.txt` ("THE PROBLEM IN 3 POINTS" section)

**...why other shortcuts don't fail**
→ See `CMD_K_ANALYSIS.md` ("Why Other Shortcuts Work From iframe" section)

**...what the allow-list does**
→ See `CMD_K_CODE_PATHS.md` (section 4 & section "The Allow-list is Irrelevant")

**...how the companion system works**
→ See `COMPANION_IFRAME_ARCHITECTURE.md` ("Companion View Architecture" section)

**...the exact code path**
→ See `CMD_K_CODE_PATHS.md` (8 sections detailing each phase)

**...event flow visually**
→ See `CMD_K_VISUAL_DIAGRAMS.md` (sections 1 & 3)

**...how to fix it**
→ See `CMD_K_ANALYSIS.md` ("Solution Approaches" section, Option 1 recommended)

## Key Files in the Codebase

| Feature | File | Lines | Purpose |
|---------|------|-------|---------|
| Cmd+K Registration | Layout.tsx | 287-293 | Register shortcut with meta+k |
| Global Handler | shortcuts.ts | 239-241 | Install keydown listener |
| Handler Logic | shortcuts.ts | 65-137 | Process keyboard events |
| Allow-list | shortcuts.ts | 71-88 | Allow Cmd+K from any context |
| Input Detection | shortcuts.ts | 32-48 | Check if input is focused |
| Modifier Matching | shortcuts.ts | 50-58 | Check if modifiers match |
| Feedback Companion | FeedbackCompanionView.tsx | 10-16 | Render admin page in iframe |
| URL Companion | IframeCompanionView.tsx | 35-41 | Render external URL in iframe |
| Rendering Logic | GlobalTerminalPanel.tsx | 430-456 | Decide which companion to show |
| Companion Flag | state.ts | 8 | Detect companion mode |
| Companion CSS | app.css | 6704-6754 | Style companion views |

## The Problem Explained (One Paragraph)

The Cmd+K keyboard shortcut is registered correctly and the global keyboard handler is properly installed in capture phase. However, when the feedback companion panel (which is an iframe) has focus, keyboard events from inside the iframe are isolated to that iframe's document context by browser security boundaries. The parent document's `document.addEventListener('keydown', ...)` never receives these events, so the global handler never runs, and the spotlight search never opens. The Cmd+K allow-list (which permits Cmd+K even when typing in inputs) is irrelevant because the handler is never invoked in the first place. The fix requires cross-document communication via postMessage to bridge the event isolation boundary.

## Testing the Issue

### Test 1: Cmd+K works (parent document)
1. Click on main page (outside companion iframe)
2. Press Cmd+K
3. Expected: Spotlight opens ✓

### Test 2: Cmd+K works in input (parent document)
1. Click in a text input on main page
2. Press Cmd+K
3. Expected: Spotlight still opens ✓ (on allow-list)

### Test 3: Cmd+K fails (companion iframe)
1. Click inside the companion iframe panel
2. Press Cmd+K
3. Expected: Spotlight should open but... FAILS ✗

### Test 4: Other shortcuts also fail (companion iframe)
1. Click inside companion iframe
2. Press Ctrl+Shift+W (close tab)
3. Expected: ALSO FAILS ✗ (same root cause)

## Solution

The recommended fix is **Option 1: Message-Based Communication**:

```javascript
// Inside iframe
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'k') {
    e.preventDefault();
    window.parent.postMessage({ type: 'pw-cmd-k' }, '*');
  }
});

// In parent (Layout.tsx)
window.addEventListener('message', (e) => {
  if (e.data?.type === 'pw-cmd-k') {
    setShowSpotlight((v) => !v);
  }
});
```

This approach:
- Works with sandboxed iframes
- Doesn't require removing security restrictions
- Bridges the event isolation boundary
- Can be extended for other shortcuts

## Key Insights

1. **Event isolation is a feature, not a bug** - it's a browser security boundary
2. **The allow-list is irrelevant when event never reaches handler**
3. **This affects ALL keyboard shortcuts from iframe**, not just Cmd+K
4. **No console errors** - completely silent failure makes it hard to diagnose
5. **Shadow DOM traversal exists but not iframe traversal** - function gap
6. **Companion is self-referential iframe** - runs App.tsx again inside iframe

## Related Code Concepts

- **Capture Phase** (shortcuts.ts:239) - Third parameter `true` means capture, not bubble
- **isInputFocused()** (shortcuts.ts:32-48) - Helper that can traverse shadow DOM but not iframe
- **Modifier Matching** (shortcuts.ts:50-58) - Checks ctrlKey, metaKey, shiftKey, altKey
- **Spotlight Toggle** (Layout.tsx:195) - State that controls search modal visibility
- **isCompanion Flag** (state.ts:8) - URL parameter that triggers companion mode
- **Companion Mode CSS** (app.css:6276) - Removes chrome from companion pages

## Document Statistics

- **Total Analysis Documents**: 5
- **Total Size**: ~48 KB
- **Code Examples**: 40+
- **Diagrams**: 9
- **Detailed Explanations**: 100+

---

**Created**: March 2, 2026  
**Investigation Focus**: Keyboard shortcut isolation in iframe environments  
**Status**: Analysis complete - root cause identified, solutions documented
