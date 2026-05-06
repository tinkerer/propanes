use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use objc2::runtime::NSObjectProtocol;
use objc2::{ClassType, Message};
use tauri_nspanel::panel;
use tauri_nspanel::ManagerExt as NSPanelManagerExt;
use tauri_nspanel::WebviewWindowExt;

panel!(ProPanel {
    config: {
        can_become_key_window: true,
        can_become_main_window: false,
    }
});

static SERVER_URL: Mutex<String> = Mutex::new(String::new());

const COS_LABEL: &str = "cos-panel";
const FEEDBACK_LABEL: &str = "feedback-panel";

fn server_url() -> String {
    let url = SERVER_URL.lock().unwrap();
    if url.is_empty() {
        "http://localhost:3001".to_string()
    } else {
        url.clone()
    }
}

pub fn set_server_url(url: String) {
    *SERVER_URL.lock().unwrap() = url;
}

pub fn get_server_url() -> String {
    server_url()
}

pub fn create_panels(app: &AppHandle) -> tauri::Result<()> {
    create_cos_panel(app)?;
    create_feedback_panel(app)?;
    #[cfg(target_os = "macos")]
    install_esc_override();
    Ok(())
}

/// Override `cancelOperation:` on the RawProPanel ObjC class so Esc hides
/// panels (`orderOut:`) instead of closing them. NSPanel's default
/// `cancelOperation:` calls `close`, which destroys the window and can
/// trigger app exit for an Accessory-policy app with no remaining windows.
/// This fires at the Cocoa responder-chain level, before JS keydown events.
#[cfg(target_os = "macos")]
fn install_esc_override() {
    use std::ffi::c_void;

    extern "C" {
        fn objc_getClass(name: *const u8) -> *mut c_void;
    }

    extern "C" fn order_out(this: *mut c_void, sel_name: &str) {
        eprintln!(">>> {} intercepted — orderOut instead", sel_name);
        unsafe {
            let obj = &*(this as *const objc2::runtime::AnyObject);
            let _: () = objc2::msg_send![obj, orderOut: std::ptr::null::<objc2::runtime::AnyObject>()];
        }
    }

    extern "C" fn on_cancel(this: *mut c_void, _cmd: *mut c_void, _sender: *mut c_void) {
        order_out(this, "cancelOperation:");
    }

    extern "C" fn on_perform_close(this: *mut c_void, _cmd: *mut c_void, _sender: *mut c_void) {
        order_out(this, "performClose:");
    }

    extern "C" fn on_close(this: *mut c_void, _cmd: *mut c_void) {
        // close takes no argument (unlike cancelOperation:/performClose: which take a sender)
        order_out(this, "close");
    }

    fn add_or_replace_raw(
        cls: *mut c_void,
        sel_name: &[u8],
        imp: *const c_void,
        types: &[u8],
    ) {
        unsafe {
            extern "C" {
                fn sel_registerName(name: *const u8) -> *mut c_void;
                fn class_addMethod(
                    cls: *mut c_void,
                    sel: *mut c_void,
                    imp: *const c_void,
                    types: *const u8,
                ) -> bool;
                fn class_replaceMethod(
                    cls: *mut c_void,
                    sel: *mut c_void,
                    imp: *const c_void,
                    types: *const u8,
                ) -> *mut c_void;
            }
            let sel = sel_registerName(sel_name.as_ptr());
            let added = class_addMethod(cls, sel, imp, types.as_ptr());
            if !added {
                class_replaceMethod(cls, sel, imp, types.as_ptr());
                eprintln!(
                    "install_esc_override: replaced existing {}",
                    std::str::from_utf8(&sel_name[..sel_name.len() - 1]).unwrap_or("?")
                );
            }
        }
    }

    unsafe {
        let cls = objc_getClass(b"ProPanel\0".as_ptr());
        if cls.is_null() {
            eprintln!("install_esc_override: ProPanel class not found");
            return;
        }
        // cancelOperation: and performClose: take (self, _cmd, sender)
        add_or_replace_raw(cls, b"cancelOperation:\0", on_cancel as *const c_void, b"v@:@\0");
        add_or_replace_raw(cls, b"performClose:\0", on_perform_close as *const c_void, b"v@:@\0");
        // close takes (self, _cmd) — no sender argument
        add_or_replace_raw(cls, b"close\0", on_close as *const c_void, b"v@:\0");
        eprintln!("install_esc_override: overrides installed on ProPanel (cancelOperation:, performClose:, close)");
    }
}

