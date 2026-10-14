import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Look for a newer published release on GitHub (the updater reads
 * `latest.json` from the latest release). Offline, a draft-only release or a
 * dev build simply yields `null`; this must never get in the way of culling.
 */
export async function findUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (err) {
    console.warn("Update check skipped:", err);
    return null;
  }
}

/** Download and install `update`, reporting progress 0..1, then restart. */
export async function installUpdate(
  update: Update,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress(total ? 0 : null);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress(total ? Math.min(1, received / total) : null);
    }
  });
  // Windows installs by running the installer, which closes the app itself.
  await relaunch();
}
