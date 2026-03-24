# Cmd+K Keyboard Shortcut Investigation - Analysis Files

This directory contains comprehensive analysis of why Cmd+K search fails when the feedback companion panel (iframe) has focus.

## Quick Start

1. **First time?** Read: `CMD_K_INVESTIGATION_INDEX.md` (7.6 KB)
   - Overview and navigation guide
   - Start here to understand the structure

2. **Want quick summary?** Read: `CMD_K_ISSUE_SUMMARY.txt` (9.3 KB)
   - Plain text format
   - Problem in 3 points
   - Solution overview

3. **Want all the details?** Read in this order:
   - `CMD_K_ANALYSIS.md` - Technical deep dive
   - `CMD_K_CODE_PATHS.md` - Execution trace
   - `COMPANION_IFRAME_ARCHITECTURE.md` - System design
   - `CMD_K_VISUAL_DIAGRAMS.md` - Visual explanations

## File Reference

### CMD_K_INVESTIGATION_INDEX.md (7.6 KB)
**Navigation and Overview**
- Document guide and quick navigation
- Key files reference table
- One-paragraph problem summary
- Testing procedures
- Recommended solution
- Key insights summary

### CMD_K_ISSUE_SUMMARY.txt (9.3 KB)
**Quick Plain-Text Reference**
- Root cause explanation
- The problem in 3 key points
- Technical details
- Key code locations with line numbers
- Why it's hard to diagnose
- Testing procedures
- Fix options overview

### CMD_K_ANALYSIS.md (7.4 KB)
**Technical Deep Dive**
- Cmd+K handler registration (Layout.tsx:287-293)
- Global keyboard handler (shortcuts.ts:239)
- iframe boundary isolation explanation
- Input focus detection function gap
- Why the allow-list is irrelevant
- 4 solution approaches with examples
- Files affected table
- Current behavior comparison table

### CMD_K_CODE_PATHS.md (9.3 KB)
**Complete Execution Trace**
- Phase 1: Registration (Layout.tsx:287-293)
- Phase 2: Handler installation (shortcuts.ts:239-241)
- Phase 3: Event reception (THE PROBLEM)
- Phase 4: Main handler logic (shortcuts.ts:65-137)
- Phase 5: isInputFocused() helper (shortcuts.ts:32-48)
- Phase 6: matchesModifiers() helper (shortcuts.ts:50-58)
- Phase 7: Spotlight toggle (Layout.tsx:195)
- Phase 8: SpotlightSearch component (SpotlightSearch.tsx:128-154)
- Summary: Chain of failure
- Why allow-list is irrelevant
- Files involved table

### COMPANION_IFRAME_ARCHITECTURE.md (7.6 KB)
**System Design and Architecture**
- Where companions are rendered (GlobalTerminalPanel, PopoutPanel)
- FeedbackCompanionView details (self-referential iframe)
- IframeCompanionView details (external URLs)
- TerminalCompanionView (no iframe)
- Companion mode detection (isCompanion flag)
- How sessions decide companion type
- Event flow in companion iframes
- Why shadow DOM traversal exists
- isInputFocused() gap explanation
- Key code locations table

### CMD_K_VISUAL_DIAGRAMS.md (14 KB)
**Visual Explanations and Diagrams**
1. Event isolation boundary (ASCII diagram)
2. Companion panel layout
3. Keyboard event flow: working vs broken
4. Component rendering decision tree
5. Shortcut handler call stack
6. iframe companion view nesting
7. Focus state explanation
8. Allow-list in context
9. postMessage solution diagram
- Quick reference: File locations

## The Problem (One Paragraph)

When the feedback companion panel (an iframe) has focus, Cmd+K fails to open spotlight search. The Cmd+K shortcut is registered correctly and the global keyboard handler is properly installed in capture phase. However, keyboard events from inside the iframe are isolated to that iframe's document context by browser security boundaries. The parent document's `document.addEventListener('keydown', ...)` never receives these events, so the global handler never runs, and the spotlight search never opens. The Cmd+K allow-list (which permits Cmd+K even when typing in inputs) is irrelevant because the handler is never invoked in the first place. The fix requires cross-document communication via postMessage to bridge the event isolation boundary.

