use tauri::ipc::Response;

/// Read an image file and return its raw bytes to the frontend.
/// Uses Tauri's raw IPC response (not a JSON number array), so multi-MB JPGs
/// transfer efficiently. Read-only — never touches the source otherwise.
#[tauri::command]
pub fn read_image(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read image {path}: {e}"))?;
    Ok(Response::new(bytes))
}
