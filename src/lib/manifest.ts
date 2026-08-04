import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Wynik hashowania jednego JPG i dopasowania do manifestu. */
export interface HashResult {
  path: string;
  hash: string;
  alreadyCopied: boolean;
}

/** Postęp hashowania (event `hash://progress`). */
export interface HashProgress {
  hashed: number;
  total: number;
}

/** SHA-256 pojedynczego pliku JPG. */
export async function hashJpg(path: string): Promise<string> {
  return invoke<string>("hash_jpg", { path });
}

/**
 * Zhashuj podane JPG-i i oznacz, które są już w manifeście folderu docelowego.
 */
export async function filterByManifest(
  destDir: string,
  jpgPaths: string[],
): Promise<HashResult[]> {
  return invoke<HashResult[]>("filter_by_manifest", { destDir, jpgPaths });
}

/** Subskrybuj postęp hashowania. Zwraca funkcję do odsubskrybowania. */
export async function onHashProgress(
  cb: (p: HashProgress) => void,
): Promise<UnlistenFn> {
  return listen<HashProgress>("hash://progress", (e) => cb(e.payload));
}