## Key Code Locations

| What | Where | Lines | Purpose |
|------|-------|-------|---------|
| Cmd+K Registration | Layout.tsx | 287-293 | Register shortcut |
| Global Handler | shortcuts.ts | 239-241 | Install listener |
| Handler Logic | shortcuts.ts | 65-137 | Process events |
| Allow-list | shortcuts.ts | 71-88 | Cmd+K allowed |
| Input Check | shortcuts.ts | 32-48 | Focus detection |
| Modifier Check | shortcuts.ts | 50-58 | Modifier matching |
| Feedback Companion | FeedbackCompanionView.tsx | 10-16 | iframe creation |
| URL Companion | IframeCompanionView.tsx | 35-41 | External iframe |
| Rendering | GlobalTerminalPanel.tsx | 430-456 | Which companion |
| Companion Flag | state.ts | 8 | Mode detection |

## The Solution

Recommended approach: Message-based cross-document communication

```javascript
// Inside iframe (e.g., in FeedbackCompanionView or App component)
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'k') {
    e.preventDefault();
    window.parent.postMessage({ type: 'pw-cmd-k' }, '*');
  }
});

// In parent document (Layout.tsx)
window.addEventListener('message', (e) => {
  if (e.data?.type === 'pw-cmd-k') {
    setShowSpotlight((v) => !v);
  }
});
```

Benefits:
- Works with sandboxed iframes
- No security restrictions needed
- Bridges event isolation boundary
- Extensible to other shortcuts

## Testing the Issue

### Test 1: Cmd+K in normal context (WORKS)
1. Click on main page (not in iframe)
2. Press Cmd+K
3. Result: Spotlight opens ✓

### Test 2: Cmd+K in input field (WORKS)
1. Click in text input
2. Press Cmd+K
3. Result: Spotlight opens ✓ (on allow-list)

### Test 3: Cmd+K in companion iframe (FAILS)
1. Click inside companion iframe panel
2. Press Cmd+K
3. Result: Nothing happens ✗

### Test 4: Other shortcuts in iframe (ALSO FAILS)
1. Click inside companion iframe
2. Press Ctrl+Shift+W (close tab)
3. Result: Nothing happens ✗ (same root cause)

## Key Insights

1. **Event isolation is a feature** - Browser security boundary by design
2. **Allow-list is irrelevant** - Only matters if handler runs
3. **Affects all shortcuts** - Not just Cmd+K
4. **Silent failure** - No console errors
5. **Hard to diagnose** - Event never reaches parent
6. **Self-referential iframe** - Admin runs inside iframe

## Document Statistics

- **Total Documents**: 6
- **Total Size**: ~55 KB
- **Code Examples**: 40+
- **Diagrams**: 9
- **Line References**: 30+
- **Functions Detailed**: 8
- **Key Insights**: 12

## How to Use These Files

**For Debugging:**
- Read CMD_K_INVESTIGATION_INDEX.md first
- Jump to specific section using Quick Navigation
- Reference file/line numbers to jump to code

**For Understanding:**
- Start with CMD_K_ISSUE_SUMMARY.txt for overview
- Read CMD_K_ANALYSIS.md for technical details
- View CMD_K_VISUAL_DIAGRAMS.md for flow understanding

**For Implementation:**
- See "Solution" in CMD_K_INVESTIGATION_INDEX.md
- Code example shows exactly what to add
- Check COMPANION_IFRAME_ARCHITECTURE.md for architecture

**For Testing:**
- Follow procedures in CMD_K_INVESTIGATION_INDEX.md
- Test all 4 cases to verify understanding
- Use to verify fix works

---

**Investigation Date**: March 2, 2026
**Root Cause**: iframe Event Isolation (Browser Security Boundary)
**Status**: Complete - All findings documented
**Recommendation**: Implement postMessage bridge (Option 1)
