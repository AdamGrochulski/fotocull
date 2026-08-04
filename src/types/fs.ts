/** Status katalogu zwrócony przez backend Rust (komenda `check_dir`). */
export interface DirStatus {
  exists: boolean;
  isDir: boolean;
  readable: boolean;
  writable: boolean;
}

/** Rola wybieranego folderu. */
export type FolderRole = "source" | "dest";
