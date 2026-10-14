use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::manifest::{hash_file, load_manifest, save_manifest, ManifestEntry, VideoEntry};
use crate::names::sanitize_name;

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

/// Suffix of an in-flight copy. A file only gets its real name once its bytes
/// are on disk and verified, so an interrupted copy never looks finished.
const PART_SUFFIX: &str = ".fotocull-part";

fn part_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().unwrap_or_default().to_os_string();
    name.push(PART_SUFFIX);
    dst.with_file_name(name)
}

/// Copy `src` to `dst` safely: stream into `<dst>.fotocull-part` while hashing
/// the source bytes, flush to disk, re-read the copy and compare hashes, and
/// only then rename it into place. Returns the SHA-256 of the content.
/// On any failure the partial file is removed. Never touches `src`.
fn copy_verified(src: &Path, dst: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let tmp = part_path(dst);
    let result = (|| {
        let mut input =
            std::fs::File::open(src).map_err(|e| format!("cannot open {}: {e}", src.display()))?;
        let mut output = std::fs::File::create(&tmp)
            .map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = input
                .read(&mut buf)
                .map_err(|e| format!("read error in {}: {e}", src.display()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            output
                .write_all(&buf[..n])
                .map_err(|e| format!("write error in {}: {e}", tmp.display()))?;
        }
        output
            .sync_all()
            .map_err(|e| format!("cannot flush {}: {e}", tmp.display()))?;
        drop(output);

        let source_hash = format!("{:x}", hasher.finalize());
        let copy_hash = hash_file(&tmp.to_string_lossy())?;
        if copy_hash != source_hash {
            return Err(format!("copy of {} is corrupted (hash mismatch)", src.display()));
        }
        std::fs::rename(&tmp, dst).map_err(|e| format!("cannot finish {}: {e}", dst.display()))?;
        Ok(source_hash)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Remove `*.fotocull-part` leftovers of an interrupted earlier run. They are
/// only ever created by this app inside the destination's own sub-folders.
fn remove_stale_parts(dest: &Path) {
    for sub in ["jpg", "raw", "video", "unique/jpg", "unique/raw", "unique/video"] {
        let Ok(entries) = std::fs::read_dir(dest.join(sub)) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(PART_SUFFIX) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
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

    remove_stale_parts(dest);
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
    // Renamed when a usable new name was given → goes to `unique/`. The name is
    // sanitized here too, so nothing typed can leave the destination folder.
    let new_name = job.new_name.as_deref().and_then(sanitize_name);
    let renamed = new_name.is_some();
    let target_base = new_name.as_deref().unwrap_or(&job.base_name);

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
        let hash = copy_verified(Path::new(src), &dst).map_err(|e| format!("JPG: {e}"))?;
        if job.jpg_hash.as_deref().is_some_and(|h| h != hash) {
            // The card changed since the scan: don't record a stale identity.
            let _ = std::fs::remove_file(&dst);
            return Err("JPG changed on the card since the scan; scan again".to_string());
        }
        target_jpg_path = Some(dst.to_string_lossy().to_string());
        files += 1;
    }

    // Copy ARW (if applicable). A half-copied pair is rolled back, so a failed
    // ARW never leaves a lone JPG that would be copied again as `_1` next time.
    if copy_arw {
        if let (Some(src), Some(ext)) = (&job.arw_path, &arw_ext) {
            let dst = candidate(&raw_dir, target_base, n, ext);
            let copied = std::fs::create_dir_all(&raw_dir)
                .map_err(|e| format!("Cannot create {}: {e}", raw_dir.display()))
                .and_then(|_| copy_verified(Path::new(src), &dst).map_err(|e| format!("ARW: {e}")));
            if let Err(e) = copied {
                if let Some(jpg) = &target_jpg_path {
                    let _ = std::fs::remove_file(jpg);
                }
                return Err(e);
            }
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

/// One accepted video clip to copy, sent from the frontend.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJob {
    pub base_name: String,
    pub path: String,
    /// SHA-256 of the MP4 (for manifest dedup).
    pub hash: Option<String>,
    /// New base name, or empty/None to keep the original.
    pub new_name: Option<String>,
}

/// Copy accepted video clips into the destination folder. Default-named clips go
/// to `video/`, renamed ones to `unique/video/`. Never modifies the source.
/// Updates the manifest's `videos` map atomically after each clip.
#[tauri::command]
pub async fn copy_videos(
    app: AppHandle,
    dest_dir: String,
    jobs: Vec<VideoJob>,
) -> Result<CopyReport, String> {
    tauri::async_runtime::spawn_blocking(move || copy_videos_blocking(&app, &dest_dir, jobs))
        .await
        .map_err(|e| format!("Video copy task aborted: {e}"))?
}

fn copy_videos_blocking(
    app: &AppHandle,
    dest_dir: &str,
    jobs: Vec<VideoJob>,
) -> Result<CopyReport, String> {
    let dest = Path::new(dest_dir);
    if !dest.is_dir() {
        return Err(format!("Destination folder does not exist: {dest_dir}"));
    }

    remove_stale_parts(dest);
    let mut manifest = load_manifest(dest_dir)?;
    let total = jobs.len();
    let mut report = CopyReport {
        copied: 0,
        files_copied: 0,
        errors: Vec::new(),
    };

    for (i, job) in jobs.into_iter().enumerate() {
        match copy_one_video(dest, &job, &mut manifest, dest_dir) {
            Ok(files) => {
                report.copied += 1;
                report.files_copied += files;
            }
            Err(e) => report.errors.push(format!("{}: {e}", job.base_name)),
        }

        let _ = app.emit("copy://progress", CopyProgress { done: i + 1, total });
    }

    Ok(report)
}

fn copy_one_video(
    dest: &Path,
    job: &VideoJob,
    manifest: &mut crate::manifest::Manifest,
    dest_dir: &str,
) -> Result<usize, String> {
    let new_name = job.new_name.as_deref().and_then(sanitize_name);
    let renamed = new_name.is_some();
    let target_base = new_name.as_deref().unwrap_or(&job.base_name);

    let dir = if renamed {
        dest.join("unique").join("video")
    } else {
        dest.join("video")
    };
    let ext = extension_of(&job.path);

    // Find a free suffix so a name clash doesn't overwrite an earlier clip.
    let mut n = 0usize;
    while candidate(&dir, target_base, n, &ext).exists() {
        n += 1;
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    let dst = candidate(&dir, target_base, n, &ext);
    copy_verified(Path::new(&job.path), &dst).map_err(|e| format!("MP4: {e}"))?;
    let target_path = dst.to_string_lossy().to_string();

    if let Some(hash) = &job.hash {
        manifest.videos.insert(
            hash.clone(),
            VideoEntry {
                original_name: job.base_name.clone(),
                target_name: target_base.to_string(),
                target_path,
                renamed,
                date: chrono::Utc::now().to_rfc3339(),
            },
        );
        if manifest.version == 0 {
            manifest.version = 1;
        }
        save_manifest(dest_dir, manifest)?;
    }

    Ok(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;

    /// Fresh scratch folder under the system temp dir, unique per test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fotocull-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn job(src: &Path, base: &str, arw: bool, new_name: Option<&str>) -> CopyJob {
        let jpg = src.join(format!("{base}.JPG"));
        std::fs::write(&jpg, format!("jpg bytes of {base}")).unwrap();
        CopyJob {
            base_name: base.to_string(),
            jpg_path: Some(jpg.to_string_lossy().to_string()),
            arw_path: arw.then(|| src.join(format!("{base}.ARW")).to_string_lossy().to_string()),
            jpg_hash: None,
            include_arw: arw,
            new_name: new_name.map(str::to_string),
        }
    }

    #[test]
    fn verified_copy_leaves_no_part_file() {
        let dir = scratch("verify");
        let src = dir.join("a.bin");
        std::fs::write(&src, vec![7u8; 3 * 1024 * 1024 + 11]).unwrap();
        let dst = dir.join("b.bin");
        let hash = copy_verified(&src, &dst).unwrap();
        assert_eq!(hash, hash_file(&src.to_string_lossy()).unwrap());
        assert_eq!(std::fs::read(&dst).unwrap(), std::fs::read(&src).unwrap());
        assert!(!part_path(&dst).exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_arw_rolls_back_the_jpg() {
        let root = scratch("rollback");
        let (src, dest) = (root.join("card"), root.join("dest"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        // The ARW is announced but missing on the card, so its copy fails.
        let j = job(&src, "DSC1", true, None);
        let mut manifest = Manifest::default();
        let err = copy_one(&dest, &j, &mut manifest, &dest.to_string_lossy());
        assert!(err.is_err());
        assert!(!dest.join("jpg/DSC1.JPG").exists(), "JPG must be rolled back");
        assert!(manifest.entries.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn name_clash_suffixes_both_files_of_a_pair() {
        let root = scratch("clash");
        let (src, dest) = (root.join("card"), root.join("dest"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(dest.join("jpg")).unwrap();
        std::fs::write(dest.join("jpg/DSC1.JPG"), b"older").unwrap();
        let j = job(&src, "DSC1", true, None);
        std::fs::write(src.join("DSC1.ARW"), b"raw bytes").unwrap();
        let mut manifest = Manifest::default();
        let files = copy_one(&dest, &j, &mut manifest, &dest.to_string_lossy()).unwrap();
        assert_eq!(files, 2);
        assert!(dest.join("jpg/DSC1_1.JPG").exists());
        assert!(dest.join("raw/DSC1_1.ARW").exists());
        assert_eq!(std::fs::read(dest.join("jpg/DSC1.JPG")).unwrap(), b"older");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hostile_rename_stays_inside_unique() {
        let root = scratch("rename");
        let (src, dest) = (root.join("card"), root.join("dest"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        let j = job(&src, "DSC1", false, Some("../../escape 14/10"));
        let mut manifest = Manifest::default();
        copy_one(&dest, &j, &mut manifest, &dest.to_string_lossy()).unwrap();
        assert!(dest.join("unique/jpg/-..-escape 14-10.JPG").exists());
        assert!(!root.join("escape 14").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
