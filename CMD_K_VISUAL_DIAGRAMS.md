# Visual Diagrams: Cmd+K Issue and iframe Architecture

## 1. Event Isolation Boundary

```
┌──────────────────────────────────────────────────────────┐
│                  PARENT DOCUMENT                         │
│                                                          │
│  ┌─ shortcuts.ts ──────────────────────────────────┐   │
│  │ document.addEventListener('keydown', handler)  │   │
│  │ (capture phase, line 239)                       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  This handler receives:                                 │
│  ✓ Keydowns from main page                             │
│  ✓ Keydowns from input fields                          │
│  ✓ Keydowns from shadow DOM elements                   │
│  ✗ Keydowns from iframe (BLOCKED by browser)          │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │        <iframe> ISOLATION BOUNDARY ━━━━━━━━━     │   │
│  │                                                   │   │
│  │    ┌────────────────────────────────────────┐    │   │
│  │    │    IFRAME'S INTERNAL DOCUMENT          │    │   │
│  │    │                                        │    │   │
│  │    │  Keydown event fires HERE:             │    │   │
│  │    │  User presses Cmd+K                    │    │   │
│  │    │  Event stays in iframe's context      │    │   │
│  │    │  Parent listener does NOT get it      │    │   │
│  │    │                                        │    │   │
│  │    └────────────────────────────────────────┘    │   │
│  │                                                   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## 2. Companion Panel Layout

```
┌─────────────────────────────────────────────────────────┐
│  ADMIN PAGE (Layout.tsx)                                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Sidebar with app list, tabs, navigation       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Main content area (FeedbackDetailPage)         │   │
│  │  Shows feedback, title, description, status    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  GlobalTerminalPanel (bottom panel)             │   │
│  │  ┌──────────────────────────────────────────┐   │   │
│  │  │  Tabs: [Session 1] [Session 2] ...       │   │   │
│  │  ├──────────────────────────────────────────┤   │   │
│  │  │                                          │   │   │
│  │  │  ← Companion View (renders here)         │   │   │
│  │  │  If feedbackId → FeedbackCompanionView   │   │   │
│  │  │  If url → IframeCompanionView            │   │   │
│  │  │  If terminal → TerminalCompanionView     │   │   │
│  │  │                                          │   │   │
│  │  │  <iframe> ← THE PROBLEM                  │   │   │
│  │  │  User clicks here → loses Cmd+K          │   │   │
│  │  │                                          │   │   │
│  │  └──────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 3. Keyboard Event Flow: Working vs Broken

### WORKING: Cmd+K in main page

```
User presses Cmd+K (in parent document)
          ↓
Browser: "fire keydown event"
          ↓
Event targets focused element (e.g., page body)
          ↓
CAPTURE PHASE listeners execute (line 239 in shortcuts.ts)
          ↓
handleStickyShortcut(e)
          ↓
updateCtrlShift(e)
          ↓
handleKeyDown(e)
  │
  ├─ Check: isInputFocused()? → false (no input focused)
  │
  ├─ Loop through registry
  │
  ├─ Find: key='k' && metaKey=true
  │
  └─ Execute: setShowSpotlight((v) => !v)
          ↓
Component re-renders
          ↓
SpotlightSearch modal appears
          ↓
✓ SUCCESS
```

### BROKEN: Cmd+K in iframe

```
User presses Cmd+K (inside iframe)
          ↓
Browser fires keydown event in IFRAME'S DOCUMENT CONTEXT
          ↓
Event is scoped to iframe's DOM
          ↓
CAPTURE PHASE listener in parent document:
  "Listener waits for parent document events"
          ↓
Parent's listener DOES NOT receive this event
(Browser security boundary prevents it)
          ↓
handleKeyDown(e) is NEVER CALLED
          ↓
No shortcut lookup happens
          ↓
No state change
          ↓
No modal appears
          ↓
✗ SILENT FAILURE - no console error
```

## 4. Component Rendering Decision Tree

```
GlobalTerminalPanel.tsx:430-456

Start: Have active session?
  │
  ├─ Is it a JSON Lines session?
  │  └─ Render: JsonlView
  │
  ├─ Is permissionProfile = 'feedback'?
  │  └─ Has feedbackId?
  │     ├─ Yes: Render FeedbackCompanionView (← PROBLEM)
  │     │        ↓
  │     │        <iframe src="/admin/?companion=true#/app/xyz/feedback/123" />
  │     │
  │     └─ No: Show "No feedback linked"
  │
  ├─ Is permissionProfile = 'plain'?
  │  └─ Has url?
  │     ├─ Yes: Render IframeCompanionView (← ALSO HAS PROBLEM)
  │     │        ↓
  │     │        <iframe src="https://example.com" sandbox="..." />
  │     │
  │     └─ No: Show "No URL available"
  │
  ├─ Is permissionProfile = 'terminal'?
  │  └─ Render: TerminalCompanionView (no iframe, NO PROBLEM)
  │
  └─ Default:
     └─ Render: SessionViewToggle (normal terminal view)
```

## 5. Shortcut Handler Call Stack

