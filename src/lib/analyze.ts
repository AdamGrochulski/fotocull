import { invoke } from "@tauri-apps/api/core";

/**
 * Image quality metrics from the backend (`analyze_image`).
 *
 * Exposure only. Blur is judged by eye with the focus-peaking overlay — a global
 * sharpness score reflects scene content, not focus, so it was misleading.
 */
export interface ImageAnalysis {
  overexposedPct: number;
  underexposedPct: number;
  exposureLabel: "ok" | "overexposed" | "underexposed" | string;
}

/** Analyze a JPG's exposure (computed in Rust, off the UI thread). */
export async function analyzeImage(path: string): Promise<ImageAnalysis> {
  return invoke<ImageAnalysis>("analyze_image", { path });
}
