use serde::Serialize;

/// Image quality metrics computed on the JPG.
///
/// Only exposure is reported. A global blur score (Laplacian variance) was tried
/// and dropped: it depends on scene content, not focus — a textured wall reads
/// "sharp", smooth sky reads "blurry" even when perfectly in focus. Sharpness is
/// judged by eye via the focus-peaking overlay instead. Exposure clipping, by
/// contrast, is a real signal from the pixels regardless of subject.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysis {
    /// Fraction of pixels near white (>= 250), as a percentage.
    pub overexposed_pct: f64,
    /// Fraction of pixels near black (<= 5), as a percentage.
    pub underexposed_pct: f64,
    /// "ok" | "overexposed" | "underexposed".
    pub exposure_label: String,
}

/// Analyze a JPG's exposure from its luminance histogram.
/// Runs off the UI thread. Read-only.
#[tauri::command]
pub async fn analyze_image(path: String) -> Result<ImageAnalysis, String> {
    tauri::async_runtime::spawn_blocking(move || analyze_blocking(&path))
        .await
        .map_err(|e| format!("Analysis task aborted: {e}"))?
}

fn analyze_blocking(path: &str) -> Result<ImageAnalysis, String> {
    let img = image::open(path).map_err(|e| format!("Cannot decode image: {e}"))?;
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    if w < 1 || h < 1 {
        return Err("Image too small to analyze".to_string());
    }

    // Luminance histogram for exposure clipping.
    let total = (w * h) as f64;
    let mut over = 0u64;
    let mut under = 0u64;
    for p in gray.pixels() {
        let v = p[0];
        if v >= 250 {
            over += 1;
        } else if v <= 5 {
            under += 1;
        }
    }
    let overexposed_pct = over as f64 / total * 100.0;
    let underexposed_pct = under as f64 / total * 100.0;

    let exposure_label = if overexposed_pct > 5.0 {
        "overexposed"
    } else if underexposed_pct > 5.0 {
        "underexposed"
    } else {
        "ok"
    }
    .to_string();

    Ok(ImageAnalysis {
        overexposed_pct,
        underexposed_pct,
        exposure_label,
    })
}
