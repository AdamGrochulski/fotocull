use std::io::{BufReader, Cursor};

use exif::{Exif, In, Tag, Value};
use serde::{Deserialize, Serialize};

/// What the app needs from a photo's EXIF, read once while the file is hashed
/// and cached with the hash. Every field is optional: phones, edited exports and
/// older cameras may omit any of them.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    /// Capture time as local `YYYY-MM-DDTHH:MM:SS[.fff]` (sortable as text).
    pub captured_at: Option<String>,
    /// EXIF orientation (1 = upright, 6/8 = rotated portrait, ...).
    pub orientation: Option<u16>,
    /// Display strings for the EXIF strip, e.g. "f/2.8", "1/250 s", "35 mm".
    pub aperture: Option<String>,
    pub shutter: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub lens: Option<String>,
    pub model: Option<String>,
    /// Numeric values for the exposure report.
    pub exposure_s: Option<f64>,
    pub iso_value: Option<u32>,
    pub f_number: Option<f64>,
    pub focal_mm: Option<f64>,
}

/// Parse EXIF from the head of a file already in memory (the first chunk read
/// while hashing). Enough for JPGs, whose EXIF block sits at the very start.
pub fn parse_meta(head: &[u8]) -> Option<MediaMeta> {
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(head))
        .ok()?;
    Some(meta_from(&exif))
}

/// Parse EXIF straight from the file, for containers (ARW/TIFF) whose IFDs may
/// point past the in-memory head. Read-only.
pub fn parse_meta_file(path: &str) -> Option<MediaMeta> {
    let file = std::fs::File::open(path).ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()?;
    Some(meta_from(&exif))
}

fn meta_from(exif: &Exif) -> MediaMeta {
    let field = |tag: Tag| exif.get_field(tag, In::PRIMARY);
    // Human-readable value of a tag, with its unit (e.g. "35 mm", "f/2.8").
    let display = |tag: Tag| -> Option<String> {
        field(tag)
            .map(|f| f.display_value().with_unit(exif).to_string().trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let first_display = |tags: &[Tag]| tags.iter().copied().find_map(display);
    let rational = |tag: Tag| -> Option<f64> {
        match &field(tag)?.value {
            Value::Rational(v) => v.first().map(|r| r.to_f64()).filter(|x| x.is_finite()),
            _ => None,
        }
    };
    let ascii = |tag: Tag| -> Option<String> {
        match &field(tag)?.value {
            Value::Ascii(v) => v
                .first()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .filter(|s| !s.is_empty()),
            _ => None,
        }
    };

    let iso_value = [Tag::PhotographicSensitivity, Tag::StandardOutputSensitivity]
        .iter()
        .find_map(|t| field(*t).and_then(|f| f.value.get_uint(0)));

    MediaMeta {
        captured_at: captured_at(exif),
        orientation: field(Tag::Orientation)
            .and_then(|f| f.value.get_uint(0))
            .map(|v| v as u16),
        aperture: first_display(&[Tag::FNumber, Tag::ApertureValue]),
        shutter: display(Tag::ExposureTime),
        iso: iso_value.map(|v| v.to_string()),
        focal_length: display(Tag::FocalLength),
        lens: ascii(Tag::LensModel),
        model: ascii(Tag::Model),
        exposure_s: rational(Tag::ExposureTime),
        iso_value,
        f_number: rational(Tag::FNumber),
        focal_mm: rational(Tag::FocalLength),
    }
}

/// `DateTimeOriginal` (fallback `DateTime`) as sortable local time, with the
/// sub-second part when the camera writes one (phones do, so bursts order).
fn captured_at(exif: &Exif) -> Option<String> {
    let (tag, sub) = if exif.get_field(Tag::DateTimeOriginal, In::PRIMARY).is_some() {
        (Tag::DateTimeOriginal, Tag::SubSecTimeOriginal)
    } else {
        (Tag::DateTime, Tag::SubSecTime)
    };
    let raw = match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(v) => v.first()?.clone(),
        _ => return None,
    };
    let dt = exif::DateTime::from_ascii(&raw).ok()?;
    if dt.year == 0 {
        return None;
    }
    let mut out = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second
    );
    if let Some(Value::Ascii(v)) = exif.get_field(sub, In::PRIMARY).map(|f| &f.value) {
        let digits: String = v
            .first()
            .map(|b| String::from_utf8_lossy(b).trim().to_string())
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            out.push('.');
            out.push_str(&digits);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads a real camera file when `FOTOCULL_SAMPLE` points at one:
    /// `FOTOCULL_SAMPLE=/path/DSC1.JPG cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_a_sample_file() {
        let path = std::env::var("FOTOCULL_SAMPLE").expect("set FOTOCULL_SAMPLE");
        let head = {
            let bytes = std::fs::read(&path).unwrap();
            bytes[..bytes.len().min(1024 * 1024)].to_vec()
        };
        let meta = parse_meta(&head).or_else(|| parse_meta_file(&path)).unwrap();
        println!("{meta:#?}");
        assert!(meta.captured_at.is_some());
    }
}
