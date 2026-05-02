# Shell Components

Top-level chrome for the ProPanes admin dashboard. These components form the application root, main layout chrome, toolbar, and navigation structures.

## Purpose

The shell layer is responsible for:
- Application root and authentication gating
- Layout chrome (sidebar, main content area)
- Top toolbar with app selection, session history, and action buttons
- Page-level routing and navigation
- Mobile/responsive layout variants

The render hierarchy is:
```
main.tsx → App → Layout → (Sidebar + PageView/MobilePageView)
        → (PopoutPanel, DispatchDialog, ChiefOfStaffBubble, etc.)
```

## Component Map

| Component | Responsibility |
|-----------|-----------------|
| **App** (`App.tsx:56`) | Root component. Handles authentication, isolate mode, embedded/companion/workbench routing, and conditional layout selection. Returns LoginPage if unauthenticated, or routes to Layout, StandaloneSessionPage, StandalonePanelPage, or StandaloneFeedbackPage based on route. |
| **Layout** (`Layout.tsx:83`) | Main layout chrome combining ControlBar, PaneTree (desktop), PopoutPanel (desktop), MobileNav/MobilePageView (mobile), and all modal/overlay components. Registers 40+ keyboard shortcuts and manages sidebar collapse state. |
| **ControlBar** (`ControlBar.tsx:40`) | Top toolbar with app selector dropdown, app control actions, Terminal button, MRU (most-recently-used) pane history dropdown, search spotlight button, and notifications button. Responsive: collapses action buttons into "more" menu on mobile. |
| **PageView** (`PageView.tsx:25`) | Companion-mode page router. Decodes routes like `/app/:appId/tickets/:fbId` and renders appropriate pages (FeedbackListPage, FeedbackDetailPage, SessionsPage, AggregatePage, AppSettingsPage, etc.). Handles root redirect and missing-app fallbacks. |
| **MobileNav** (`MobileNav.tsx:29`) | Mobile bottom tab bar with icons for Tickets, Sessions, Live, Settings. Navigates to corresponding routes and indicates active tab. |
| **MobilePageView** (`MobilePageView.tsx:61`) | Mobile page router; mirrors PageView logic but also renders StandaloneSessionPage, FeedbackDetailPage, and WiggumPage. Handles mobile-specific routing. |

## Render Hierarchy

```
App (line:56)
├─ isAuthenticated check
│  ├─ [unauthenticated] → LoginPage
│  └─ [authenticated]
│     ├─ isolate mode → renders single isolated component
│     ├─ standalone session (/session/:id) → StandaloneSessionPage
│     ├─ standalone feedback (/fb/:id) → StandaloneFeedbackPage
│     ├─ standalone panel (/panel/:...) → StandalonePanelPage
│     ├─ companion mode → CompanionRoot
│     │  └─ PageView
│     ├─ workbench mode
│     │  └─ Layout (line:83)
│     │     ├─ ControlBar (line:40)
│     │     ├─ PaneTree (desktop)
│     │     ├─ PopoutPanel (desktop)
│     │     ├─ MobilePageView (mobile, line:61)
│     │     ├─ MobileNav (mobile, line:29)
│     │     ├─ FileViewerOverlay
│     │     ├─ DispatchDialog, SetupAssistantDialog
│     │     ├─ ChiefOfStaffBubble, NotificationCenter
│     │     └─ [40+ modals and overlays]
│     ├─ CoS-only embed → CosEmbedRoot
│     │  └─ ChiefOfStaffBubble
│     └─ embedded mode
│        └─ [PageView + GlobalTerminalPanel + modals]
```

## Key Features

- **Authentication**: App.tsx checks `isAuthenticated.value` and gates access (line:85-87)
- **Keyboard Shortcuts**: Layout registers 40+ shortcuts via `registerShortcut()` (line:154-545). Categories: General, Navigation, Panels. Notable: Ctrl+Shift+Space for Spotlight, Ctrl+Shift+K for Cmd+K, 'g' sequences for navigation (gf=Tickets, ga=Agents, gg=Files, gs=Sessions, gl=Live, gp=Preferences), Ctrl+Shift+0-9 for tab switching
- **Mobile Detection**: `isMobile.value` from viewport library switches entire UI to MobileNav/MobilePageView (Layout line:611-624)
- **MRU Pane History**: ControlBar shows recently-used sessions/panels in dropdown; stored in `paneMruHistory.value` (ControlBar line:207-259)
- **Companion Shortcuts**: CompanionRoot listens for iframe postMessages for Cmd+K, Ctrl+Shift+Space, Escape and relays them to parent (App.tsx line:37-51)

## Gotchas

- **Route Interception**: Layout intercepts ticket detail routes (e.g., `/app/appId/tickets/feedbackId`) and opens them as pane tabs instead of navigating (line:105-115). This is desktop-only; mobile keeps the URL.
- **Status Dot Menus**: Two click-handler overlay menus are rendered at end of Layout (line:658-741)—one for session status (kill/resolve), one for sidebar items (copy link, split pane, colors). These require click-outside listeners (line:118-129).
- **Auto-Jump Toast**: When auto-jump-to-waiting-session is active, a countdown toast appears (line:642-652) that can be dismissed with Ctrl+Shift+X.
- **Spotlight**: Both `toggleSpotlight()` (Ctrl+Shift+Space) and `openSpotlight()` (Cmd+K) trigger the search modal, which is also closed by Escape globally (line:175).
- **Mobile Pages**: MobilePageView and MobileNav must stay in sync with PageView routing logic; changes to routes need updates in both.

