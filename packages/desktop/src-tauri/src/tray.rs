use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::panels;

fn tray_icon() -> Image<'static> {
    // 22x22 white circle for macOS template rendering
    let size: u32 = 22;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let center = size as f32 / 2.0;
    let radius = center - 2.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center + 0.5;
            let dy = y as f32 - center + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = ((y * size + x) * 4) as usize;
            if dist <= radius {
                rgba[idx] = 255;
                rgba[idx + 1] = 255;
                rgba[idx + 2] = 255;
                rgba[idx + 3] = 220;
            }
        }
    }
    Image::new_owned(rgba, size, size)
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit ProPanes", true, Some("CmdOrCtrl+Q"))?;
    let show_cos = MenuItem::with_id(app, "show_cos", "Chief of Staff", true, None::<&str>)?;
    let show_feedback =
        MenuItem::with_id(app, "show_feedback", "Feedback Widget", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_cos, &show_feedback, &separator, &quit])?;

    TrayIconBuilder::new()
        .icon(tray_icon())
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("ProPanes")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "show_cos" => {
                panels::toggle_cos(app);
            }
            "show_feedback" => {
                panels::toggle_feedback(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                panels::toggle_cos(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
