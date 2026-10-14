use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Manifest entry: what was copied and where. The map key is the SHA-256 of the
/// photo's identity file: its JPG, or its ARW when there is no JPG (identity by
/// content, not by name).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub original_name: String,
    pub target_name: String,
    /// Absent for ARW-only photos.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_jpg_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_arw_path: Option<String>,
    /// SHA-256 of the copied ARW, so the photo is recognised by either file.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub arw_hash: Option<String>,
    pub renamed: bool,
    pub date: String,
}

/// Manifest entry for a video clip. Keyed by the SHA-256 of the MP4 file.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoEntry {
    pub original_name: String,
    pub target_name: String,
    pub target_path: String,
    pub renamed: bool,
    pub date: String,
}

/// Contents of `.fotocull/manifest.json`.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub version: u32,
    /// Identity hash (JPG, else ARW) → entry.
    #[serde(default)]
    pub entries: HashMap<String, ManifestEntry>,
    /// MP4 hash → entry. Videos are deduped independently of photos.
    #[serde(default)]
    pub videos: HashMap<String, VideoEntry>,
}

/// Path to the manifest file inside the destination folder.
pub fn manifest_path(dest_dir: &str) -> PathBuf {
    Path::new(dest_dir).join(".fotocull").join("manifest.json")
}

/// Load the manifest from the destination folder. A missing file means an empty
/// manifest (nothing is created on disk until the first copy).
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

    // Flush the temp file before the rename: otherwise a power cut or a yanked
    // drive can persist the rename but not the data, leaving an empty manifest.
    let tmp = dir.join("manifest.json.tmp");
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("Cannot write manifest: {e}"))?;
    std::io::Write::write_all(&mut file, json.as_bytes())
        .map_err(|e| format!("Cannot write manifest: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Cannot flush manifest: {e}"))?;
    drop(file);
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot commit manifest: {e}"))?;
    Ok(())
}

/// SHA-256 of a file's contents (hex). Reads in a stream, so large files are fine.
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

/// Command: distinct target names previously assigned to renamed photos in this
/// destination's manifest. Feeds the rename autocomplete so recurring names
/// (people, sessions) come back as suggestions. Sorted, deduplicated.
#[tauri::command]
pub fn renamed_targets(dest_dir: String) -> Result<Vec<String>, String> {
    let manifest = load_manifest(&dest_dir)?;
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in manifest.entries.values() {
        if entry.renamed && !entry.target_name.is_empty() {
            set.insert(entry.target_name.clone());
        }
    }
    // Video rename history feeds the same autocomplete pool.
    for entry in manifest.videos.values() {
        if entry.renamed && !entry.target_name.is_empty() {
            set.insert(entry.target_name.clone());
        }
    }
    Ok(set.into_iter().collect())
}
