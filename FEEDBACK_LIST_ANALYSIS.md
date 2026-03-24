# Feedback List View - Component and CSS Analysis

## Summary
The feedback list view is rendered by the `FeedbackListPage` component, which displays feedback items in a table format. The title column contains truncated links with the class `.feedback-title-link`.

---

## 1. Main Component: FeedbackListPage

**File:** `/Users/amir/work/github.com/prompt-widget/packages/admin/src/pages/FeedbackListPage.tsx`

### Component Structure
- **Signal-based state management:** Uses Preact signals for items, pagination, filters, sorting, and selection
- **Table layout:** Standard HTML table with 8 columns
- **Sub-components:** 
  - `StatusCell` - displays status badge and session state indicators
  - `ActionCell` - displays dispatch/session action buttons

### Key Functions
- `loadFeedback()` (line 60-80): Fetches feedback items from API with pagination/filtering
- `StatusCell()` (line 167-199): Renders status column with session state dots and badges
- `ActionCell()` (line 201-276): Renders action buttons (Dispatch, View, Re-dispatch)

---

## 2. Table Structure

### Column Headers (Lines 503-519)
```tsx
<th>                           <!-- Checkbox -->
<th style="width:60px">ID</th>
<th>Title</th>
<th>Type</th>
<th>Status</th>
<th>Tags</th>
<th>Created</th>
<th style="width:120px">Actions</th>
```

### Title Column Details (Lines 541-552)
**HTML Structure:**
```tsx
<td>
  <a
    href={`#${basePath}/${item.id}`}
    onClick={(e) => { e.preventDefault(); navigate(`${basePath}/${item.id}`); }}
    style="color:var(--pw-primary-text);text-decoration:none;font-weight:500"
  >
    {item.title}
  </a>
</td>
```

**Note:** The anchor tag does NOT have the `feedback-title-link` class in the JSX code. The CSS class must be applied elsewhere or the user was referring to styling on the selected element (not the anchor itself).

### Action Column (Lines 567-569)
```tsx
<td>
  <ActionCell item={item} />
</td>
```

Contains buttons rendered by the `ActionCell` sub-component.

---

## 3. CSS Styling

### Base Table Styling (Lines 764-796 in app.css)

**Table Container:**
```css
.table-wrap {
  background: var(--pw-bg-surface);
  border-radius: 8px;
  box-shadow: var(--pw-shadow-sm);
  overflow: hidden;
}
```

**Table Element:**
```css
table {
  width: 100%;
  border-collapse: collapse;
}
```

**Header Cells:**
```css
th {
  text-align: left;
  padding: 12px 16px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--pw-text-muted);
  background: var(--pw-bg-raised);
  border-bottom: 1px solid var(--pw-border);
}
```

**Data Cells:**
```css
td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--pw-border-light);
  vertical-align: middle;
}
```

**Row Hover:**
```css
tr:hover td {
  background: var(--pw-bg-hover);
}
```

---

### Checkbox Column Sizing (Lines 1256-1261 in app.css)

**Fixed width for first column:**
```css
.table-wrap table th:first-child,
.table-wrap table td:first-child {
  width: 40px;
  text-align: center;
  padding-left: 12px;
  padding-right: 4px;
}
```

---

### Title Link Styling (Lines 4395-4405 in app.css)

**The `.feedback-title-link` class:**
```css
.feedback-title-link {
  color: var(--pw-primary-text);
  font-size: 12px;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feedback-title-link:hover {
  text-decoration: underline;
}
```

**Key Properties for Truncation:**
- `overflow: hidden;` - Clips content that exceeds container
- `text-overflow: ellipsis;` - Shows "..." for clipped text
- `white-space: nowrap;` - Prevents text wrapping to next line

---

### Status Cell Styling (Lines 820-857 in app.css)

**Status Cell Container:**
```css
.status-cell-compound {
  display: flex;
  align-items: center;
  gap: 4px;
}
```

**Session State Indicators:**
```css
.session-state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.session-state-dot.active {
  background: #22c55e;
}

.session-state-dot.idle {
  background: #22c55e;
  opacity: 0.45;
}

.session-state-dot.waiting {
  background: #4ade80;
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.4);
}
```

**Running Status Dot:**
```css
.dispatch-running-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6366f1;
  animation: pulse-dot 1.5s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
```

---

### Action Buttons Styling (Lines 1881-1989 in app.css)

**Quick Dispatch Button (default):**
```css
.btn-dispatch-quick {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--pw-border);
  background: var(--pw-bg-surface);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--pw-primary-text);
  transition: all 0.15s;
}

.btn-dispatch-quick:hover {
  background: var(--pw-primary-soft);
  border-color: var(--pw-primary);
}

.btn-dispatch-quick:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
```

**Action Cell Group:**
```css
.action-cell-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
```

**Live Action Button (running session):**
```css
.btn-action-live {
  /* Similar to btn-dispatch-quick but with pulse animation */
  /* Contains: .live-pulse and optional .session-count badge */
}
```

**View Action Button (completed session):**
```css
.btn-action-view {
  /* Similar to btn-dispatch-quick */
  /* Contains optional .session-count badge */
}
```

**Mini Re-dispatch Button:**
```css
.btn-dispatch-mini {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--pw-border);
  background: var(--pw-bg-surface);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}

