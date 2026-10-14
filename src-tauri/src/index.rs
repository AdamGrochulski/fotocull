use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::exif::{parse_meta, parse_meta_file, MediaMeta};
use crate::manifest::load_manifest;

/// Hashes and EXIF of files seen before, so a rescan of the same card reads
/// only new files instead of every byte again. Lives in the app cache dir.
const CACHE_FILE: &str = "index-cache.json";
const CACHE_VERSION: u32 = 1;
/// Entries not seen for this long are dropped on save.
const CACHE_MAX_AGE_SECS: i64 = 365 * 24 * 3600;

#[derive(Serialize, Deserialize, Default)]
struct IndexCache {
    #[serde(default)]
    version: u32,
    /// `path \x1f size \x1f mtime_ns` → what we learned about that file.
    #[serde(default)]
    entries: HashMap<String, CachedFile>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedFile {
    hash: String,
    #[serde(default)]
    meta: Option<MediaMeta>,
    /// Unix seconds of the last scan that saw the file.
    seen: i64,
}

static CACHE: Mutex<Option<IndexCache>> = Mutex::new(None);

/// One indexed file: its content hash (identity), whether the destination's
/// manifest already has it, and its EXIF. A file that can't be read gets an
/// `error` instead of failing the whole scan.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub path: String,
    pub hash: Option<String>,
    pub already_copied: bool,
    pub meta: Option<MediaMeta>,
    pub error: Option<String>,
}

/// Progress of `index_media` (event `index://progress`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IndexProgress {
    done: usize,
    total: usize,
    kind: String,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join(CACHE_FILE))
}

fn load_cache(path: &Path) -> IndexCache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<IndexCache>(&s).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or(IndexCache {
            version: CACHE_VERSION,
            entries: HashMap::new(),
        })
}

/// Write the cache via temp + rename. Losing it only costs a slower next scan,
/// so failures are ignored.
fn save_cache(path: &Path, cache: &IndexCache) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(json) = serde_json::to_string(cache) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Cache key: a file is "the same" while its path, size and mtime are.
fn file_key(path: &str) -> Result<String, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("cannot stat: {e}"))?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(format!("{path}\u{1f}{}\u{1f}{mtime}", md.len()))
}

/// Fill `buf` as far as the file allows (a single `read` may return less).
fn read_full(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// SHA-256 of the whole file, plus EXIF parsed from the first chunk of the
/// same read, so the card is read exactly once per new file.
fn hash_and_meta(path: &str, want_meta: bool) -> Result<(String, Option<MediaMeta>), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("cannot open: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];

    let n = read_full(&mut file, &mut buf).map_err(|e| format!("read error: {e}"))?;
    hasher.update(&buf[..n]);
    let mut meta = if want_meta { parse_meta(&buf[..n]) } else { None };

    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read error: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    if want_meta && meta.is_none() {
        // RAW containers can keep EXIF IFDs past the first chunk.
        meta = parse_meta_file(path);
    }
    Ok((format!("{:x}", hasher.finalize()), meta))
}

/// Hash the given files (photo identity files or MP4 clips), read their EXIF,
/// and mark which ones the destination's manifest already holds.
///
/// `kind` is `"photo"` or `"video"`. Results already known from an earlier scan
/// come from the cache without touching the file's contents. Read-only.
#[tauri::command]
pub async fn index_media(
    app: AppHandle,
    dest_dir: String,
    paths: Vec<String>,
    kind: String,
) -> Result<Vec<IndexResult>, String> {
    tauri::async_runtime::spawn_blocking(move || index_blocking(&app, &dest_dir, paths, &kind))
        .await
        .map_err(|e| format!("Indexing task aborted: {e}"))?
}

fn index_blocking(
    app: &AppHandle,
    dest_dir: &str,
    paths: Vec<String>,
    kind: &str,
) -> Result<Vec<IndexResult>, String> {
    let manifest = load_manifest(dest_dir)?;
    let photos = kind == "photo";
    // Photo entries are keyed by the identity hash; a pair copied with its ARW
    // also records the ARW's hash, so a later ARW-only view of it is known too.
    let known: HashSet<&str> = if photos {
        manifest
            .entries
            .iter()
            .flat_map(|(k, e)| std::iter::once(k.as_str()).chain(e.arw_hash.as_deref()))
            .collect()
    } else {
        manifest.videos.keys().map(String::as_str).collect()
    };

    let cache_file = cache_path(app);
    if let Some(cf) = &cache_file {
        let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(load_cache(cf));
        }
    }
    let cached = |key: &str| -> Option<CachedFile> {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref()?.entries.get(key).cloned()
    };

    let total = paths.len();
    let done = AtomicUsize::new(0);
    let step = if photos { 10 } else { 1 };

    // Card reads dominate; rayon overlaps them with hashing across cores.
    let results: Vec<(IndexResult, Option<(String, CachedFile)>)> = paths
        .par_iter()
        .map(|path| {
            let outcome = file_key(path).and_then(|key| match cached(&key) {
                Some(hit) => Ok((key, hit)),
                None => hash_and_meta(path, photos).map(|(hash, meta)| {
                    (key, CachedFile { hash, meta, seen: 0 })
                }),
            });

            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_multiple_of(step) || n == total {
                let _ = app.emit(
                    "index://progress",
                    IndexProgress { done: n, total, kind: kind.to_string() },
                );
            }

            match outcome {
                Ok((key, file)) => (
                    IndexResult {
                        path: path.clone(),
                        already_copied: known.contains(file.hash.as_str()),
                        hash: Some(file.hash.clone()),
                        meta: file.meta.clone(),
                        error: None,
                    },
                    Some((key, file)),
                ),
                Err(e) => (
                    IndexResult {
                        path: path.clone(),
                        hash: None,
                        already_copied: false,
                        meta: None,
                        error: Some(e),
                    },
                    None,
                ),
            }
        })
        .collect();

    // Record what we learned (and refresh `seen` on hits), then persist.
    if let Some(cf) = &cache_file {
        let now = now_secs();
        let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cache) = guard.as_mut() {
            for (key, mut file) in results.iter().filter_map(|(_, c)| c.clone()) {
                file.seen = now;
                cache.entries.insert(key, file);
            }
            cache.entries.retain(|_, f| now - f.seen < CACHE_MAX_AGE_SECS);
            save_cache(cf, cache);
        }
    }

    Ok(results.into_iter().map(|(r, _)| r).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_manifest_hash_and_reads_no_meta_from_plain_bytes() {
        let dir = std::env::temp_dir().join(format!("fotocull-index-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.bin");
        std::fs::write(&p, vec![42u8; 2 * 1024 * 1024 + 5]).unwrap();
        let path = p.to_string_lossy().to_string();
        let (hash, meta) = hash_and_meta(&path, true).unwrap();
        assert_eq!(hash, crate::manifest::hash_file(&path).unwrap());
        assert!(meta.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn key_changes_when_the_file_changes() {
        let dir = std::env::temp_dir().join(format!("fotocull-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("k.bin");
        std::fs::write(&p, b"one").unwrap();
        let a = file_key(&p.to_string_lossy()).unwrap();
        std::fs::write(&p, b"three").unwrap();
        let b = file_key(&p.to_string_lossy()).unwrap();
        assert_ne!(a, b);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
