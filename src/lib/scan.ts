import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Photo } from "../types/photo";

/** Scan progress emitted by the backend (event `scan://progress`). */
export interface ScanProgress {
  filesScanned: number;
  imagesFound: number;
}

/** Run a recursive scan of the source folder. Returns the list of pairs (Photo). */
export async function scanSource(path: string): Promise<Photo[]> {
  return invoke<Photo[]>("scan_source", { path });
}

/** Subscribe to scan progress. Returns an unsubscribe function. */
export async function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (event) => cb(event.payload));
}
