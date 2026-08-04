use std::path::Path;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Directory status returned to the frontend after validating a selection.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirStatus {
    /// The path exists on disk.
    pub exists: bool,
    /// The path is a directory (not a file).
    pub is_dir: bool,
    /// The directory can be read (listing its contents).
    pub readable: bool,
    /// The directory can be written to (tested by creating and deleting a file).
    pub writable: bool,
}

/// Check whether the directory is writable — with a real test: create a temp
/// file and delete it. More reliable cross-platform than reading permission bits.
fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(".fotocull_write_test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Validate a directory chosen by the user (source or destination).
/// Modifies nothing except a momentary write-test file (removed immediately).
#[tauri::command]
pub fn check_dir(path: String) -> DirStatus {
    let p = Path::new(&path);

    let exists = p.exists();
    let is_dir = p.is_dir();
    // Readability: try to list the contents.
    let readable = is_dir && std::fs::read_dir(p).is_ok();
    // Only probe writability for real directories.
    let writable = if is_dir { probe_writable(p) } else { false };

    DirStatus {
        exists,
        is_dir,
        readable,
        writable,
    }
}

/// Open a folder in the OS file manager. Uses the opener plugin from the backend
/// (no frontend ACL/scope needed).
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Cannot open folder: {e}"))
}
