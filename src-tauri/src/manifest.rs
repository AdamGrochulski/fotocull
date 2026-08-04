use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// Manifest entry: what was copied and where. The map key is the SHA-256 of the
/// JPG file (identity by content, not by name).
/// Entries are written on accept (Stage 5); here we only read.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub original_name: String,
    pub target_name: String,
    pub target_jpg_path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_arw_path: Option<String>,
    pub renamed: bool,
    pub date: String,
}

/// Contents of `.fotocull/manifest.json`.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub version: u32,
    /// JPG hash → entry.
    #[serde(default)]
    pub entries: HashMap<String, ManifestEntry>,
}

/// Path to the manifest file inside the destination folder.
pub fn manifest_path(dest_dir: &str) -> PathBuf {
    Path::new(dest_dir).join(".fotocull").join("manifest.json")
}

/// Load the manifest from the destination folder. A missing file means an empty
/// manifest (nothing is created on disk until the first write in Stage 5).
pub fn load_manifest(dest_dir: &str) -> Result<Manifest, String> {
    let path = manifest_path(dest_dir);
    if !path.exists() {
        return Ok(Manifest::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read manifest: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Corrupted manifest: {e}"))
}

/// Save the manifest atomically: write to a temp file in the same directory,
/// then rename over the target. A crash mid-write can't corrupt the manifest.
pub fn save_manifest(dest_dir: &str, manifest: &Manifest) -> Result<(), String> {
    let path = manifest_path(dest_dir);
    let dir = path
        .parent()
        .ok_or_else(|| "Invalid manifest path".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Cannot create .fotocull directory: {e}"))?;

    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Cannot serialize manifest: {e}"))?;

    let tmp = dir.join("manifest.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Cannot write manifest: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot commit manifest: {e}"))?;
    Ok(())
}

/// SHA-256 of a file's contents (hex). Reads in a stream — safe for large JPGs.
pub fn hash_file(path: &str) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Read error {path}: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Command: SHA-256 of a single JPG file.
#[tauri::command]
pub fn hash_jpg(path: String) -> Result<String, String> {
    hash_file(&path)
}

/// Result of matching one JPG against the manifest.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HashResult {
    pub path: String,
    pub hash: String,
    /// Hash already in the manifest → the photo was copied before.
    pub already_copied: bool,
}

/// Hashing progress (event `hash://progress`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HashProgress {
    hashed: usize,
    total: usize,
}

/// Hash the given JPG files and mark which ones are already in the destination
/// folder's manifest. The frontend uses this to filter out already-moved photos.
#[tauri::command]
pub async fn filter_by_manifest(
    app: AppHandle,
    dest_dir: String,
    jpg_paths: Vec<String>,
) -> Result<Vec<HashResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = load_manifest(&dest_dir)?;
        let total = jpg_paths.len();
        let done = AtomicUsize::new(0);

        // Hash in parallel: reading each JPG from the card and computing SHA-256
        // is the slow part, so overlap I/O and spread the hashing across cores.
        // Output order doesn't matter — the frontend maps results back by path.
        let results: Vec<Result<HashResult, String>> = jpg_paths
            .par_iter()
            .map(|path| {
                let hash = hash_file(path)?;
                let already_copied = manifest.entries.contains_key(&hash);

                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 20 == 0 || n == total {
                    let _ = app.emit(
                        "hash://progress",
                        HashProgress { hashed: n, total },
                    );
                }

                Ok(HashResult {
                    path: path.clone(),
                    hash,
                    already_copied,
                })
            })
            .collect();

        let mut out = Vec::with_capacity(total);
        for r in results {
            out.push(r?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("Hashing task aborted: {e}"))?
}
