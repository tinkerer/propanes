# Terminal Picker Exploration - Document Index

## Overview
This exploration provides comprehensive documentation of the terminal picker dropdown menu system in the prompt-widget admin UI, including component structure, styling, state management, and API integration.

## Documents Created

### 1. **EXPLORATION_SUMMARY.txt** (Primary Reference)
- **Type**: High-level overview
- **Use Case**: Quick reference and architecture overview
- **Contents**:
  - Key findings (5 major areas)
  - Component architecture diagram
  - CSS styling reference
  - State management overview
  - API endpoints documentation
  - Keyboard interactions reference
  - Click-outside handling patterns
  - Design patterns identified
  - Files analyzed checklist
  - Recommendations for enhancement

**Key Sections**:
- Key Findings: Terminal pickers, dropdown system, data sources, modals, search
- Architecture: Visual component tree with signal flow
- CSS Reference: Complete styling breakdown with colors and measurements
- State Management: All signals and functions
- API Endpoints: All 4 API calls with request/response formats

### 2. **TERMINAL_PICKER_ANALYSIS.md** (Detailed Analysis)
- **Type**: In-depth technical documentation
- **Use Case**: Understanding component internals and relationships
- **Contents**:
  - Component definitions and interfaces
  - Data structures and filtering logic
  - CSS classes and styling
  - Modal/popup patterns
  - Directory picker reference pattern
  - Keyboard interaction details
  - Click-outside handling patterns
  - Search/Cmd-K functionality analysis
  - Architecture summary (ASCII diagram)
  - Files summary table

**Key Sections**:
- Main Terminal Picker Components: TerminalCompanionPicker, NewTerminalPicker details
- Session ID Dropdown Menu: All menu options and handlers
- Data Sources: Complete interface definitions
- Related Signals: All state variables and their purposes
- Modal/Popup Patterns: 3 different pattern examples
- Existing Search/Cmd-K Functionality: SpotlightSearch implementation

### 3. **COMPONENT_CODE_REFERENCE.md** (Code Snippets)
- **Type**: Code reference with line numbers
- **Use Case**: Looking up specific implementations
- **Contents**:
  - File paths and line numbers
  - Component structure with line ranges
  - Data filtering logic code
  - API call implementations
  - Signal definitions
  - CSS classes with line references
  - Click-outside detection patterns (3 variations)
  - Menu item render examples
  - Related components to study

**Key Sections**:
- TerminalCompanionPicker Component: Structure, signals, handlers
- NewTerminalPicker Component: Differences and async loading
- PaneHeader Component: Dropdown trigger, terminal companion toggle
- State Management: All signals with line references
- API Calls: Complete function signatures
- CSS Classes Reference: All classes used with line numbers
- Click-Outside Detection Patterns: 3 pattern variations
- Keyboard Handling: Code examples from SpotlightSearch

## File Locations

All exploration documents are saved in:
```
/Users/amir/work/github.com/prompt-widget/
├── EXPLORATION_SUMMARY.txt          ← Start here for overview
├── TERMINAL_PICKER_ANALYSIS.md      ← Detailed technical analysis
├── COMPONENT_CODE_REFERENCE.md      ← Code snippets and line numbers
└── TERMINAL_PANEL_ARCHITECTURE.md   ← Previous exploration (related)
```

## Quick Navigation

### By Task
- **I want to understand the system quickly** → Read EXPLORATION_SUMMARY.txt
- **I need technical details about components** → Read TERMINAL_PICKER_ANALYSIS.md
- **I need to find specific code** → Read COMPONENT_CODE_REFERENCE.md
- **I need to implement something similar** → Read TERMINAL_PICKER_ANALYSIS.md + COMPONENT_CODE_REFERENCE.md

### By Component
- **TerminalCompanionPicker**: COMPONENT_CODE_REFERENCE.md, TERMINAL_PICKER_ANALYSIS.md
- **NewTerminalPicker**: COMPONENT_CODE_REFERENCE.md, TERMINAL_PICKER_ANALYSIS.md
- **PaneHeader Dropdown**: COMPONENT_CODE_REFERENCE.md, TERMINAL_PICKER_ANALYSIS.md
- **SpotlightSearch**: TERMINAL_PICKER_ANALYSIS.md (Search/Cmd-K section)
- **DirPicker**: TERMINAL_PICKER_ANALYSIS.md (Directory Picker section)
- **AddAppModal**: TERMINAL_PICKER_ANALYSIS.md (Modal Pattern section)

### By Topic
- **Dropdown/Submenu System**: 
  - EXPLORATION_SUMMARY.txt (CSS Styling Reference, Keyboard Interactions)
  - TERMINAL_PICKER_ANALYSIS.md (CSS Styling, Click-Outside Handling)
  - COMPONENT_CODE_REFERENCE.md (CSS Classes Reference)

- **State Management**:
  - EXPLORATION_SUMMARY.txt (State Management section)
  - TERMINAL_PICKER_ANALYSIS.md (Related Signals and State)
  - COMPONENT_CODE_REFERENCE.md (State Management subsection)

