/** What the app reads from a photo's EXIF (once, while hashing). */
export interface MediaMeta {
  /** Local capture time, `YYYY-MM-DDTHH:MM:SS[.fff]`, sortable as text. */
  capturedAt?: string | null;
  /** EXIF orientation (1 upright, 6/8 rotated portrait). */
  orientation?: number | null;
  /** Display strings for the EXIF strip. */
  aperture?: string | null;
  shutter?: string | null;
  iso?: string | null;
  focalLength?: string | null;
  lens?: string | null;
  model?: string | null;
  /** Numeric values for the exposure report. */
  exposureS?: number | null;
  isoValue?: number | null;
  fNumber?: number | null;
  focalMm?: number | null;
}

/**
 * Data model: a "photo" = a JPG + (optional) ARW pair sharing a base name in
 * one folder. Either half may be missing.
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
  /**
   * Identity: SHA-256 of the JPG, or of the ARW for an ARW-only photo. Used for
   * the manifest, the reject skip-list and resuming a session.
   */
  hash?: string;
  /** EXIF of the identity file. */
  meta?: MediaMeta | null;
}

/** The file that identifies a photo: its JPG, else its ARW. */
export function identityPath(p: Photo): string | undefined {
  return p.jpgPath ?? p.arwPath;
}
