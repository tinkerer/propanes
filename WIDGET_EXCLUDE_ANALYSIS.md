# "Exclude Widget" Dropdown Location & CSS Clipping Issue Analysis

## Summary

The "Exclude Widget" dropdown option is located in the **widget panel's screenshot menu** (NOT in the admin Applications page settings). The dropdown is experiencing CSS clipping due to the parent `.pw-panel` container having `overflow: hidden;` which prevents absolutely positioned dropdowns from showing above the panel boundary.

---

## File Locations

### Widget Component (Main Implementation)

**File: `/Users/amir/work/github.com/prompt-widget/packages/widget/src/widget.ts`**

#### Screenshot Menu Toggle Function (Lines 260-333)
```typescript
private toggleCameraMenu() {
  const existing = this.shadow.querySelector('.pw-camera-menu');
  if (existing) { existing.remove(); return; }

  const group = this.shadow.querySelector('.pw-camera-group');
  if (!group) return;

  const menu = document.createElement('div');
  menu.className = 'pw-camera-menu';

  // Creates checkbox label with "Exclude widget" text
  const label = document.createElement('label');
  label.className = 'pw-camera-menu-item';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = this.excludeWidget;
  cb.addEventListener('change', () => {
    this.excludeWidget = cb.checked;
  });
  const span = document.createElement('span');
  span.textContent = 'Exclude widget';  // <-- LINE 279
  label.append(cb, span);
  menu.appendChild(label);
  
  // ... additional menu items for "Exclude cursor" and "Multi-screenshot"
}
```

#### Dropdown Menu Rendering (Lines 462-471)
The dropdown appears conditionally in the HTML template when `screenshotIncludeWidget` is true:

```typescript
${this.sessionBridge.screenshotIncludeWidget ? `
  <div class="pw-camera-group">
    <button class="pw-camera-btn" id="pw-capture-btn" title="Capture screenshot">
      <!-- camera SVG -->
    </button>
    <button class="pw-camera-dropdown-toggle" id="pw-camera-dropdown" title="Screenshot options">
      <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
    </button>
  </div>
  <span class="pw-camera-countdown pw-hidden" id="pw-camera-countdown"></span>
` : ...}
```

#### Event Listener Setup (Line 523)
```typescript
cameraDropdownBtn?.addEventListener('click', (e) => { 
  e.stopPropagation(); 
  this.toggleCameraMenu(); 
});
```

#### Screenshot Logic (Line 595)
```typescript
private async captureScreen() {
  const btn = this.shadow.querySelector('#pw-capture-btn') as HTMLButtonElement;
  btn.disabled = true;

  const excludeWidget = this.sessionBridge.screenshotIncludeWidget && this.excludeWidget;
  const blob = await captureScreenshot({ excludeWidget, excludeCursor: this.excludeCursor, keepStream: this.keepStream });
  if (blob) {
    this.addScreenshot(blob);
  }
  btn.disabled = false;
}
```

**The logic shows:**
- `screenshotIncludeWidget` comes from the **application configuration** (server side)
- `excludeWidget` is a local widget state that controls whether to exclude the widget during screenshot
- Both conditions must be true: `this.sessionBridge.screenshotIncludeWidget && this.excludeWidget`

---

### Widget Styles (CSS Clipping Problem)

**File: `/Users/amir/work/github.com/prompt-widget/packages/widget/src/styles.ts`**

#### Panel Container (Lines 47-59) - CULPRIT
```css
.pw-panel {
  position: fixed;
  z-index: 2147483647;
  width: 360px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(99, 102, 241, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;  /* <-- LINE 57: CAUSES CLIPPING */
  animation: pw-slide-in 0.2s ease-out;
}
```

**The Problem:**
- `.pw-panel { overflow: hidden; }` clips any child elements positioned absolutely outside the panel bounds
- The `.pw-camera-menu` is positioned `bottom: 100%;` (above the panel)
- This creates visual overflow clipping where the dropdown gets cut off at the panel's top edge

