import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Photo } from "../types/photo";

/** Postęp skanu emitowany przez backend (event `scan://progress`). */
export interface ScanProgress {
  filesScanned: number;
  imagesFound: number;
}

/** Uruchom rekursywny skan katalogu źródłowego. Zwraca listę par (Photo). */
export async function scanSource(path: string): Promise<Photo[]> {
  return invoke<Photo[]>("scan_source", { path });
}

/** Subskrybuj postęp skanu. Zwraca funkcję do odsubskrybowania. */
export async function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (event) => cb(event.payload));
}
