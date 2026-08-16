import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Photo } from "../types/photo";
import type { Video } from "../types/video";

/** Scan progress emitted by the backend (event `scan://progress`). */
export interface ScanProgress {
  filesScanned: number;
  imagesFound: number;
}

/** A single source walk: photo pairs and video clips. */
export interface ScanResult {
  photos: Photo[];
  videos: Video[];
}

/** Run a recursive scan of the source folder. Returns photo pairs and clips. */
export async function scanSource(path: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_source", { path });
}

/** Subscribe to scan progress. Returns an unsubscribe function. */
export async function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (event) => cb(event.payload));
}
