use std::io::BufReader;

use exif::{In, Tag};
use serde::Serialize;

/// Shooting parameters read from a JPG's EXIF block. Every field is optional —
/// older files or edited exports may be missing any of them.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    /// Aperture, e.g. "f/2.8".
    pub aperture: Option<String>,
    /// Shutter speed, e.g. "1/250 s".
    pub shutter: Option<String>,
    /// ISO sensitivity, e.g. "400".
    pub iso: Option<String>,
    /// Focal length, e.g. "35 mm".
    pub focal_length: Option<String>,
    /// Lens model string.
    pub lens: Option<String>,
}

/// Read shooting EXIF from a JPG. Read-only, off the UI thread. A file with no
/// EXIF (or an unreadable one) yields an empty result rather than an error, so
/// the UI simply shows nothing.
#[tauri::command]
pub async fn read_exif(path: String) -> Result<ExifInfo, String> {
    tauri::async_runtime::spawn_blocking(move || read_blocking(&path))
        .await
        .map_err(|e| format!("EXIF task aborted: {e}"))?
}

fn read_blocking(path: &str) -> Result<ExifInfo, String> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(ExifInfo::default()),
    };
    let mut reader = BufReader::new(&file);
    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return Ok(ExifInfo::default()), // no/invalid EXIF — not an error
    };

    // Human-readable value of a tag, with its unit (e.g. "35 mm", "f/2.8").
    let field = |tag: Tag| -> Option<String> {
        exif.get_field(tag, In::PRIMARY).map(|f| {
            f.display_value().with_unit(&exif).to_string().trim().to_string()
        })
    };
    // First present tag from a list (for fields with legacy/alternate tags).
    let first = |tags: &[Tag]| -> Option<String> {
        tags.iter().copied().find_map(field)
    };

    Ok(ExifInfo {
        aperture: first(&[Tag::FNumber, Tag::ApertureValue]),
        shutter: field(Tag::ExposureTime),
        iso: first(&[Tag::PhotographicSensitivity, Tag::StandardOutputSensitivity]),
        focal_length: field(Tag::FocalLength),
        lens: field(Tag::LensModel).filter(|s| !s.is_empty()),
    })
}
