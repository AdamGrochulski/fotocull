import type { Photo } from "../types/photo";

/** Frames shot this close together count as one burst. */
export const BURST_GAP_MS = 2000;

/** Milliseconds since epoch of an EXIF `YYYY-MM-DDTHH:MM:SS[.fff]` local time. */
export function captureMs(p: Photo): number | undefined {
  const t = p.meta?.capturedAt;
  if (!t) return undefined;
  // Sub-second digits are a fraction ("12" = .12 s), not milliseconds.
  const [whole, frac = ""] = t.split(".");
  const ms = Date.parse(whole);
  if (Number.isNaN(ms)) return undefined;
  return ms + (frac ? Number(`0.${frac}`) * 1000 : 0);
}

/**
 * Split photos (already in shooting order) into bursts: runs of consecutive
 * frames each at most `BURST_GAP_MS` after the previous one. Every photo lands
 * in exactly one group; most groups are single frames. Returns photo indices.
 */
export function burstGroups(photos: Photo[], gapMs = BURST_GAP_MS): number[][] {
  const groups: number[][] = [];
  let prev: number | undefined;
  photos.forEach((p, i) => {
    const t = captureMs(p);
    const joins =
      groups.length > 0 && t !== undefined && prev !== undefined && t - prev >= 0 && t - prev <= gapMs;
    if (joins) groups[groups.length - 1].push(i);
    else groups.push([i]);
    prev = t;
  });
  return groups;
}
