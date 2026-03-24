# Quick Reference: "Exclude Widget" Dropdown

## The 3 Main Issues

### 1. Location of "Exclude Widget" Option
**In the widget panel** (not admin dashboard):
- Click camera icon to capture screenshot
- Click small dropdown arrow next to camera button
- "Exclude widget" is the first checkbox option

**File**: `/Users/amir/work/github.com/prompt-widget/packages/widget/src/widget.ts:279`

### 2. CSS Overflow Clipping
**Problem**: Dropdown gets cut off at panel edges

**Root Cause**: `.pw-panel { overflow: hidden; }` 
**File**: `/Users/amir/work/github.com/prompt-widget/packages/widget/src/styles.ts:57`

**Affects**: All dropdowns in the widget toolbar
- Camera menu (screenshot options)
- Picker menu (element selection)
- Admin menu
- Send menu

### 3. Missing Admin UI Control
**Problem**: No way to toggle `screenshotIncludeWidget` in Applications page

**Hardcoded To**: `true` (always enabled)
**File**: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/ApplicationsPage.tsx:116`

**Backend Support**: Already exists (just not exposed in UI)
- Database schema has field: `packages/server/src/db/schema.ts:15`
- API accepts updates: `packages/server/src/routes/applications.ts:89`

---

## File Map

```
Widget Component:
├── widget.ts (Lines 260-333)      - toggleCameraMenu() function
├── widget.ts (Lines 462-471)      - HTML template rendering
├── widget.ts (Lines 517-523)      - Event listeners
├── widget.ts (Lines 591-596)      - Screenshot capture logic
└── styles.ts (Lines 47-59)        - .pw-panel (CLIPPING ISSUE)

Admin Pages:
├── ApplicationsPage.tsx (Line 116) - screenshotIncludeWidget hardcoded
├── api.ts (Line 116)              - updateApplication() API call
└── (No UI for controlling setting)

Server:
├── schema.ts (Line 15)            - Database field definition
├── applications.ts (Line 89)      - Patch handler
├── index.ts (Line 81)             - WebSocket broadcast
└── session.ts (Lines 60, 95-96)   - Client receives config

Shared:
└── schemas.ts (Line 109)          - Type definition
```

---

## How It Works (Data Flow)

```
Server sends config → Widget receives via WebSocket
                   → sessionBridge.screenshotIncludeWidget = true
                   
User clicks dropdown → toggleCameraMenu() creates menu
                    → Renders checkboxes with current state
                    → User can toggle excludeWidget locally
                    
User clicks capture → captureScreen() runs
                   → Checks: screenshotIncludeWidget AND excludeWidget
                   → Calls captureScreenshot() with excludeWidget flag
                   → Widget hidden in screenshot if both true
```

---

## What Needs To Be Fixed

1. **CSS Overflow**: Change line 57 in styles.ts from `overflow: hidden;` to allow absolute positioning
2. **Admin UI**: Add form control for `screenshotIncludeWidget` in ApplicationsPage  
3. **Server Logic**: Respect app config instead of always sending `true`

---

## Related Dropdowns (All Affected by Same Clipping)

- `.pw-camera-menu` - Screenshot options (THIS ONE HAS "Exclude Widget")
- `.pw-picker-menu` - Element selection options
- `.pw-admin-menu` - Admin panel options
- `.pw-send-menu` - Dispatch/send options

All 4 menus are positioned absolutely and get clipped by `overflow: hidden;`