.btn-dispatch-mini:hover {
  background: var(--pw-primary-soft);
  border-color: var(--pw-primary);
  color: var(--pw-primary-text);
}

.btn-dispatch-mini:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
```

---

## 4. Layout Analysis

### Column Width Distribution

| Column | Width | Notes |
|--------|-------|-------|
| Checkbox | 40px | Fixed (`.table-wrap table th:first-child`) |
| ID | 60px | Inline style on `<th>` |
| **Title** | **Auto** | **No width constraint - may overflow** |
| Type | Auto | Badge with limited content |
| Status | Auto | Badge with limited content |
| Tags | Auto | Multiple small tags |
| Created | Auto | Fixed format date with `white-space: nowrap` |
| **Actions** | **120px** | Inline style on `<th>` |
| **Total** | **~240px fixed + flexible** | Title column gets remainder |

### Title Column Truncation Issue

**Root Cause:** The Title column (`.feedback-title-link`) has:
1. ✅ `overflow: hidden;` - Enabled
2. ✅ `text-overflow: ellipsis;` - Enabled  
3. ✅ `white-space: nowrap;` - Enabled

**BUT:** The parent `<td>` element has NO width constraint. Without a defined width or `max-width`, the table cell expands to fit content, making truncation impossible.

**Solution:** Add a width constraint to the Title column header:
```tsx
<th style="width: [value]">Title</th>
```

---

## 5. Sub-component Details

### StatusCell Component (Lines 167-199)

**Behavior:**
- If dispatched + running: Shows state dot + session state badge
- If dispatched + completed: Shows dispatch completion badge  
- Default: Shows status badge + optional running pulse dot

**Rendering:**
- Uses `.status-cell-compound` flex container
- Shows session state or dispatch status
- Animates pulse dot for running sessions

### ActionCell Component (Lines 201-276)

**Three Display Modes:**

1. **Running Session** (Lines 208-221):
   - `.btn-action-live` button with `.live-pulse` animation
   - Shows "Live" text
   - Optional session count badge

2. **Completed Session** (Lines 224-252):
   - `.btn-action-view` button to review session
   - `.btn-dispatch-mini` re-dispatch button (↻)
   - Optional session count badge

3. **Idle/New** (Lines 255-275):
   - `.btn-dispatch-quick` button with "→" icon
   - Disabled state during loading
   - Success checkmark or error X on completion

---

## 6. Filter and Selection Bar

### Sticky Behavior (Lines 946-968 in app.css)

**Normal State:**
```css
.filters {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
  align-items: center;
  /* ... */
}
```

**With Selection (Sticky):**
```css
.filters.has-selection {
  position: sticky;
  top: 0;
  z-index: 20;
}

.filters.has-selection.stuck {
  background: var(--pw-primary);
  box-shadow: var(--pw-shadow-md);
  border-radius: 0 0 8px 8px;
}
```

---

## 7. Badge Styling (Lines 799-868 in app.css)

**Base Badges:**
```css
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 500;
}
```

**Status Badges:**
- `.badge-new` - Light blue (#dbeafe), dark blue text
- `.badge-reviewed` - Light amber (#fef3c7), dark amber text
- `.badge-dispatched` - Light indigo (#e0e7ff), dark indigo text
- `.badge-resolved` - Light emerald (#d1fae5), dark emerald text
- `.badge-archived` - Light slate (#f1f5f9), dark slate text
- `.badge-deleted` - Light red (#fee2e2), dark red text with strikethrough

**Type Badges:**
- `.badge-manual` - Slate
- `.badge-ab_test` - Pink
- `.badge-analytics` - Cyan
- `.badge-error_report` - Red
- `.badge-programmatic` - Purple

---

## 8. Key Files Summary

| File | Purpose | Key Lines |
|------|---------|-----------|
| `FeedbackListPage.tsx` | Main feedback list component | 278-607 |
| `FeedbackListPage.tsx` | Title column rendering | 541-552 |
| `FeedbackListPage.tsx` | ActionCell sub-component | 201-276 |
| `FeedbackListPage.tsx` | StatusCell sub-component | 167-199 |
| `app.css` | Base table styling | 764-796 |
| `app.css` | Title link styling (.feedback-title-link) | 4395-4405 |
| `app.css` | Status cell styling | 820-857 |
| `app.css` | Action button styling | 1881-1989 |
| `app.css` | Badge styling | 799-868 |

---

## 9. Important Notes

1. **`.feedback-title-link` class:** This CSS class is defined in `app.css` but appears NOT to be applied to the actual anchor element in the JSX. The anchor has inline styles instead.

2. **Title Truncation:** The truncation CSS properties are present (`.overflow: hidden`, `.text-overflow: ellipsis`, `.white-space: nowrap`), but effective truncation requires the parent `<td>` to have a `max-width` or `width` constraint.

3. **Column Layout:** The table uses a mix of fixed widths (ID: 60px, Actions: 120px, Checkbox: 40px) and flexible layout for remaining columns (Title, Type, Status, Tags, Created).

4. **Responsive Behavior:** The table may not respond well on smaller screens since:
   - Multiple columns compete for space
   - No media queries adjust column widths
   - Title column has no width constraint

5. **Filter Bar Behavior:** The `.filters` container becomes sticky when items are selected, creating a floating action bar that doesn't interfere with table scrolling.

