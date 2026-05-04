# tauri-nspanel Research: Non-Activating macOS Panels for Tauri

## 1. What tauri-nspanel Does

**Repository**: https://github.com/ahkohd/tauri-nspanel

tauri-nspanel is a Rust plugin that lets you create macOS **NSPanel** windows in Tauri applications. NSPanels are a special AppKit window type designed for auxiliary/utility UI that floats above normal windows -- tool palettes, inspectors, floating controls, HUD displays, and spotlight-style overlays.

Key capabilities:
- Convert an existing Tauri window into an NSPanel
- Create new panels from scratch via `PanelBuilder`
- Control whether the panel steals focus (non-activating behavior)
- Set panel floating level, transparency, corner radius, style masks
- Custom panel subclasses via the `tauri_panel!` macro

The core value proposition: **NSPanels don't activate the owning application when shown**, so the previously-focused app stays focused. This is how macOS Spotlight, Alfred, Raycast, and similar overlays work.

---

## 2. Installation & Configuration (Tauri v2)

### Cargo.toml

```toml
[dependencies]
tauri-nspanel = { git = "https://github.com/ahkohd/tauri-nspanel", branch = "v2.1" }
```

The `v2.1` branch is the current version targeting Tauri v2. There's also a `v2` branch for an older iteration.

### Plugin Registration (main.rs or lib.rs)

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        // ... other plugins
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Version Compatibility

| Branch | Tauri Version | Status |
|--------|--------------|--------|
| `v2.1` | Tauri v2.x | Current / Active |
| `v2` | Tauri v2.x (older) | Legacy |
| `main` / untagged | Tauri v1.x | Original |

**tauri-nspanel DOES support Tauri v2** via the `v2.1` branch.

---

## 3. API Usage

### Full PanelBuilder API

```rust
use tauri_nspanel::builder::PanelBuilder;
use tauri_nspanel::{PanelLevel, StyleMask, CollectionBehavior};

let panel = PanelBuilder::new(app.handle(), "my-panel")
    // Content
    .url(WebviewUrl::App("panel.html".into()))
    .title("My Panel")

    // Geometry
    .position(Position::Logical(LogicalPosition { x: 100.0, y: 100.0 }))
    .size(Size::Logical(LogicalSize { width: 600.0, height: 400.0 }))
    .content_size(size)  // inner size excluding decorations

    // Panel Level (z-ordering)
    .level(PanelLevel::Floating)   // above normal windows
    // or PanelLevel::Status        // above floating panels

    // Appearance
    .has_shadow(true)
    .opaque(false)
    .alpha_value(0.95)
    .transparent(true)             // clears background
    .corner_radius(12.0)          // rounded corners
    .style_mask(StyleMask::empty().borderless())

    // Behavioral
    .floating(true)
    .hides_on_deactivate(true)     // auto-hide when app loses focus
    .becomes_key_only_if_needed(true)
    .accepts_mouse_moved_events(true)
    .ignores_mouse_events(false)
    .movable_by_window_background(true)
    .released_when_closed(false)
    .works_when_modal(true)
    .no_activate(true)             // PREVENTS FOCUS STEALING on creation

    // Spaces/Expose behavior
    .collection_behavior(CollectionBehavior::CanJoinAllSpaces)

    // Advanced: access underlying Tauri WindowBuilder
    .with_window(|wb| {
        wb.decorations(false)
          .always_on_top(true)
    })

    .build()?;
```

### Key Methods on Panel

```rust
panel.show();                    // show the panel
panel.show_and_make_key();       // show and give it keyboard focus
panel.close();                   // hide/close the panel
panel.to_window();               // convert back to a standard window reference
```

### Retrieving a Panel

```rust
// In a Tauri command:
#[tauri::command]
fn toggle_panel(app: tauri::AppHandle) {
    if let Some(panel) = app.get_webview_panel("my-panel") {
        panel.show();
    }
}
```

### Custom Panel Subclass (tauri_panel! macro)

```rust
use tauri_nspanel::tauri_panel;

tauri_panel! {
    panel!(MyPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}
```

### Making It Non-Activating (The Key Trick)

To get true Spotlight-like non-activating behavior, you need `NSWindowStyleMaskNonactivatingPanel`:

```rust
#[allow(non_upper_case_globals)]
const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;

#[tauri::command]
fn create_spotlight_panel(app: tauri::AppHandle) {
    let window = tauri::WindowBuilder::new(
        &app,
        "spotlight",
        tauri::WindowUrl::App("spotlight.html".into()),
    )
    .decorations(false)   // CRITICAL: must be false before converting
    .build()
    .unwrap();

    let panel = window.to_panel().unwrap();
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
    panel.show();
}
```

