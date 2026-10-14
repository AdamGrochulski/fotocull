use std::path::Path;
use serde::Serialize;
use tauri::{AppHandle, Manager};
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
    /// Only probed for the destination; the source is never written to.
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
/// With `probe_write` (destination only) a momentary test file is created and
/// removed; without it nothing is written, so the source card stays untouched.
#[tauri::command]
pub fn check_dir(path: String, probe_write: bool) -> DirStatus {
    // Runs right after a folder is picked. Some native pickers change the process
    // working directory to the chosen folder; re-anchor to a neutral temp dir so
    // we never lock a user folder against rename (see run() in lib.rs).
    let _ = std::env::set_current_dir(std::env::temp_dir());

    let p = Path::new(&path);

    let exists = p.exists();
    let is_dir = p.is_dir();
    // Readability: try to list the contents.
    let readable = is_dir && std::fs::read_dir(p).is_ok();
    // Only probe writability for real directories, and never for the source.
    let writable = is_dir && probe_write && probe_writable(p);

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

/// Grant the asset protocol read access to a directory (recursively), so the
/// frontend can stream video files from it via `convertFileSrc`. Called with the
/// source folder before video playback. Read-only — the scope only permits reads.
#[tauri::command]
pub fn allow_media_dir(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| format!("Cannot grant media access: {e}"))
}
