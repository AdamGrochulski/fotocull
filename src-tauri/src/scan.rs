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

/// A JPG or ARW found during the walk, before pairing.
struct FoundFile {
    dir: String,
    stem: String,
    full: String,
    is_raw: bool,
}

/// Accumulator for one pair while grouping.
#[derive(Default)]
struct Entry {
    stem: String,
    jpg_path: Option<String>,
    arw_path: Option<String>,
    jpg_dir: Option<String>,
    arw_dir: Option<String>,
}

impl Entry {
    fn into_photo(self) -> Photo {
        Photo {
            base_name: self.stem,
            jpg_path: self.jpg_path,
            arw_path: self.arw_path,
            source_dir: self.jpg_dir.or(self.arw_dir).unwrap_or_default(),
        }
    }
}

fn parent_dir(p: &Path) -> String {
    p.parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Group JPG and ARW files into photos.
///
/// A pair is a JPG and an ARW with the same stem in the **same folder**. Cards
/// reuse file numbers across folders (`100MSDCF/DSC00001` and
/// `101MSDCF/DSC00001` after a counter reset, or two cameras dumped into one
/// folder), so pairing by stem alone would silently drop a photo or marry one
/// shot's JPG to another shot's RAW. As a fallback, a lone JPG and a lone ARW
/// in different folders are paired only when the stem is unambiguous: exactly
/// one unpaired file of each kind carries it.
fn pair_files(files: Vec<FoundFile>) -> Vec<Photo> {
    let mut entries: HashMap<(String, String), Entry> = HashMap::new();
    let mut extra: Vec<Entry> = Vec::new();

    for f in files {
        let key = (f.dir.clone(), f.stem.to_lowercase());
        let e = entries.entry(key).or_default();
        let slot_taken = if f.is_raw { e.arw_path.is_some() } else { e.jpg_path.is_some() };
        if slot_taken {
            // Same stem twice in one folder (e.g. `.jpg` next to `.jpeg`): keep
            // both as separate photos instead of overwriting.
            let mut alone = Entry { stem: f.stem, ..Default::default() };
            if f.is_raw {
                alone.arw_path = Some(f.full);
                alone.arw_dir = Some(f.dir);
            } else {
                alone.jpg_path = Some(f.full);
                alone.jpg_dir = Some(f.dir);
            }
            extra.push(alone);
            continue;
        }
        if e.stem.is_empty() {
            e.stem = f.stem;
        }
        if f.is_raw {
            e.arw_path = Some(f.full);
            e.arw_dir = Some(f.dir);
        } else {
            e.jpg_path = Some(f.full);
            e.jpg_dir = Some(f.dir);
        }
    }

    let mut done: Vec<Entry> = Vec::new();
    // Unpaired entries by lowercase stem, split by which half they hold.
    let mut lone_jpg: HashMap<String, Vec<Entry>> = HashMap::new();
    let mut lone_arw: HashMap<String, Vec<Entry>> = HashMap::new();
    for e in entries.into_values().chain(extra) {
        match (&e.jpg_path, &e.arw_path) {
            (Some(_), Some(_)) => done.push(e),
            (Some(_), None) => lone_jpg.entry(e.stem.to_lowercase()).or_default().push(e),
            _ => lone_arw.entry(e.stem.to_lowercase()).or_default().push(e),
        }
    }

    for (stem, mut jpgs) in lone_jpg {
        match lone_arw.remove(&stem) {
            Some(mut arws) if jpgs.len() == 1 && arws.len() == 1 => {
                let mut jpg = jpgs.pop().unwrap();
                let arw = arws.pop().unwrap();
                jpg.arw_path = arw.arw_path;
                jpg.arw_dir = arw.arw_dir;
                done.push(jpg);
            }
            Some(arws) => {
                done.extend(jpgs);
                done.extend(arws);
            }
            None => done.extend(jpgs),
        }
    }
    done.extend(lone_arw.into_values().flatten());

    let mut photos: Vec<Photo> = done.into_iter().map(Entry::into_photo).collect();
    // Camera order: by name, then folder so same-named shots stay predictable.
    photos.sort_by(|a, b| {
        a.base_name
            .cmp(&b.base_name)
            .then_with(|| a.source_dir.cmp(&b.source_dir))
    });
    photos
}

/// Whether `stem` is `base` followed by one letter and one or more digits — the
/// pattern Sony (XAVC S) uses for a clip's sidecar files: a thumbnail JPG
/// `C0001T01.JPG` or a low-res proxy `C0001S01.MP4` beside `C0001.MP4`.
fn companion_of(stem: &str, base: &str) -> bool {
    if let Some(rest) = stem.strip_prefix(base) {
        let mut chars = rest.chars();
        if let Some(first) = chars.next() {
            if first.is_ascii_uppercase() {
                let digits = chars.as_str();
                return !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit());
            }
        }
    }
    false
}

