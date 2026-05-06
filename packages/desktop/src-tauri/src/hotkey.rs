use rdev::{listen, EventType, Key};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const TAP_WINDOW: Duration = Duration::from_millis(400);
const SHORT_PRESS_MAX: Duration = Duration::from_millis(300);
const HOLD_THRESHOLD: Duration = Duration::from_millis(800);

struct TapState {
    tap_count: u8,
    last_press: Instant,
    alt_down: bool,
}

impl TapState {
    fn new() -> Self {
        Self {
            tap_count: 0,
            last_press: Instant::now() - Duration::from_secs(10),
            alt_down: false,
        }
    }

    fn reset(&mut self) {
        self.tap_count = 0;
        self.alt_down = false;
    }
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

pub fn start_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let state = Mutex::new(TapState::new());

        let callback = move |event: rdev::Event| {
            // rdev calls us from inside an extern "C" CGEventTap handler.
            // Any panic here would unwind across the FFI boundary → abort.
            // catch_unwind keeps us safe.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let Ok(mut s) = state.lock() else { return };

                match event.event_type {
                    EventType::KeyPress(Key::Alt) => {
                        let now = Instant::now();
                        if now.duration_since(s.last_press) < TAP_WINDOW {
                            s.tap_count += 1;
                        } else {
                            s.tap_count = 1;
                        }
                        s.last_press = now;
                        s.alt_down = true;
                    }

                    EventType::KeyRelease(Key::Alt) => {
                        if !s.alt_down {
                            return;
                        }
                        s.alt_down = false;
                        let hold = Instant::now().duration_since(s.last_press);

                        if s.tap_count >= 3 && hold < SHORT_PRESS_MAX {
                            let handle = app.clone();
                            let inner = handle.clone();
                            let _ = handle.run_on_main_thread(move || {
                                crate::panels::show_feedback_spotlight(&inner);
                            });
                            s.reset();
                        } else if s.tap_count >= 2 && hold >= HOLD_THRESHOLD {
                            let handle = app.clone();
                            let inner = handle.clone();
                            let _ = handle.run_on_main_thread(move || {
                                crate::panels::show_feedback_spotlight_brainstorm(&inner);
                            });
                            s.reset();
                        }
                    }

                    EventType::KeyPress(k) if !is_modifier(k) => {
                        s.reset();
                    }

                    _ => {}
                }
            }));
        };

        if let Err(e) = listen(callback) {
            eprintln!("rdev listen error: {:?}", e);
        }
    });
}

fn is_modifier(key: Key) -> bool {
    matches!(
        key,
        Key::Alt
            | Key::AltGr
            | Key::ShiftLeft
            | Key::ShiftRight
            | Key::ControlLeft
            | Key::ControlRight
            | Key::MetaLeft
            | Key::MetaRight
    )
}