#### Camera Dropdown Menu (Lines 467-479)
```css
.pw-camera-menu {
  position: absolute;
  bottom: 100%;        /* Positioned above the panel */
  left: 0;
  margin-bottom: 4px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 10;         /* z-index is irrelevant when parent clips */
  min-width: 150px;
}
```

#### Camera Menu Items (Lines 481-496)
```css
.pw-camera-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  color: #e2e8f0;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
}

.pw-camera-menu-item:hover {
  background: rgba(99, 102, 241, 0.2);
}
```

#### Checkbox Styling (Lines 498-526)
```css
.pw-camera-menu-item input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid #475569;
  border-radius: 3px;
  background: #0f172a;
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.pw-camera-menu-item input[type="checkbox"]:checked {
  background: #6366f1;
  border-color: #6366f1;
}

.pw-camera-menu-item input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  top: 1px;
  left: 4px;
  width: 4px;
  height: 7px;
  border: solid white;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}
```

#### Camera Dropdown Toggle Button (Lines 440-465)
```css
.pw-camera-dropdown-toggle {
  height: 32px;
  width: 20px;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.15);
  background: #334155;
  color: #94a3b8;
  cursor: pointer;
  border-radius: 0 6px 6px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}

.pw-camera-dropdown-toggle:hover {
  background: #475569;
  color: #e2e8f0;
}

.pw-camera-dropdown-toggle svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}
```

---

### Application Configuration (Database & API)

**File: `/Users/amir/work/github.com/prompt-widget/packages/server/src/db/schema.ts` (Line 15)**
```typescript
screenshotIncludeWidget: integer('screenshot_include_widget', { mode: 'boolean' }).notNull().default(false),
```

**File: `/Users/amir/work/github.com/prompt-widget/packages/server/src/routes/applications.ts`**

- **Line 89**: Accepts `screenshotIncludeWidget` in PATCH updates
  ```typescript
  if (d.screenshotIncludeWidget !== undefined) updates.screenshotIncludeWidget = d.screenshotIncludeWidget;
  ```

- **Line 116**: ApplicationsPage hardcodes it to `true` when creating/updating applications
  ```typescript
  screenshotIncludeWidget: true,
  ```

**File: `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/ApplicationsPage.tsx` (Line 116)**
```typescript
const data: Record<string, unknown> = {
  name: formName.value,
  projectDir: formProjectDir.value,
  serverUrl: formServerUrl.value || undefined,
  hooks,
  description: formDescription.value,
  tmuxConfigId: formTmuxConfigId.value || null,
  defaultPermissionProfile: formPermissionProfile.value,
  defaultAllowedTools: formAllowedTools.value || null,
  agentPath: formAgentPath.value || null,
  screenshotIncludeWidget: true,  // <-- HARDCODED, no UI control
  autoDispatch: true,
};
```

**File: `/Users/amir/work/github.com/prompt-widget/packages/server/src/index.ts` (Line 81)**
```typescript
ws.send(JSON.stringify({ type: 'config', screenshotIncludeWidget: true, autoDispatch: true }));
```

The server sends `screenshotIncludeWidget: true` to all WebSocket clients regardless of application config.

---

### Widget Session Bridge

**File: `/Users/amir/work/github.com/prompt-widget/packages/widget/src/session.ts`**

- **Lines 60, 95-96**: Receives `screenshotIncludeWidget` from server config messages
  ```typescript
  public screenshotIncludeWidget = true;
  
  // ... in message handler
  if ('screenshotIncludeWidget' in msg) {
    this.screenshotIncludeWidget = this.screenshotIncludeWidget || !!msg.screenshotIncludeWidget;
  }
  ```