- **API Integration**:
  - EXPLORATION_SUMMARY.txt (API Endpoints section)
  - TERMINAL_PICKER_ANALYSIS.md (Data Sources section)
  - COMPONENT_CODE_REFERENCE.md (API Calls subsection)

- **Keyboard Interactions**:
  - EXPLORATION_SUMMARY.txt (Keyboard Interactions section)
  - TERMINAL_PICKER_ANALYSIS.md (Keyboard Interaction section)
  - COMPONENT_CODE_REFERENCE.md (Keyboard Handling subsection)

- **Modal/Dialog Components**:
  - EXPLORATION_SUMMARY.txt (Modal/Dialog Components section)
  - TERMINAL_PICKER_ANALYSIS.md (Modal/Popup Patterns section)
  - COMPONENT_CODE_REFERENCE.md (Click-Outside Detection Patterns)

- **Search/Cmd-K Functionality**:
  - EXPLORATION_SUMMARY.txt (Existing Search/Cmd-K Implementation)
  - TERMINAL_PICKER_ANALYSIS.md (Existing Search/Cmd-K Functionality)
  - COMPONENT_CODE_REFERENCE.md (Keyboard Handling in SpotlightSearch)

## Key Data Structures

### DispatchTarget (Machine/Harness)
```typescript
{
  launcherId: string;
  name: string;
  hostname: string;
  machineName: string | null;
  machineId: string | null;
  isHarness: boolean;
  harnessConfigId: string | null;
  activeSessions: number;
  maxSessions: number;
}
```
See: COMPONENT_CODE_REFERENCE.md (Data Structures section)

### TmuxSession
```typescript
{
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}
```
See: COMPONENT_CODE_REFERENCE.md (API Calls section)

## Important Signals

- `termPickerSessionId` - Which session's picker is open
- `termPickerTmux` - Array of available tmux sessions
- `termPickerLoading` - Async loading state
- `newTermPickerOpen` - New terminal picker visibility
- `idMenuOpen` - Main dropdown menu visibility
- `terminalCompanionMap` - Parent→terminal mapping (persisted)

See: EXPLORATION_SUMMARY.txt (State Management section) for complete list

## API Endpoints

1. `GET /admin/dispatch-targets` - Get machines and harnesses
2. `GET /admin/tmux-sessions` - Get available tmux sessions
3. `POST /admin/terminal` - Spawn new terminal
4. `POST /admin/terminal/attach-tmux` - Attach tmux session

See: EXPLORATION_SUMMARY.txt (API Endpoints section) for full details

## CSS Classes Used

- `.id-dropdown-menu` - Main dropdown container
- `.term-picker-menu` - Terminal picker specific
- `.id-dropdown-separator` - Section dividers
- `.modal-overlay` - Modal backdrop
- `.modal` - Modal container
- `.spotlight-overlay` - Search overlay

See: COMPONENT_CODE_REFERENCE.md (CSS Classes Reference) for line numbers

## Design Patterns Found

1. **Dropdown Submenu**: Absolute positioned, click-outside detection
2. **Async Data Loading**: Loading state + useEffect + error handling
3. **Modal Overlay**: Fixed overlay with centered container
4. **Signal-Based State**: Preact signals with localStorage persistence
5. **Keyboard-First Navigation**: Single-key shortcuts + arrow keys

See: EXPLORATION_SUMMARY.txt (Design Patterns Identified) for details

## Component Files Analyzed

### Components (8 files)
- GlobalTerminalPanel.tsx (1055 lines) ← Main component
- DispatchTargetSelect.tsx (85 lines)
- AddAppModal.tsx (213 lines)
- ShortcutHelpModal.tsx (63 lines)
- SpotlightSearch.tsx (260 lines)
- DirPicker.tsx (125 lines)
- AgentTerminal.tsx (465 lines)

### State/API (2 files)
- sessions.ts (1800+ lines)
- api.ts (200+ lines)

### Styling (1 file)
- app.css (6196+ lines)

See: EXPLORATION_SUMMARY.txt (Files Analyzed section) for details

## How to Use These Documents

1. **Start with EXPLORATION_SUMMARY.txt** for a high-level overview
2. **Reference TERMINAL_PICKER_ANALYSIS.md** for detailed explanations
3. **Look up specific code in COMPONENT_CODE_REFERENCE.md** using line numbers
4. **Cross-reference between documents** using section names

## Recommendations

To implement similar functionality:
1. Use DispatchTargetSelect for remote machine/harness data
2. Reference DirPicker for async dropdown patterns
3. Follow SpotlightSearch for search/keyboard navigation
4. Use existing modal patterns from AddAppModal
5. Leverage setTerminalCompanionAndOpen() for state management

See: EXPLORATION_SUMMARY.txt (Recommendations for Enhancement) for details

## Notes

- All line numbers reference the files as of March 2, 2026
- Code examples shown without modification
- Read-only exploration (no files modified)
- Analysis covers both component logic and styling
- Includes pattern references for similar UI components

---

**Documents Created**: March 2, 2026
**Last Updated**: March 2, 2026
**Total Documentation**: 3 files + this index
**Total Lines Analyzed**: 6000+ lines of code
