use serde::Serialize;

/// Image quality metrics computed on the JPG.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysis {
    /// Variance of the Laplacian — higher = sharper.
    pub sharpness: f64,
    /// Coarse label: "sharp" | "soft" | "blurry".
    pub sharp_label: String,
    /// Fraction of pixels near white (>= 250), as a percentage.
    pub overexposed_pct: f64,
    /// Fraction of pixels near black (<= 5), as a percentage.
    pub underexposed_pct: f64,
    /// "ok" | "overexposed" | "underexposed" | "low contrast".
    pub exposure_label: String,
}

/// Analyze a JPG: blur (Laplacian variance) and exposure (luminance histogram).
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
    if w < 3 || h < 3 {
        return Err("Image too small to analyze".to_string());
    }

    let px = |x: u32, y: u32| gray.get_pixel(x, y)[0] as f64;

    // Laplacian (4-neighbour) over interior pixels; track running mean/variance.
    let mut count: f64 = 0.0;
    let mut mean: f64 = 0.0;
    let mut m2: f64 = 0.0;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let lap = 4.0 * px(x, y) - px(x - 1, y) - px(x + 1, y) - px(x, y - 1)
                - px(x, y + 1);
            count += 1.0;
            let delta = lap - mean;
            mean += delta / count;
            m2 += delta * (lap - mean);
        }
    }
    let sharpness = if count > 0.0 { m2 / count } else { 0.0 };

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

    let sharp_label = if sharpness >= 150.0 {
        "sharp"
    } else if sharpness >= 50.0 {
        "soft"
    } else {
        "blurry"
    }
    .to_string();

    let exposure_label = if overexposed_pct > 5.0 {
        "overexposed"
    } else if underexposed_pct > 5.0 {
        "underexposed"
    } else {
        "ok"
    }
    .to_string();

    Ok(ImageAnalysis {
        sharpness,
        sharp_label,
        overexposed_pct,
        underexposed_pct,
        exposure_label,
    })
}
