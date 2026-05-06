use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::panels;

fn tray_icon() -> Image<'static> {
    const OUT: u32 = 22;
    const SCALE: u32 = 8;
    let hi = OUT * SCALE;
    let mut alpha = vec![0.0f32; (hi * hi) as usize];

    paint_tank(&mut alpha, hi);

    let mut rgba = vec![0u8; (OUT * OUT * 4) as usize];
    for oy in 0..OUT {
        for ox in 0..OUT {
            let mut a = 0.0f32;
            for sy in 0..SCALE {
                for sx in 0..SCALE {
                    let hx = ox * SCALE + sx;
                    let hy = oy * SCALE + sy;
                    a += alpha[(hy * hi + hx) as usize];
                }
            }
            a /= (SCALE * SCALE) as f32;
            let idx = ((oy * OUT + ox) * 4) as usize;
            rgba[idx] = 255;
            rgba[idx + 1] = 255;
            rgba[idx + 2] = 255;
            rgba[idx + 3] = (a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }

    Image::new_owned(rgba, OUT, OUT)
}

fn paint_round_rect(
    alpha: &mut [f32],
    size: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r: f32,
    value: f32,
) {
    let sx = size as f32 / 256.0;
    let x = x * sx;
    let y = y * sx;
    let w = w * sx;
    let h = h * sx;
    let r = r * sx;

    let min_x = (x - r - 1.0).floor().max(0.0) as u32;
    let max_x = (x + w + r + 1.0).ceil().min(size as f32) as u32;
    let min_y = (y - r - 1.0).floor().max(0.0) as u32;
    let max_y = (y + h + r + 1.0).ceil().min(size as f32) as u32;

    for py in min_y..max_y {
        for px in min_x..max_x {
            let fx = px as f32 + 0.5;
            let fy = py as f32 + 0.5;
            let qx = (fx - (x + w / 2.0)).abs() - (w / 2.0 - r);
            let qy = (fy - (y + h / 2.0)).abs() - (h / 2.0 - r);
            let dx = qx.max(0.0);
            let dy = qy.max(0.0);
            let outside = (dx * dx + dy * dy).sqrt() - r;
            if outside <= 0.75 {
                let cover = (0.75 - outside).clamp(0.0, 1.0) * value;
                let idx = (py * size + px) as usize;
                alpha[idx] = alpha[idx].max(cover);
            }
        }
    }
}

fn paint_tank(alpha: &mut [f32], size: u32) {
    paint_round_rect(alpha, size, 34.0, 72.0, 188.0, 152.0, 54.0, 1.0);
    paint_round_rect(alpha, size, 48.0, 34.0, 30.0, 78.0, 13.0, 1.0);
    paint_round_rect(alpha, size, 178.0, 34.0, 30.0, 78.0, 13.0, 1.0);
    paint_round_rect(alpha, size, 70.0, 18.0, 116.0, 30.0, 15.0, 1.0);
    paint_round_rect(alpha, size, 108.0, 2.0, 40.0, 20.0, 10.0, 1.0);
    paint_round_rect(alpha, size, 120.0, 0.0, 16.0, 12.0, 6.0, 1.0);
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