fn create_cos_panel(app: &AppHandle) -> tauri::Result<()> {
    let url = format!("{}/admin/?embed=cos", server_url());
    let win =
        WebviewWindowBuilder::new(app, COS_LABEL, WebviewUrl::External(url.parse().unwrap()))
            .title("Chief of Staff")
            .inner_size(440.0, 700.0)
            .decorations(false)
            .transparent(true)
            .visible(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .on_page_load(|webview, _payload| {
                let _ = webview.eval(
                    r#"(async()=>{
                        if (!localStorage.getItem('pw-admin-token')) {
                            try {
                                const r = await fetch('/api/v1/auth/login', {
                                    method: 'POST',
                                    headers: {'Content-Type':'application/json'},
                                    body: JSON.stringify({username:'admin',password:'admin'})
                                });
                                const d = await r.json();
                                if (d.token) {
                                    localStorage.setItem('pw-admin-token', d.token);
                                    window.location.reload();
                                }
                            } catch(e) {}
                        }
                    })()"#,
                );
                let _ = webview.eval(
                    r#"if(!window.__ppEscInstalled){window.__ppEscInstalled=true;document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();window.__TAURI__.core.invoke('toggle_cos_panel')}},true)}"#,
                );
            })
            .build()?;

    win.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });

    let panel = win.to_panel::<ProPanel>()?;
    panel.set_level(3);
    panel.set_floating_panel(true);
    panel.set_becomes_key_only_if_needed(true);
    panel.set_style_mask(objc2_app_kit::NSWindowStyleMask(1 << 7));

    Ok(())
}

fn create_feedback_panel(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(
        app,
        FEEDBACK_LABEL,
        WebviewUrl::App("feedback.html".into()),
    )
    .title("Feedback")
    .inner_size(380.0, 520.0)
    .decorations(false)
    .visible(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()?;

    win.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });

    let panel = win.to_panel::<ProPanel>()?;
    panel.set_level(3);
    panel.set_floating_panel(true);
    panel.set_becomes_key_only_if_needed(true);
    panel.set_style_mask(objc2_app_kit::NSWindowStyleMask(1 << 7));

    Ok(())
}

pub fn toggle_cos(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(COS_LABEL) {
        if panel.is_visible() {
            panel.hide();
        } else {
            position_panel(app, COS_LABEL, 440.0, 0.0);
            panel.show();
        }
    }
}

pub fn toggle_feedback(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(FEEDBACK_LABEL) {
        if panel.is_visible() {
            panel.hide();
        } else {
            position_panel(app, FEEDBACK_LABEL, 380.0, 460.0);
            panel.show();
        }
    }
}

pub fn show_feedback_spotlight(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(FEEDBACK_LABEL) {
        if panel.is_visible() {
            panel.hide();
            return;
        }
        if let Some(window) = panel.to_window() {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let scale = monitor.scale_factor();
                let screen_w = monitor.size().width as f64 / scale;
                let screen_h = monitor.size().height as f64 / scale;
                let panel_w = 380.0;
                let x = (screen_w - panel_w) / 2.0;
                let y = screen_h * 0.2;
                let _ = window.set_position(tauri::Position::Logical(
                    tauri::LogicalPosition { x, y },
                ));
            }
        }
        panel.show();
    }
}

pub fn show_feedback_spotlight_brainstorm(app: &AppHandle) {
    show_feedback_spotlight(app);
    if let Some(wv) = app.get_webview_window(FEEDBACK_LABEL) {
        let _ = wv.eval(
            "if(window.promptWidget){window.promptWidget.open();window.dispatchEvent(new CustomEvent('propanes:start-brainstorm'))}"
        );
    }
}

fn position_panel(app: &AppHandle, label: &str, width: f64, extra_offset: f64) {
    if let Ok(panel) = app.get_webview_panel(label) {
        if let Some(window) = panel.to_window() {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let screen_width = monitor.size().width as f64 / monitor.scale_factor();
                let x = screen_width - width - 12.0 - extra_offset;
                let y = 28.0;
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                    x,
                    y,
                }));
            }
        }
    }
}
