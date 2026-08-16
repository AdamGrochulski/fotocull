/**
 * Data model: a standalone video clip (`.mp4`). Unlike photos, clips have no
 * ARW companion and no pairing — each file is its own item.
 * Populated in Stage 2 (media scan).
 */
export interface Video {
  /** Base name without extension, e.g. "MAH00001". */
  baseName: string;
  /** Full path to the MP4 file. */
  path: string;
  /** Source directory the clip lives in. */
  sourceDir: string;
  /** SHA-256 of the MP4 — computed in Stage 3, used for dedup and manifest. */
  hash?: string;
}
