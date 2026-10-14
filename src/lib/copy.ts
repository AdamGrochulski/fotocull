import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One accepted photo to copy (sent to the backend). */
export interface CopyJob {
  baseName: string;
  jpgPath?: string;
  arwPath?: string;
  /** Identity hash (JPG, else ARW) from the scan. */
  hash?: string;
  includeArw: boolean;
  newName?: string;
}

/** Result of the copy batch. */
export interface CopyReport {
  copied: number;
  filesCopied: number;
  errors: string[];
}

/** Copy progress (event `copy://progress`). */
export interface CopyProgress {
  done: number;
  total: number;
}

/** One accepted video clip to copy (sent to the backend). */
export interface VideoJob {
  baseName: string;
  path: string;
  hash?: string;
  newName?: string;
}

/** Copy accepted photos into the destination folder. */
export async function copyAccepted(
  destDir: string,
  jobs: CopyJob[],
): Promise<CopyReport> {
  return invoke<CopyReport>("copy_accepted", { destDir, jobs });
}

/** Copy accepted video clips into the destination folder (video/ or unique/video/). */
export async function copyVideos(
  destDir: string,
  jobs: VideoJob[],
): Promise<CopyReport> {
  return invoke<CopyReport>("copy_videos", { destDir, jobs });
}

/** Subscribe to copy progress. Returns an unsubscribe function. */
export async function onCopyProgress(
  cb: (p: CopyProgress) => void,
): Promise<UnlistenFn> {
  return listen<CopyProgress>("copy://progress", (e) => cb(e.payload));
}
