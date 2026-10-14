use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use fast_image_resize as fr;
use image::{metadata::Orientation, DynamicImage, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::exif::parse_meta;

/// Longest side of the review preview. Sharp on a 1440p screen at Fit, and a
/// decoded copy is ~17 MB instead of ~96 MB for a 24 MP original, so a dozen
/// neighbours can sit decoded in memory for instant flipping.
const PREVIEW_SIDE: u32 = 2560;
/// Longest side of filmstrip / grid thumbnails (crisp at 2x on ~180 px cells).
const THUMB_SIDE: u32 = 360;
const PREVIEW_QUALITY: u8 = 82;
const THUMB_QUALITY: u8 = 78;
/// Background warming uses its own small pool so on-demand requests for the
/// photo on screen never queue behind it.
const WARM_THREADS: usize = 2;
/// Keep the preview cache under this size; oldest files go first.
const CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Pixels at or above / below these luma values count as clipped.
const CLIP_HIGH: u8 = 250;
const CLIP_LOW: u8 = 5;

/// Everything the review needs about one photo's pictures: where its cached
/// thumbnail and preview live, the original's upright size, and clipping stats.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    pub hash: String,
    pub thumb: String,
    pub preview: String,
    /// Original size after applying EXIF orientation.
    pub width: u32,
    pub height: u32,
    /// Share of pixels clipped to white / black, in percent.
    pub over_pct: f64,
    pub under_pct: f64,
}

#[derive(Deserialize, Clone)]
pub struct PreviewRequest {
    pub hash: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub hash: String,
    pub info: Option<PreviewInfo>,
    pub error: Option<String>,
}

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Bumped by every `warm_previews` call; older warm runs stop when they see it.
static WARM_GEN: AtomicU64 = AtomicU64::new(0);

/// Resolve the cache dir, allow the asset protocol to serve it, and trim it in
/// the background. Called once at startup.
pub fn init(app: &AppHandle) {
    let Ok(base) = app.path().app_cache_dir() else { return };
    let dir = base.join("previews");
    let _ = std::fs::create_dir_all(&dir);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
        eprintln!("fotocull: cannot expose preview cache: {e}");
    }
    let _ = CACHE_DIR.set(dir.clone());
    std::thread::spawn(move || prune(&dir, CACHE_MAX_BYTES));
}

fn cache_dir() -> Result<&'static Path, String> {
    CACHE_DIR
        .get()
        .map(PathBuf::as_path)
        .ok_or_else(|| "preview cache unavailable".to_string())
}

/// Files of one photo, sharded by the first two hex digits of its hash.
fn paths_for(dir: &Path, hash: &str) -> (PathBuf, PathBuf, PathBuf) {
    let shard = dir.join(hash.get(..2).unwrap_or("00"));
    (
        shard.join(format!("{hash}.p.jpg")),
        shard.join(format!("{hash}.t.jpg")),
        shard.join(format!("{hash}.json")),
    )
}

/// Return the cached previews of a photo, generating them first if needed.
/// Reads the source JPG only; writes only into the app's cache dir.
pub fn ensure(dir: &Path, hash: &str, source: &str) -> Result<PreviewInfo, String> {
    let (preview_path, thumb_path, info_path) = paths_for(dir, hash);
    if let Ok(text) = std::fs::read_to_string(&info_path) {
        if let Ok(info) = serde_json::from_str::<PreviewInfo>(&text) {
            if preview_path.exists() && thumb_path.exists() {
                return Ok(info);
            }
        }
    }

    let bytes = std::fs::read(source).map_err(|e| format!("cannot read {source}: {e}"))?;
    let (image, (width, height)) = decode_for_preview(&bytes)?;
    let orientation = parse_meta(&bytes[..bytes.len().min(1024 * 1024)])
        .and_then(|m| m.orientation)
        .and_then(|o| Orientation::from_exif(o as u8))
        .unwrap_or(Orientation::NoTransforms);

    let mut preview = DynamicImage::ImageRgb8(fit(&image, PREVIEW_SIDE)?);
    preview.apply_orientation(orientation);
    let preview = preview.into_rgb8();
    let thumb = fit(&preview, THUMB_SIDE)?;
    let (over_pct, under_pct) = clipping(&preview);

    let rotated = matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    );
    let info = PreviewInfo {
        hash: hash.to_string(),
        thumb: thumb_path.to_string_lossy().to_string(),
        preview: preview_path.to_string_lossy().to_string(),
        width: if rotated { height } else { width },
        height: if rotated { width } else { height },
        over_pct,
        under_pct,
    };

    if let Some(shard) = preview_path.parent() {
        std::fs::create_dir_all(shard).map_err(|e| format!("cannot create cache: {e}"))?;
    }
    write_atomic(&preview_path, &encode(&preview, PREVIEW_QUALITY)?)?;
    write_atomic(&thumb_path, &encode(&thumb, THUMB_QUALITY)?)?;
    let json = serde_json::to_vec(&info).map_err(|e| e.to_string())?;
    write_atomic(&info_path, &json)?;
    Ok(info)
}

