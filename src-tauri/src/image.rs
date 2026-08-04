use std::io::Cursor;

use tauri::ipc::Response;

/// Read an image file and return its raw bytes to the frontend.
/// Uses Tauri's raw IPC response (not a JSON number array), so multi-MB JPGs
/// transfer efficiently. Read-only — never touches the source otherwise.
#[tauri::command]
pub fn read_image(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read image {path}: {e}"))?;
    Ok(Response::new(bytes))
}

/// Decode a JPG and return a small JPEG thumbnail (longest side `max_side`).
/// For the filmstrip of previously reviewed frames — decoding + downscaling in
/// Rust keeps multi-MB reads off the UI thread and the IPC payload tiny.
/// Read-only.
#[tauri::command]
pub async fn read_thumbnail(path: String, max_side: u32) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).map_err(|e| format!("Cannot decode {path}: {e}"))?;
        // `thumbnail` preserves aspect ratio and uses a fast filter.
        let thumb = img.thumbnail(max_side, max_side).to_rgb8();
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(thumb)
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .map_err(|e| format!("Cannot encode thumbnail: {e}"))?;
        Ok(Response::new(buf.into_inner()))
    })
    .await
    .map_err(|e| format!("Thumbnail task aborted: {e}"))?
}