```
document keydown event (line 239)
  ↓
(e) => {
  handleStickyShortcut(e)           ← Shift+Shift+Shift detection
    ├─ if (e.key !== 'Shift') return
    ├─ Count shift taps
    └─ If 3+ taps in 800ms → enter stickyMode
  
  if (stickyMode) {                 ← In "sticky" mode?
    handleStickyKeys(e)             ← Process as Ctrl+Shift combo
    return
  }
  
  updateCtrlShift(e)                ← Update Ctrl+Shift held signal
    └─ ctrlShiftHeld.value = e.ctrlKey && e.shiftKey
  
  handleKeyDown(e)                  ← MAIN HANDLER ← Where Cmd+K is processed
    │
    ├─ isInputFocused()?
    │  └─ If yes, check allow-list
    │     └─ Cmd+K is on allow-list (line 74)
    │
    ├─ matchModifiers(e, s.modifiers)?
    │  └─ For Cmd+K: needs metaKey=true, ctrlKey=false, shiftKey=false
    │
    └─ Execute s.action() → setShowSpotlight((v) => !v)
}
```

## 6. iframe Companion View Nesting

```
PARENT ADMIN PAGE
  ↓
  App.tsx
    ├─ If isEmbedded → Show as embed (no Layout)
    ├─ If isCompanion → Show content only (no Layout)
    └─ Else → Wrap in Layout
         │
         ├─ Layout
         │  ├─ Sidebar
         │  ├─ Main content
         │  └─ GlobalTerminalPanel
         │     ├─ Tabs
         │     └─ Current tab renders...
         │
         ├─ WHEN user clicks on feedback tab with feedbackId:
         │
         └─ FeedbackCompanionView
            └─ <iframe src="/admin/?companion=true#/app/xyz/feedback/123" />
               │
               ↓
               NESTED ADMIN PAGE (inside iframe)
               │
               ├─ App.tsx
               │  ├─ Loads parent's state (selectedAppId, currentRoute)
               │  ├─ Detects isCompanion=true (from URL param)
               │  └─ Renders FeedbackDetailPage directly (no Layout)
               │     └─ Shows feedback in "companion mode" (content only)
               │
               └─ This iframe has its OWN:
                  ├─ Document context
                  ├─ Event listeners
                  ├─ Keyboard event system
                  ├─ shortcuts.ts handlers (runs again)
                  └─ Global state (separate instance)
```

## 7. Focus State When Companion Has Focus

```
Parent Document:
  document.activeElement = <iframe class="companion-iframe" />
    │
    ├─ isInputFocused() checks this
    │  └─ Returns false (not an input/textarea/select)
    │
    └─ Can't traverse into iframe (browser prevents it)

Inside iframe Document:
  iframe.contentDocument.activeElement = <p> or <div> or whatever
    │
    └─ iframe has its own handlers, but
       parent's handlers can't reach the iframe's keydown events
```

## 8. Allow-List in Context

```
When typing in an input field on parent page:

User presses Cmd+K
  ↓
Parent handler receives event ✓
  ↓
isInputFocused() → true (cursor in <input>)
  ↓
Check allow-list:
  ├─ Cmd+Shift+Space? No
  ├─ Cmd+K? YES ← Matches!
  │
  └─ Allow through to shortcut registry
      ├─ Find Cmd+K shortcut
      └─ Execute → setShowSpotlight()
      └─ ✓ Spotlight opens despite typing in input

When keyboard event fires in iframe:

User presses Cmd+K
  ↓
Parent handler NEVER receives event ✗
  ↓
isInputFocused() is never called
  ↓
Check allow-list is never reached
  ↓
Shortcut registry is never searched
  ↓
setShowSpotlight() is never called
  ↓
✗ Silent failure (no error, no spotlight)

The allow-list doesn't help because the handler never runs!
```

## 9. Solution: postMessage Bridge

```
OPTION 1: Cross-Document Communication

Parent Document                    iframe Document
┌──────────────────┐              ┌──────────────────┐
│ Layout           │              │ FeedbackDetail   │
│  ↑               │              │  ↑               │
│  │ window.       │              │  │ document.     │
│  │ addEventListener│              │  │ addEventListener
│  │ ('message'...) │◄─────────────│  │ ('keydown'..)│
│  │                │              │  │ Cmd+K → send│
│  │                │              │  │ postMessage  │
│  │ receive        │              │  │              │
│  │ 'pw-cmd-k'     │              │  └──────────────┘
│  │ message        │              │
│  │ → setShowspot  │              │
│  │ light()        │              │
└──────────────────┘              └──────────────────┘
     |
     └─→ Works with sandbox!
         Parent doesn't need direct iframe access
```

---

## Quick Reference: File Locations

```
Layout.tsx (Cmd+K registration):
  Line 287-293: registerShortcut({ key: 'k', modifiers: { meta: true }, ... })

shortcuts.ts (Global handler):
  Line 239: document.addEventListener('keydown', ..., true)
  Line 65-137: function handleKeyDown(e)
  Line 74: else if (ctrlOrMeta && e.key === 'k') { /* allow through */ }

FeedbackCompanionView.tsx (Creates iframe):
  Line 10-16: <iframe src={src} ... />

IframeCompanionView.tsx (External iframe):
  Line 35-41: <iframe src={url} sandbox="..." />

GlobalTerminalPanel.tsx (Renders companions):
  Line 430-456: Decision tree for which companion to show

state.ts (Companion mode detection):
  Line 8: export const isCompanion = signal(params.get('companion') === 'true')
```