/// Decode a JPEG at the smallest DCT scale that still covers the preview size
/// (a 24 MP frame decodes at 1/2, about twice as fast as full size). Falls
/// back to the general decoder for anything jpeg-decoder rejects. Returns the
/// pixels and the original (stored, pre-orientation) size.
fn decode_for_preview(bytes: &[u8]) -> Result<(RgbImage, (u32, u32)), String> {
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    let scaled = decoder.read_info().ok().and_then(|_| {
        let info = decoder.info()?;
        let (w, h) = (info.width as u32, info.height as u32);
        let long = w.max(h).max(1);
        let want = |side: u32| ((side as u64 * PREVIEW_SIDE as u64).div_ceil(long as u64)) as u16;
        let (sw, sh) = decoder.scale(want(w), want(h)).ok()?;
        let pixels = decoder.decode().ok()?;
        let rgb = to_rgb(pixels, decoder.info()?.pixel_format, sw as u32, sh as u32)?;
        Some((rgb, (w, h)))
    });
    if let Some(done) = scaled {
        return Ok(done);
    }
    let img = image::load_from_memory(bytes).map_err(|e| format!("cannot decode: {e}"))?;
    let size = (img.width(), img.height());
    Ok((img.into_rgb8(), size))
}

fn to_rgb(
    pixels: Vec<u8>,
    format: jpeg_decoder::PixelFormat,
    w: u32,
    h: u32,
) -> Option<RgbImage> {
    use jpeg_decoder::PixelFormat::*;
    let rgb = match format {
        RGB24 => pixels,
        L8 => pixels.iter().flat_map(|&l| [l, l, l]).collect(),
        L16 => pixels.chunks_exact(2).flat_map(|c| [c[0], c[0], c[0]]).collect(),
        CMYK32 => pixels
            .chunks_exact(4)
            .flat_map(|c| {
                let k = 255 - c[3] as u16;
                let ch = |v: u8| ((255 - v as u16) * k / 255) as u8;
                [ch(c[0]), ch(c[1]), ch(c[2])]
            })
            .collect(),
    };
    RgbImage::from_raw(w, h, rgb)
}

/// Downscale to fit within `side` x `side` (never upscales).
fn fit(img: &RgbImage, side: u32) -> Result<RgbImage, String> {
    let (w, h) = img.dimensions();
    let long = w.max(h);
    if long <= side {
        return Ok(img.clone());
    }
    let nw = ((w as u64 * side as u64) / long as u64).max(1) as u32;
    let nh = ((h as u64 * side as u64) / long as u64).max(1) as u32;
    let mut dst = fr::images::Image::new(nw, nh, fr::PixelType::U8x3);
    fr::Resizer::new()
        .resize(
            img,
            &mut dst,
            &fr::ResizeOptions::new()
                .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Bilinear)),
        )
        .map_err(|e| format!("cannot resize: {e}"))?;
    RgbImage::from_raw(nw, nh, dst.into_vec()).ok_or_else(|| "resize failed".to_string())
}

