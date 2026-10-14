import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/**
 * Grant the asset protocol read access to a directory, so original JPGs (deep
 * zoom) and video clips under it can be loaded by the webview. Called with the
 * source folder on every scan. Read-only: copies nothing, writes nothing.
 */
export async function allowMediaDir(path: string): Promise<void> {
  await invoke("allow_media_dir", { path });
}

/**
 * Turn a file path into an asset-protocol URL usable as a <video> src.
 * Streams from disk (range requests) — never loads the whole clip into memory.
 */
export function videoSrc(path: string): string {
  return convertFileSrc(path);
}
