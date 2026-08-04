import { invoke } from "@tauri-apps/api/core";

/** Shooting parameters from a JPG's EXIF (`read_exif`). Any field may be absent. */
export interface ExifInfo {
  aperture?: string | null;
  shutter?: string | null;
  iso?: string | null;
  focalLength?: string | null;
  lens?: string | null;
}

/** Read shooting EXIF for a JPG (parsed in Rust, off the UI thread). */
export async function readExif(path: string): Promise<ExifInfo> {
  return invoke<ExifInfo>("read_exif", { path });
}
