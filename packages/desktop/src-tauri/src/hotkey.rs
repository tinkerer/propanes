use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const TAP_WINDOW: Duration = Duration::from_millis(400);
const SHORT_PRESS_MAX: Duration = Duration::from_millis(300);
const HOLD_THRESHOLD: Duration = Duration::from_millis(800);

// CGEvent constants
const K_CG_EVENT_FLAGS_CHANGED: u32 = 12;
const K_CG_EVENT_KEY_DOWN: u32 = 10;
const K_CG_SESSION_EVENT_TAP: u32 = 1;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
const K_CG_EVENT_FLAG_MASK_ALTERNATE: u64 = 0x00080000;
const LEFT_ALT_KEYCODE: i64 = 58;
const RIGHT_ALT_KEYCODE: i64 = 61;

extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
        user_info: *mut c_void,
    ) -> *mut c_void;
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: *mut c_void,
        order: i64,
    ) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    fn CFRelease(cf: *mut c_void);
    static kCFRunLoopCommonModes: *const c_void;
}

struct TapState {
    tap_count: u8,
    last_press: Instant,
    alt_down: bool,
    app: AppHandle,
}

#[cfg(target_os = "macos")]
pub fn check_accessibility() -> bool {
    unsafe {
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        AXIsProcessTrusted()
    }
}

#[cfg(not(target_os = "macos"))]
pub fn check_accessibility() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn prompt_accessibility_settings(_app: &AppHandle) {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

#[cfg(not(target_os = "macos"))]
pub fn prompt_accessibility_settings(_app: &AppHandle) {}

extern "C" fn event_tap_callback(
    _proxy: *mut c_void,
    event_type: u32,
    event: *mut c_void,
    user_info: *mut c_void,
) -> *mut c_void {
    // This is extern "C" inside a CGEventTap — panics would abort.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        let state = &*(user_info as *const Mutex<TapState>);
        let Ok(mut s) = state.lock() else { return };

        match event_type {
            K_CG_EVENT_FLAGS_CHANGED => {
                let keycode = CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE);
                let flags = CGEventGetFlags(event);
                let alt_pressed = (flags & K_CG_EVENT_FLAG_MASK_ALTERNATE) != 0;

                if (keycode == LEFT_ALT_KEYCODE || keycode == RIGHT_ALT_KEYCODE) && alt_pressed {
                    // Alt key pressed
                    let now = Instant::now();
                    if now.duration_since(s.last_press) < TAP_WINDOW {
                        s.tap_count += 1;
                    } else {
                        s.tap_count = 1;
                    }
                    s.last_press = now;
                    s.alt_down = true;
                } else if (keycode == LEFT_ALT_KEYCODE || keycode == RIGHT_ALT_KEYCODE)
                    && !alt_pressed
                {
                    // Alt key released
                    if !s.alt_down {
                        return;
                    }
                    s.alt_down = false;
                    let hold = Instant::now().duration_since(s.last_press);

                    if s.tap_count >= 3 && hold < SHORT_PRESS_MAX {
                        let handle = s.app.clone();
                        let inner = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            crate::panels::show_feedback_spotlight(&inner);
                        });
                        s.tap_count = 0;
                    } else if s.tap_count >= 2 && hold >= HOLD_THRESHOLD {
                        let handle = s.app.clone();
                        let inner = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            crate::panels::show_feedback_spotlight_brainstorm(&inner);
                        });
                        s.tap_count = 0;
                    }
                }
            }
            K_CG_EVENT_KEY_DOWN => {
                // Non-modifier key pressed — reset tap sequence
                s.tap_count = 0;
                s.alt_down = false;
            }
            _ => {}
        }
    }));
    event
}

pub fn start_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let state = Box::new(Mutex::new(TapState {
            tap_count: 0,
            last_press: Instant::now() - Duration::from_secs(10),
            alt_down: false,
            app,
        }));
        let state_ptr = Box::into_raw(state) as *mut c_void;

        unsafe {
            let event_mask =
                (1u64 << K_CG_EVENT_FLAGS_CHANGED) | (1u64 << K_CG_EVENT_KEY_DOWN);

            let tap = CGEventTapCreate(
                K_CG_SESSION_EVENT_TAP,
                K_CG_HEAD_INSERT_EVENT_TAP,
                K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                event_mask,
                event_tap_callback,
                state_ptr,
            );

            if tap.is_null() {
                eprintln!("hotkey: CGEventTapCreate failed (no Accessibility permission?)");
                return;
            }

            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            if source.is_null() {
                eprintln!("hotkey: CFMachPortCreateRunLoopSource failed");
                CFRelease(tap);
                return;
            }

            let rl = CFRunLoopGetCurrent();
            CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes);
            CFRelease(source);

            // Blocks forever — processes events on this thread's run loop.
            // No TSM/HIToolbox calls, so no main-thread assertion.
            CFRunLoopRun();
        }
    });
}
