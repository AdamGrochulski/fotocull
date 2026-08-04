/** Directory status returned by the Rust backend (command `check_dir`). */
export interface DirStatus {
  exists: boolean;
  isDir: boolean;
  readable: boolean;
  writable: boolean;
}

/** Role of the folder being picked. */
export type FolderRole = "source" | "dest";
