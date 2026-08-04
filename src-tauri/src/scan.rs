use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

/// One "photo" = a pair of files sharing a base name (stem).
/// The JPG is the preview, the ARW its companion; either one may be missing.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    /// Base name without extension, e.g. "DSC01234".
    pub base_name: String,
    /// Path to the JPG file (if present).
    pub jpg_path: Option<String>,
    /// Path to the ARW file (if present).
    pub arw_path: Option<String>,
    /// Source directory of the pair (JPG directory preferred).
    pub source_dir: String,
}

/// Scan progress sent to the frontend via the `scan://progress` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    files_scanned: usize,
    images_found: usize,
}

/// Accumulator built during the walk — before assembling into a `Photo`.
#[derive(Default)]
struct Entry {
    jpg_path: Option<String>,
    arw_path: Option<String>,
    jpg_dir: Option<String>,
    arw_dir: Option<String>,
}

fn parent_dir(p: &Path) -> String {
    p.parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Recursively scan the source directory. Collects .jpg/.jpeg/.arw files
/// (case-insensitive), grouped by base name. Read-only — changes nothing.
/// Reports progress via `scan://progress` events.
#[tauri::command]
pub async fn scan_source(app: AppHandle, path: String) -> Result<Vec<Photo>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&app, &path))
        .await
        .map_err(|e| format!("Scan task aborted: {e}"))?
}

fn scan_blocking(app: &AppHandle, root: &str) -> Result<Vec<Photo>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("Source folder does not exist: {root}"));
    }

    // Map key: base name (stem) — pairing is independent of directory.
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let mut files_scanned: usize = 0;

    for dent in WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !dent.file_type().is_file() {
            continue;
        }
        files_scanned += 1;

        let path = dent.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_ascii_lowercase(),
            None => continue,
        };

        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let full = path.to_string_lossy().to_string();
        let dir = parent_dir(path);

        match ext.as_str() {
            "jpg" | "jpeg" => {
                let e = entries.entry(stem).or_default();
                e.jpg_path = Some(full);
                e.jpg_dir = Some(dir);
            }
            "arw" => {
                let e = entries.entry(stem).or_default();
                e.arw_path = Some(full);
                e.arw_dir = Some(dir);
            }
            _ => {}
        }

        // Report progress every 200 scanned files.
        if files_scanned % 200 == 0 {
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    files_scanned,
                    images_found: entries.len(),
                },
            );
        }
    }

    // Final progress event (100%).
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            files_scanned,
            images_found: entries.len(),
        },
    );

    // Assemble the result. source_dir: prefer the JPG directory, else the ARW one.
    let mut photos: Vec<Photo> = entries
        .into_iter()
        .map(|(base_name, e)| Photo {
            base_name,
            jpg_path: e.jpg_path,
            arw_path: e.arw_path,
            source_dir: e.jpg_dir.or(e.arw_dir).unwrap_or_default(),
        })
        .collect();

    // Sort by base name — the camera's sequential order.
    photos.sort_by(|a, b| a.base_name.cmp(&b.base_name));

    Ok(photos)
}
