#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod panels;
mod tray;

#[tauri::command]
fn toggle_cos_panel(app: tauri::AppHandle) {
    panels::toggle_cos(&app);
}

#[tauri::command]
fn toggle_feedback_panel(app: tauri::AppHandle) {
    panels::toggle_feedback(&app);
}

#[tauri::command]
fn set_server_url(url: String) {
    panels::set_server_url(url);
}

#[tauri::command]
fn get_server_url() -> String {
    panels::get_server_url()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // On second instance, just show the CoS panel
            panels::toggle_cos(app);
        }))
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![
            toggle_cos_panel,
            toggle_feedback_panel,
            set_server_url,
            get_server_url,
        ])
        .setup(|app| {
            // Hide dock icon — tray-only app
            #[cfg(target_os = "macos")]
            {
                use objc2::MainThreadMarker;
                use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
                let mtm = MainThreadMarker::new().expect("setup runs on main thread");
                let ns_app = NSApplication::sharedApplication(mtm);
                ns_app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
            }

            let handle = app.handle().clone();
            tray::setup(&handle)?;
            panels::create_panels(&handle)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running ProPanes");
}
