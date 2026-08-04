import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Result of hashing one JPG and matching it against the manifest. */
export interface HashResult {
  path: string;
  hash: string;
  alreadyCopied: boolean;
}

/** Hashing progress (event `hash://progress`). */
export interface HashProgress {
  hashed: number;
  total: number;
}

/** SHA-256 of a single JPG file. */
export async function hashJpg(path: string): Promise<string> {
  return invoke<string>("hash_jpg", { path });
}

/** Distinct target names previously used for renamed photos in this destination.
 * Feeds the rename autocomplete. */
export async function renamedTargets(destDir: string): Promise<string[]> {
  return invoke<string[]>("renamed_targets", { destDir });
}

/**
 * Hash the given JPGs and mark which are already in the destination folder's manifest.
 */
export async function filterByManifest(
  destDir: string,
  jpgPaths: string[],
): Promise<HashResult[]> {
  return invoke<HashResult[]>("filter_by_manifest", { destDir, jpgPaths });
}

/** Subscribe to hashing progress. Returns an unsubscribe function. */
export async function onHashProgress(
  cb: (p: HashProgress) => void,
): Promise<UnlistenFn> {
  return listen<HashProgress>("hash://progress", (e) => cb(e.payload));
}
