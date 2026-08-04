import { invoke } from "@tauri-apps/api/core";

/** Image quality metrics from the backend (`analyze_image`). */
export interface ImageAnalysis {
  sharpness: number;
  sharpLabel: "sharp" | "soft" | "blurry" | string;
  overexposedPct: number;
  underexposedPct: number;
  exposureLabel: "ok" | "overexposed" | "underexposed" | string;
}

/** Analyze a JPG for blur and exposure (computed in Rust, off the UI thread). */
export async function analyzeImage(path: string): Promise<ImageAnalysis> {
  return invoke<ImageAnalysis>("analyze_image", { path });
}