**Critical requirement**: The window MUST have `decorations(false)` set BEFORE converting to a panel. Setting decorations after conversion causes crashes because `NSTitledWindowMask` conflicts with the panel conversion.

### Threading Constraint

All NSPanel operations MUST run on the main thread. If you're in an async context:

```rust
#[tauri::command]
async fn create_panel_async(app: tauri::AppHandle) {
    let window = tauri::WindowBuilder::new(&app, "panel", url)
        .decorations(false)
        .build()
        .unwrap();

    app.run_on_main_thread(move || {
        let panel = window.to_panel().unwrap();
        panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
        panel.show();
    }).unwrap();
}
```

---

## 4. Spotlight / Overlay UI Examples

### ahkohd/tauri-macos-spotlight-example

**Repository**: https://github.com/ahkohd/tauri-macos-spotlight-example

A complete example of a macOS Spotlight clone built with Tauri + React + TypeScript:
- Activated via **Cmd+K** global shortcut
- Uses tauri-nspanel for non-activating panel behavior
- Uses tauri-plugin-spotlight for hide-on-blur and previous-window restoration
- Built with Vite + pnpm
- Stack: Rust (58.4%), TypeScript (17.2%), CSS, HTML

### zzzze/tauri-plugin-spotlight

**Repository**: https://github.com/zzzze/tauri-plugin-spotlight

A higher-level plugin that wraps the spotlight pattern:
- Customizable hotkeys for show/hide
- Multi-window support with independent registration
- **Auto-hide on focus loss**
- Multi-display support (macOS only)
- Always-on-top with previous window restoration
- Built on top of the tauri-macos-spotlight-example approach

Installation:
```toml
# Cargo.toml
tauri-plugin-spotlight = { git = "https://github.com/zzzze/tauri-plugin-spotlight" }
```

```bash
# JS frontend
pnpm add tauri-plugin-spotlight-api
```

Configuration can be done programmatically in Rust or via `tauri.conf.json`:
```json
{
  "plugins": {
    "spotlight": {
      "windows": ["main"],
      "shortcut": "Cmd+K",
      "macos_window_level": "floating"
    }
  }
}
```

Frontend API:
```typescript
import { hide } from 'tauri-plugin-spotlight-api';
// Call hide() to dismiss the spotlight window
```

---

## 5. Tauri v2 Compatibility Summary

