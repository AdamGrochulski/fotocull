import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MediaMeta } from "../types/photo";

/** One indexed file (`index_media`). Unreadable files carry `error`. */
export interface IndexResult {
  path: string;
  hash?: string | null;
  alreadyCopied: boolean;
  meta?: MediaMeta | null;
  error?: string | null;
}

export type IndexKind = "photo" | "video";

/** Indexing progress (event `index://progress`). */
export interface IndexProgress {
  done: number;
  total: number;
  kind: IndexKind;
}

/**
 * Hash files, read their EXIF and check them against the destination's
 * manifest. Files seen in an earlier scan come from the backend's cache, so a
 * rescan reads only what's new on the card.
 */
export async function indexMedia(
  destDir: string,
  paths: string[],
  kind: IndexKind,
): Promise<IndexResult[]> {
  return invoke<IndexResult[]>("index_media", { destDir, paths, kind });
}

/** Subscribe to indexing progress. Returns an unsubscribe function. */
export async function onIndexProgress(
  cb: (p: IndexProgress) => void,
): Promise<UnlistenFn> {
  return listen<IndexProgress>("index://progress", (e) => cb(e.payload));
}
