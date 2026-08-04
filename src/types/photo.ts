/**
 * Data model: a "photo" = a JPG + (optional) ARW pair sharing a base name.
 * Populated in Stage 2 (media scan).
 */
export interface Photo {
  /** Base name without extension, e.g. "DSC01234". */
  baseName: string;
  /** Path to the JPG file (if present). */
  jpgPath?: string;
  /** Path to the ARW file (if present). */
  arwPath?: string;
  /** Source directory the pair lives in. */
  sourceDir: string;
  /** SHA-256 of the JPG file — computed in Stage 3, used for dedup and manifest. */
  jpgHash?: string;
}