fn encode(img: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(
            img.as_raw(),
            img.width() as u16,
            img.height() as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .map_err(|e| format!("cannot encode preview: {e}"))?;
    Ok(out)
}

/// Clipped highlight / shadow share from luma, the same signal the exposure
/// readout always used, now computed once on the preview.
fn clipping(img: &RgbImage) -> (f64, f64) {
    let total = (img.width() as u64 * img.height() as u64).max(1) as f64;
    let (mut over, mut under) = (0u64, 0u64);
    for p in img.pixels() {
        let y = ((77 * p[0] as u32 + 150 * p[1] as u32 + 29 * p[2] as u32) >> 8) as u8;
        if y >= CLIP_HIGH {
            over += 1;
        } else if y <= CLIP_LOW {
            under += 1;
        }
    }
    (over as f64 / total * 100.0, under as f64 / total * 100.0)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write cache: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot write cache: {e}"))
}

/// Delete the oldest cache files until the cache fits in `max_bytes`. Only
/// touches files this module created.
fn prune(dir: &Path, max_bytes: u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            Some((md.modified().ok()?, md.len(), e.into_path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

fn run(dir: &Path, req: &PreviewRequest) -> PreviewResult {
    match ensure(dir, &req.hash, &req.path) {
        Ok(info) => PreviewResult { hash: req.hash.clone(), info: Some(info), error: None },
        Err(e) => PreviewResult { hash: req.hash.clone(), info: None, error: Some(e) },
    }
}

/// Previews for the photos needed right now (the one on screen and its
/// neighbours). Generated in parallel on demand; cached ones return at once.
#[tauri::command]
pub async fn get_previews(items: Vec<PreviewRequest>) -> Result<Vec<PreviewResult>, String> {
    let dir = cache_dir()?;
    tauri::async_runtime::spawn_blocking(move || items.par_iter().map(|r| run(dir, r)).collect())
        .await
        .map_err(|e| format!("Preview task aborted: {e}"))
}

/// Generate previews for a whole scan in the background, in the given order,
/// emitting `preview://ready` per photo. A newer call cancels an older run.
#[tauri::command]
pub fn warm_previews(app: AppHandle, items: Vec<PreviewRequest>) -> Result<(), String> {
    let dir = cache_dir()?;
    let generation = WARM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(WARM_THREADS).build() else {
            return;
        };
        pool.install(|| {
            items.par_iter().for_each(|req| {
                if WARM_GEN.load(Ordering::SeqCst) != generation {
                    return;
                }
                let _ = app.emit("preview://ready", run(dir, req));
            });
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        let img = RgbImage::new(6000, 4000);
        assert_eq!(fit(&img, 2560).unwrap().dimensions(), (2560, 1706));
        let small = RgbImage::new(300, 200);
        assert_eq!(fit(&small, 2560).unwrap().dimensions(), (300, 200));
    }

    #[test]
    fn clipping_counts_extremes() {
        let mut img = RgbImage::new(10, 1);
        for x in 0..3 {
            img.put_pixel(x, 0, image::Rgb([255, 255, 255]));
        }
        img.put_pixel(9, 0, image::Rgb([0, 0, 0]));
        for x in 3..9 {
            img.put_pixel(x, 0, image::Rgb([128, 128, 128]));
        }
        let (over, under) = clipping(&img);
        assert!((over - 30.0).abs() < 1e-9 && (under - 10.0).abs() < 1e-9);
    }

    /// `FOTOCULL_SAMPLE=/path/DSC1.JPG cargo test preview -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn builds_previews_for_a_sample() {
        let path = std::env::var("FOTOCULL_SAMPLE").expect("set FOTOCULL_SAMPLE");
        let dir = std::env::temp_dir().join(format!("fotocull-prev-{}", std::process::id()));
        let t = std::time::Instant::now();
        let info = ensure(&dir, "abcdef", &path).unwrap();
        println!("{:?} in {:?}", info, t.elapsed());
        let p = image::open(&info.preview).unwrap();
        println!("preview {}x{}", p.width(), p.height());
        assert_eq!(p.width() >= p.height(), info.width >= info.height);
        let t = std::time::Instant::now();
        ensure(&dir, "abcdef", &path).unwrap();
        println!("cached in {:?}", t.elapsed());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