/// Whether a JPG stem is a camera-generated companion of a video clip, not a real
/// photo. Matches the sidecar pattern above, plus an exact stem match in case a
/// mode reuses the clip name verbatim.
fn is_video_companion(stem: &str, video_stems: &std::collections::HashSet<&str>) -> bool {
    video_stems.contains(stem) || video_stems.iter().any(|v| companion_of(stem, v))
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

    let mut found: Vec<FoundFile> = Vec::new();
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
            "jpg" | "jpeg" | "arw" => found.push(FoundFile {
                dir,
                stem,
                full,
                is_raw: ext == "arw",
            }),
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
        if files_scanned.is_multiple_of(200) {
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    files_scanned,
                    images_found: found.len(),
                },
            );
        }
    }

    // Final progress event (100%).
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            files_scanned,
            images_found: found.len(),
        },
    );

    // Drop XAVC S proxy clips (`C0001S01.MP4` beside `C0001.MP4`) — same content,
    // low-res. Keep only clips that aren't a sidecar of another clip.
    let all_stems: std::collections::HashSet<String> =
        videos.iter().map(|v| v.base_name.clone()).collect();
    videos.retain(|vid| {
        !all_stems
            .iter()
            .any(|other| other != &vid.base_name && companion_of(&vid.base_name, other))
    });

    // Cameras drop a small companion JPG next to each clip (e.g. `C0001T01.JPG`
    // beside `C0001.MP4`) as a video thumbnail. Those aren't real photos — drop
    // any entry that is a video companion so it never reaches the Photos tab.
    let video_stems: std::collections::HashSet<&str> =
        videos.iter().map(|v| v.base_name.as_str()).collect();

    let found: Vec<FoundFile> = found
        .into_iter()
        .filter(|f| f.is_raw || !is_video_companion(&f.stem, &video_stems))
        .collect();
    let photos = pair_files(found);
    videos.sort_by(|a, b| a.base_name.cmp(&b.base_name));

    Ok(ScanResult { photos, videos })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(dir: &str, name: &str) -> FoundFile {
        let (stem, ext) = name.rsplit_once('.').unwrap();
        FoundFile {
            dir: dir.to_string(),
            stem: stem.to_string(),
            full: format!("{dir}/{name}"),
            is_raw: ext.eq_ignore_ascii_case("arw"),
        }
    }

    fn summary(photos: &[Photo]) -> Vec<(String, Option<String>, Option<String>)> {
        photos
            .iter()
            .map(|p| (p.base_name.clone(), p.jpg_path.clone(), p.arw_path.clone()))
            .collect()
    }

    #[test]
    fn pairs_within_one_folder() {
        let photos = pair_files(vec![f("100", "DSC1.JPG"), f("100", "DSC1.ARW")]);
        assert_eq!(
            summary(&photos),
            vec![("DSC1".into(), Some("100/DSC1.JPG".into()), Some("100/DSC1.ARW".into()))]
        );
    }

    #[test]
    fn same_stem_in_two_folders_stays_two_photos() {
        let photos = pair_files(vec![
            f("100", "DSC1.JPG"),
            f("100", "DSC1.ARW"),
            f("101", "DSC1.JPG"),
            f("101", "DSC1.ARW"),
        ]);
        assert_eq!(photos.len(), 2);
        for p in &photos {
            let jpg_dir = p.jpg_path.as_deref().unwrap().split('/').next();
            let arw_dir = p.arw_path.as_deref().unwrap().split('/').next();
            assert_eq!(jpg_dir, arw_dir, "JPG and ARW must come from the same folder");
        }
    }

    #[test]
    fn lone_jpg_never_borrows_another_folders_raw() {
        // 100 has a full pair, 101 only a JPG: the 101 JPG must stay JPG-only.
        let photos = pair_files(vec![
            f("100", "DSC1.JPG"),
            f("100", "DSC1.ARW"),
            f("101", "DSC1.JPG"),
        ]);
        assert_eq!(photos.len(), 2);
        let lone = photos.iter().find(|p| p.arw_path.is_none()).unwrap();
        assert_eq!(lone.jpg_path.as_deref(), Some("101/DSC1.JPG"));
    }

    #[test]
    fn unambiguous_split_pair_is_joined_across_folders() {
        let photos = pair_files(vec![f("jpg", "DSC7.JPG"), f("raw", "DSC7.ARW")]);
        assert_eq!(
            summary(&photos),
            vec![("DSC7".into(), Some("jpg/DSC7.JPG".into()), Some("raw/DSC7.ARW".into()))]
        );
    }

    #[test]
    fn ambiguous_split_pairs_stay_apart() {
        let photos = pair_files(vec![
            f("a", "DSC7.JPG"),
            f("b", "DSC7.JPG"),
            f("c", "DSC7.ARW"),
        ]);
        assert_eq!(photos.len(), 3);
        assert!(photos.iter().all(|p| p.jpg_path.is_none() || p.arw_path.is_none()));
    }

    #[test]
    fn jpg_and_jpeg_with_one_stem_are_both_kept() {
        let photos = pair_files(vec![f("100", "IMG1.jpg"), f("100", "IMG1.jpeg")]);
        assert_eq!(photos.len(), 2);
    }

    #[test]
    fn stem_case_does_not_break_a_pair() {
        let photos = pair_files(vec![f("100", "dsc1.jpg"), f("100", "DSC1.ARW")]);
        assert_eq!(photos.len(), 1);
        assert!(photos[0].jpg_path.is_some() && photos[0].arw_path.is_some());
    }
}
