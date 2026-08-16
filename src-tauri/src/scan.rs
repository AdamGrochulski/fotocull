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

/// One video clip (standalone `.mp4` — no pairing, no ARW companion).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    /// Base name without extension, e.g. "MAH00001".
    pub base_name: String,
    /// Full path to the MP4 file.
    pub path: String,
    /// Directory the clip lives in.
    pub source_dir: String,
}

/// Result of a single source walk: photo pairs and video clips.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub photos: Vec<Photo>,
    pub videos: Vec<Video>,
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

/// Recursively scan the source directory. Collects .jpg/.jpeg/.arw photo pairs
/// and standalone .mp4 clips (case-insensitive). Read-only — changes nothing.
/// Reports progress via `scan://progress` events.
#[tauri::command]
pub async fn scan_source(app: AppHandle, path: String) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || scan_blocking(&app, &path))
        .await
        .map_err(|e| format!("Scan task aborted: {e}"))?
}

fn scan_blocking(app: &AppHandle, root: &str) -> Result<ScanResult, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("Source folder does not exist: {root}"));
    }

    // Map key: base name (stem) — pairing is independent of directory.
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let mut videos: Vec<Video> = Vec::new();
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
            "mp4" => {
                videos.push(Video {
                    base_name: stem,
                    path: full,
                    source_dir: dir,
                });
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

    // Cameras drop a small companion JPG next to each clip (same base name) as a
    // video thumbnail. Those aren't real photos — drop any entry whose base name
    // matches a video so the thumbnail doesn't show up in the Photos tab.
    let video_stems: std::collections::HashSet<&str> =
        videos.iter().map(|v| v.base_name.as_str()).collect();

    // Assemble the result. source_dir: prefer the JPG directory, else the ARW one.
    let mut photos: Vec<Photo> = entries
        .into_iter()
        .filter(|(base_name, _)| !video_stems.contains(base_name.as_str()))
        .map(|(base_name, e)| Photo {
            base_name,
            jpg_path: e.jpg_path,
            arw_path: e.arw_path,
            source_dir: e.jpg_dir.or(e.arw_dir).unwrap_or_default(),
        })
        .collect();

    // Sort by base name — the camera's sequential order.
    photos.sort_by(|a, b| a.base_name.cmp(&b.base_name));
    videos.sort_by(|a, b| a.base_name.cmp(&b.base_name));

    Ok(ScanResult { photos, videos })
}
