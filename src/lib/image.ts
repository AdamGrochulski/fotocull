import { invoke } from "@tauri-apps/api/core";

/**
 * Load an image file through the backend and return an object URL for <img>.
 * The backend returns raw bytes (efficient IPC), which we wrap in a Blob.
 * Remember to revoke the URL (URL.revokeObjectURL) when it's no longer shown.
 */
export async function loadImageUrl(path: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_image", { path });
  const blob = new Blob([bytes], { type: "image/jpeg" });
  return URL.createObjectURL(blob);
}
