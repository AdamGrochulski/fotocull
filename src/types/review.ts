/** Whether the photo is kept or skipped. */
export type DecisionKind = "accept" | "reject";

/** A user's decision about a single photo (Stage 4 — in memory only). */
export interface Decision {
  kind: DecisionKind;
  /** Copy the companion ARW too (only meaningful when the photo has one). */
  includeArw: boolean;
  /** New base name, or "" to keep the original. */
  newName: string;
}
