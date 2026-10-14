import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { DirStatus, FolderRole } from "../types/fs";

/**
 * Open the native directory picker dialog.
 * Returns the path, or null if the user cancelled.
 */
export async function pickDirectory(title: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title });
  // open() returns string | string[] | null; with multiple:false it's string | null.
  return typeof selected === "string" ? selected : null;
}

/**
 * Validate a directory via the backend (exists / is dir / readable / writable).
 * Writability is only probed for the destination: the probe creates a file, and
 * the source card must never be written to.
 */
export async function checkDir(path: string, role: FolderRole): Promise<DirStatus> {
  return invoke<DirStatus>("check_dir", { path, probeWrite: role === "dest" });
}

/** Open a folder in the OS file manager. */
export async function openFolder(path: string): Promise<void> {
  return invoke("open_folder", { path });
}