| Component | Tauri v2 Support | Notes |
|-----------|-----------------|-------|
| tauri-nspanel | YES (v2.1 branch) | Active development |
| tauri-plugin-spotlight | UNCLEAR | No explicit v2 mention; git dep without version |
| tauri-macos-spotlight-example | Likely v1 only | Template project, may need porting |
| Native Tauri NSPanel support | NOT YET | Feature request open (issue #13034), no timeline |

### Native Tauri NSPanel Support Status

There is an open feature request (tauri-apps/tauri#13034, opened March 2025) asking for native NSPanel support directly in Tauri, similar to Electron's `type: 'panel'` option. No official response or timeline from maintainers as of the issue's last activity.

---

## 6. Alternative Approaches (If tauri-nspanel Doesn't Work)

### Option A: `focusable: false` in Tauri Config

```json
{
  "windows": [{
    "label": "overlay",
    "focusable": false
  }]
}
```

**Status**: Known to be broken on macOS (tauri#14102). The window still steals focus when clicked. Not a reliable solution.

### Option B: Accessory Activation Policy

```rust
app.set_activation_policy(tauri::ActivationPolicy::Accessory);
```

This hides the dock icon and makes the window float above others. However:
- Dock icon disappears entirely (may not be desirable)
- `window.show()` stops working reliably (tauri#5122)
- App becomes invisible in Cmd+Tab switcher

### Option C: Always On Top + Manual Focus Management

```json
{
  "windows": [{
    "label": "overlay",
    "alwaysOnTop": true,
    "decorations": false,
    "transparent": true
  }]
}
```

Combined with:
```rust
// After showing window, restore focus to previous app
// (requires platform-specific code to track and restore focus)
```

This is a partial workaround -- the window appears on top but briefly steals focus before you can restore it. Noticeable flicker.

### Option D: Raw Objective-C via objc2 crate

Skip tauri-nspanel entirely and use raw Objective-C interop:

```rust
use objc2::runtime::*;
use objc2_app_kit::*;

// Get the raw NSWindow pointer from Tauri
// Swizzle/subclass it to NSPanel
// Set NSWindowStyleMaskNonactivatingPanel
// Handle all the edge cases manually
```

This is the most flexible but most labor-intensive approach. tauri-nspanel is essentially a well-packaged version of this.

### Option E: Electron (if Tauri is not mandatory)

Electron has first-class support for panel windows:

```javascript
const { BrowserWindow } = require('electron');
const win = new BrowserWindow({
    type: 'panel',  // Creates NSPanel on macOS
    focusable: false,
    // ...
});
```

Electron's panel support was added via PR #34388 and handles non-activating behavior correctly.

---

## 7. Known Pitfalls & Deep Technical Notes

### NSWindowStyleMaskNonactivatingPanel timing

From https://philz.blog/nspanel-nonactivating-style-mask-flag/:

The nonactivating flag works via a WindowServer tag (`kCGSPreventsActivationTagBit`). During panel initialization, AppKit calls the internal method `_setPreventsActivation:` to set this tag. However, **changing the style mask after initialization via `setStyleMask:` does NOT call `_setPreventsActivation:` again**. This creates a mismatch where AppKit thinks it's a regular window but WindowServer still treats it as nonactivating.

**Best practice**: Set the nonactivating behavior during initialization, not after. If you must change it at runtime:
- Override `_isNonactivatingPanel` to return `true`
- Or manually call `_setPreventsActivation:` (private API)

### Keyboard input in non-activating panels

Non-activating panels use "key focus theft" -- the panel temporarily steals keyboard focus from the truly active application via the CoreProcesses subsystem. The user can type into the panel while the other app remains "active." This is exactly how Spotlight works.

### Decorations must be false

The window MUST be created with `decorations: false` before being converted to an NSPanel. The `NSTitledWindowMask` from decorated windows is incompatible with the panel conversion and will crash.

### Main thread requirement

All window/panel operations in Cocoa must happen on the main thread. In Tauri commands, either:
- Make the command synchronous (remove `async`)
- Use `app.run_on_main_thread(move || { ... })` to dispatch

---

## 8. Recommended Approach for a Spotlight/HUD Overlay

Based on all the research, the recommended stack is:

1. **Use tauri-nspanel v2.1** for the core panel creation
2. **Set `NSWindowStyleMaskNonactivatingPanel`** during initialization
3. **Register a global shortcut** to toggle visibility
4. **Use `hides_on_deactivate(true)`** or listen for blur events to auto-hide
5. **Set `transparent(true)` + `decorations(false)`** for the overlay look
6. **Use `PanelLevel::Floating`** to stay above other windows
7. **Optionally use tauri-plugin-spotlight** if its API covers your needs and it supports Tauri v2

Minimal Rust setup:

```rust
use tauri_nspanel::builder::PanelBuilder;
use tauri_nspanel::PanelLevel;

fn setup_spotlight(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let panel = PanelBuilder::new(app, "spotlight")
        .url(WebviewUrl::App("spotlight.html".into()))
        .size(Size::Logical(LogicalSize { width: 680.0, height: 48.0 }))
        .level(PanelLevel::Floating)
        .transparent(true)
        .has_shadow(true)
        .corner_radius(12.0)
        .no_activate(true)
        .hides_on_deactivate(true)
        .floating(true)
        .style_mask(StyleMask::empty().borderless())
        .with_window(|wb| wb.decorations(false).center(true))
        .build()?;

    Ok(())
}
```

---

## Sources

- [ahkohd/tauri-nspanel (GitHub)](https://github.com/ahkohd/tauri-nspanel)
- [tauri-nspanel API docs](https://docs.aremu.dev/tauri-nspanel/tauri_nspanel/builder/struct.PanelBuilder.html)
- [NSWindowStyleMaskNonactivatingPanel issue (#19)](https://github.com/ahkohd/tauri-nspanel/issues/19)
- [Window-to-panel conversion issue (#22)](https://github.com/ahkohd/tauri-nspanel/issues/22)
- [Native NSPanel feature request (tauri#13034)](https://github.com/tauri-apps/tauri/issues/13034)
- [Spotlight/overlay tracking issue (tauri#2801)](https://github.com/tauri-apps/tauri/issues/2801)
- [focusable:false broken on macOS (tauri#14102)](https://github.com/tauri-apps/tauri/issues/14102)
- [tauri-macos-spotlight-example](https://github.com/ahkohd/tauri-macos-spotlight-example)
- [tauri-plugin-spotlight](https://github.com/zzzze/tauri-plugin-spotlight)
- [Spotlight-like app discussion (tauri#9876)](https://github.com/tauri-apps/tauri/discussions/9876)
- [NSPanel nonactivating style mask deep dive](https://philz.blog/nspanel-nonactivating-style-mask-flag/)
- [Apple: NSWindow.StyleMask.nonactivatingPanel](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/nonactivatingpanel)
