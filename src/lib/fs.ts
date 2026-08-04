import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { DirStatus } from "../types/fs";

/**
 * Otwórz systemowy dialog wyboru katalogu.
 * Zwraca ścieżkę lub null gdy użytkownik anulował.
 */
export async function pickDirectory(title: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title });
  // open() zwraca string | string[] | null; przy multiple:false to string | null.
  return typeof selected === "string" ? selected : null;
}

/** Zwaliduj katalog przez backend (istnieje / katalog / czytelny / zapisywalny). */
export async function checkDir(path: string): Promise<DirStatus> {
  return invoke<DirStatus>("check_dir", { path });
}
