use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use objc2::runtime::NSObjectProtocol;
use objc2::{ClassType, Message};
use tauri_nspanel::panel;
use tauri_nspanel::ManagerExt as NSPanelManagerExt;
use tauri_nspanel::WebviewWindowExt;

// Define a non-activating panel type
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
    Ok(())
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
                // Auto-login: if no token in localStorage, fetch one and reload
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
            })
            .build()?;

    // Convert WebviewWindow → NSPanel
    let panel = win.to_panel::<ProPanel>()?;
    panel.set_level(3); // NSFloatingWindowLevel
    panel.set_floating_panel(true);
    panel.set_becomes_key_only_if_needed(true);
    panel.set_style_mask(objc2_app_kit::NSWindowStyleMask(1 << 7)); // nonActivatingPanel

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
