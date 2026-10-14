import { invoke } from "@tauri-apps/api/core";

/** Distinct target names previously used for renamed photos in this destination.
 * Feeds the rename autocomplete. */
export async function renamedTargets(destDir: string): Promise<string[]> {
  return invoke<string[]>("renamed_targets", { destDir });
}
