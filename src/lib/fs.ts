import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { DirStatus } from "../types/fs";

/**
 * Open the native directory picker dialog.
 * Returns the path, or null if the user cancelled.
 */
export async function pickDirectory(title: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title });
  // open() returns string | string[] | null; with multiple:false it's string | null.
  return typeof selected === "string" ? selected : null;
}

/** Validate a directory via the backend (exists / is dir / readable / writable). */
export async function checkDir(path: string): Promise<DirStatus> {
  return invoke<DirStatus>("check_dir", { path });
}
