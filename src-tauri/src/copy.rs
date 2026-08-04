use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::manifest::{load_manifest, save_manifest, ManifestEntry};

/// One accepted photo to copy, sent from the frontend.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyJob {
    pub base_name: String,
    pub jpg_path: Option<String>,
    pub arw_path: Option<String>,
    /// SHA-256 of the JPG (present only when the photo has a JPG).
    pub jpg_hash: Option<String>,
    /// Copy the companion ARW too (ignored for ARW-only photos, which always copy).
    pub include_arw: bool,
    /// New base name, or empty/None to keep the original.
    pub new_name: Option<String>,
}

/// Result of the whole copy batch.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    /// Photos copied successfully.
    pub copied: usize,
    /// Individual files written (JPG + ARW).
    pub files_copied: usize,
    /// Per-photo error messages (batch continues past failures).
    pub errors: Vec<String>,
}

/// Copy progress (event `copy://progress`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CopyProgress {
    done: usize,
    total: usize,
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string()
}

/// Build a candidate file name: `base` + optional `_n` suffix + `.ext`.
fn candidate(dir: &Path, base: &str, n: usize, ext: &str) -> PathBuf {
    let name = if n == 0 {
        format!("{base}.{ext}")
    } else {
        format!("{base}_{n}.{ext}")
    };
    dir.join(name)
}

/// Copy accepted photos into the destination folder following the rules in
/// CLAUDE.md. Never modifies the source — copy only. Updates the manifest
/// atomically after each photo (crash-safe idempotency).
#[tauri::command]
pub async fn copy_accepted(
    app: AppHandle,
    dest_dir: String,
    jobs: Vec<CopyJob>,
) -> Result<CopyReport, String> {
    tauri::async_runtime::spawn_blocking(move || copy_blocking(&app, &dest_dir, jobs))
        .await
        .map_err(|e| format!("Copy task aborted: {e}"))?
}

fn copy_blocking(
    app: &AppHandle,
    dest_dir: &str,
    jobs: Vec<CopyJob>,
) -> Result<CopyReport, String> {
    let dest = Path::new(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Destination folder does not exist: {dest_dir}"));
    }

    let mut manifest = load_manifest(dest_dir)?;
    let total = jobs.len();
    let mut report = CopyReport {
        copied: 0,
        files_copied: 0,
        errors: Vec::new(),
    };

    for (i, job) in jobs.into_iter().enumerate() {
        match copy_one(dest, &job, &mut manifest, dest_dir) {
            Ok(files) => {
                report.copied += 1;
                report.files_copied += files;
            }
            Err(e) => report.errors.push(format!("{}: {e}", job.base_name)),
        }

        let _ = app.emit(
            "copy://progress",
            CopyProgress {
                done: i + 1,
                total,
            },
        );
    }

    Ok(report)
}

/// Copy a single photo. Returns the number of files written.
fn copy_one(
    dest: &Path,
    job: &CopyJob,
    manifest: &mut crate::manifest::Manifest,
    dest_dir: &str,
) -> Result<usize, String> {
    // Renamed when a non-empty new name was given → goes to `unique/`.
    let new_name = job
        .new_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let renamed = new_name.is_some();
    let target_base = new_name.unwrap_or(&job.base_name);

    let root = if renamed { dest.join("unique") } else { dest.to_path_buf() };
    let jpg_dir = root.join("jpg");
    let raw_dir = root.join("raw");

    let has_jpg = job.jpg_path.is_some();
    // JPG present: copy the ARW only if toggled. ARW-only: always copy the ARW.
    let copy_arw = job.arw_path.is_some() && (job.include_arw || !has_jpg);

    let jpg_ext = job.jpg_path.as_deref().map(extension_of);
    let arw_ext = job.arw_path.as_deref().map(extension_of);

    // Resolve a suffix that is free for every file we're about to write, so the
    // JPG and ARW of a pair keep a common base name.
    let mut n = 0usize;
    loop {
        let jpg_free = match (&job.jpg_path, &jpg_ext) {
            (Some(_), Some(ext)) => !candidate(&jpg_dir, target_base, n, ext).exists(),
            _ => true,
        };
        let arw_free = if copy_arw {
            match &arw_ext {
                Some(ext) => !candidate(&raw_dir, target_base, n, ext).exists(),
                None => true,
            }
        } else {
            true
        };
        if jpg_free && arw_free {
            break;
        }
        n += 1;
    }

    let mut files = 0usize;
    let mut target_jpg_path: Option<String> = None;
    let mut target_arw_path: Option<String> = None;

    // Copy JPG (if present).
    if let (Some(src), Some(ext)) = (&job.jpg_path, &jpg_ext) {
        std::fs::create_dir_all(&jpg_dir)
            .map_err(|e| format!("Cannot create {}: {e}", jpg_dir.display()))?;
        let dst = candidate(&jpg_dir, target_base, n, ext);
        std::fs::copy(src, &dst).map_err(|e| format!("Cannot copy JPG: {e}"))?;
        target_jpg_path = Some(dst.to_string_lossy().to_string());
        files += 1;
    }

    // Copy ARW (if applicable).
    if copy_arw {
        if let (Some(src), Some(ext)) = (&job.arw_path, &arw_ext) {
            std::fs::create_dir_all(&raw_dir)
                .map_err(|e| format!("Cannot create {}: {e}", raw_dir.display()))?;
            let dst = candidate(&raw_dir, target_base, n, ext);
            std::fs::copy(src, &dst).map_err(|e| format!("Cannot copy ARW: {e}"))?;
            target_arw_path = Some(dst.to_string_lossy().to_string());
            files += 1;
        }
    }

    // Record in the manifest (keyed by JPG hash) and persist atomically.
    // ARW-only photos have no JPG hash, so they aren't deduped by manifest.
    if let (Some(hash), Some(jpg_target)) = (&job.jpg_hash, &target_jpg_path) {
        manifest.entries.insert(
            hash.clone(),
            ManifestEntry {
                original_name: job.base_name.clone(),
                target_name: target_base.to_string(),
                target_jpg_path: jpg_target.clone(),
                target_arw_path: target_arw_path.clone(),
                renamed,
                date: chrono::Utc::now().to_rfc3339(),
            },
        );
        if manifest.version == 0 {
            manifest.version = 1;
        }
        save_manifest(dest_dir, manifest)?;
    }

    Ok(files)
}