- **Line 172**: Passes it to the screenshot capture function
  ```typescript
  const blob = await captureScreenshot({ excludeWidget: this.screenshotIncludeWidget, excludeCursor: !!params.excludeCursor });
  ```

---

### Shared Type Definitions

**File: `/Users/amir/work/github.com/prompt-widget/packages/shared/src/schemas.ts` (Line 109)**
```typescript
screenshotIncludeWidget: z.boolean().optional(),
```

---

## Key Findings

### 1. "Exclude Widget" Dropdown Location
- **Where It Is**: In the widget itself, accessed by clicking the dropdown arrow next to the camera icon
- **NOT In**: The admin Applications page settings
- **How to Access**: Click the camera icon in the widget panel, then click the small dropdown arrow button next to it
- **Options Available**:
  1. "Exclude widget" (checkbox) - Line 279 in widget.ts
  2. "Exclude cursor" (checkbox) - Line 292 in widget.ts
  3. "Multi-screenshot" (checkbox) - Line 306 in widget.ts
  4. "Timed (3s)" (button) - Line 316 in widget.ts

### 2. CSS Clipping Issue
- **Root Cause**: `.pw-panel { overflow: hidden; }` on line 57 of styles.ts
- **Effect**: Absolutely positioned dropdown menus that extend above or below the panel get clipped
- **Affected Elements**: 
  - `.pw-camera-menu` (screenshot options) - positioned `bottom: 100%` (above panel)
  - `.pw-picker-menu` (element picker options) - also positioned absolutely
  - `.pw-admin-menu` (admin options) - also positioned absolutely
  - `.pw-send-menu` (send/dispatch options) - also positioned absolutely

### 3. Application Configuration Missing UI Control
- **Current State**: `screenshotIncludeWidget` is hardcoded to `true` in ApplicationsPage (line 116)
- **Missing UI**: No dropdown or toggle on the ApplicationsPage to control this setting
- **Backend Support**: The API route supports updating it (line 89 in applications.ts)
- **Database Schema**: Has the field defined (line 15 in schema.ts)
- **Server Always Sends**: Sends `screenshotIncludeWidget: true` to all clients regardless (line 81 in index.ts)

---

## Recommendations

### For CSS Clipping Issue
The `.pw-panel` needs to allow overflow for absolutely positioned children. Options:
1. Change `overflow: hidden;` to `overflow: visible;`
2. Use `overflow: hidden; transform: translateZ(0);` to create a new stacking context (partial fix)
3. Position dropdowns relative to the viewport instead of the panel

### For Admin UI Control
To add a UI control for `screenshotIncludeWidget` in the ApplicationsPage:
1. Add a signal: `const formScreenshotIncludeWidget = signal(true);`
2. Add a checkbox in the form
3. Include it in the data object being saved
4. Load it when editing an existing application

### For Server Configuration
Update the WebSocket message to respect the application's setting instead of always sending `true`.

---

## Visual Hierarchy

```
Widget Panel (.pw-panel)
├── Close Button
├── Screenshots Area
├── Input Area
│   ├── Textarea
│   ├── Context Options
│   └── Toolbar
│       ├── Camera Group
│       │   ├── Camera Button
│       │   └── Camera Dropdown Toggle
│       │       └── Camera Menu (CLIPPED) ← overflow: hidden issue
│       │           ├── "Exclude widget" ← TARGET ELEMENT
│       │           ├── "Exclude cursor"
│       │           ├── "Multi-screenshot"
│       │           ├── Divider
│       │           └── "Timed (3s)"
│       ├── Picker Group
│       │   ├── Picker Button
│       │   └── Picker Dropdown
│       │       └── Picker Menu (CLIPPED)
│       ├── Admin Group
│       │   ├── Admin Button
│       │   └── Admin Dropdown
│       │       └── Admin Menu
│       └── Send Group (conditionally shown)
│           ├── Send Button
│           └── Send Dropdown
│               └── Send Menu (CLIPPED)
└── Error Display
```

