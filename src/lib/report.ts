import type { Photo } from "../types/photo";
import { burstGroups } from "./bursts";
import { exposureLabel, type PreviewInfo } from "./previews";

/** Shutter speeds slower than these risk blur from moving people / shake. */
export const SLOW_SHUTTER_S = 1 / 60;
export const VERY_SLOW_SHUTTER_S = 1 / 30;

export interface LensUse {
  lens: string;
  count: number;
  /** Widest aperture the lens can do, from its name ("F1.8"), if stated. */
  maxAperture?: number;
  /** Median f-number actually used. */
  medianF?: number;
}

export interface Tip {
  /** Short headline, then the reason with numbers. */
  title: string;
  detail: string;
}

export interface ShootReport {
  /** Photos with usable EXIF. */
  measured: number;
  slow: number;
  verySlow: number;
  slowest?: number;
  isoMax?: number;
  /** Frames shot at `isoMax`. */
  atIsoMax: number;
  lenses: LensUse[];
  bursts: number;
  framesInBursts: number;
  /** Photos whose preview has been analysed for clipping. */
  analysed: number;
  overexposed: number;
  underexposed: number;
  tips: Tip[];
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** "1/30 s" style label for a shutter time in seconds. */
export function shutterLabel(s: number): string {
  return s >= 1 ? `${s.toFixed(s >= 10 ? 0 : 1)} s` : `1/${Math.round(1 / s)} s`;
}

/**
 * What the camera did during a shoot, from EXIF alone, plus a few concrete
 * tips for the next one. Meant for the photographer, not as a judgement of
 * single frames: slow shutter at the ISO ceiling is the usual cause of soft
 * indoor event photos, and it is fixable in the camera menu.
 */
export function shootReport(
  photos: Photo[],
  preview: (hash?: string) => PreviewInfo | undefined,
): ShootReport {
  const withExif = photos.filter((p) => p.meta?.exposureS || p.meta?.isoValue);
  const times = withExif.map((p) => p.meta?.exposureS).filter((x): x is number => !!x);
  const slow = times.filter((t) => t > SLOW_SHUTTER_S * 1.001).length;
  const verySlow = times.filter((t) => t > VERY_SLOW_SHUTTER_S * 1.001).length;
  const isos = withExif.map((p) => p.meta?.isoValue).filter((x): x is number => !!x);
  const isoMax = isos.length ? Math.max(...isos) : undefined;
  const atIsoMaxPhotos = withExif.filter((p) => isoMax && p.meta?.isoValue === isoMax);

  const byLens = new Map<string, Photo[]>();
  for (const p of withExif) {
    const lens = p.meta?.lens || p.meta?.model || "Unknown lens";
    byLens.set(lens, [...(byLens.get(lens) ?? []), p]);
  }
  const lenses: LensUse[] = [...byLens.entries()]
    .map(([lens, ps]) => {
      const m = /F\s?(\d+(?:\.\d+)?)/i.exec(lens);
      return {
        lens,
        count: ps.length,
        maxAperture: m ? Number(m[1]) : undefined,
        medianF: median(ps.map((p) => p.meta?.fNumber).filter((x): x is number => !!x)),
      };
    })
    .sort((a, b) => b.count - a.count);

  const groups = burstGroups(photos).filter((g) => g.length > 1);
  let analysed = 0;
  let overexposed = 0;
  let underexposed = 0;
  for (const p of photos) {
    const info = preview(p.hash);
    if (!info) continue;
    analysed++;
    const label = exposureLabel(info);
    if (label === "overexposed") overexposed++;
    if (label === "underexposed") underexposed++;
  }

  const tips: Tip[] = [];
  const n = times.length;
  const pct = (k: number, of = n) => (of ? Math.round((k / of) * 100) : 0);

  // ISO ceiling: many frames at the top ISO, and those frames mostly slow.
  const slowAtMax = atIsoMaxPhotos.filter(
    (p) => (p.meta?.exposureS ?? 0) > SLOW_SHUTTER_S * 1.001,
  ).length;
  if (isoMax && atIsoMaxPhotos.length >= Math.max(5, n * 0.2) && slowAtMax >= atIsoMaxPhotos.length * 0.4) {
    tips.push({
      title: `Raise the Auto ISO limit above ${isoMax}`,
      detail:
        `${atIsoMaxPhotos.length} photos (${pct(atIsoMaxPhotos.length)}%) sit exactly at ISO ${isoMax}, ` +
        `and ${slowAtMax} of them are slower than 1/60 s: the camera ran out of ISO and lengthened ` +
        `the shutter instead. A limit of 3200-6400 keeps faces sharp; the extra noise is fine online.`,
    });
  }
  if (verySlow >= Math.max(3, n * 0.05)) {
    const slowest = Math.max(...times);
    tips.push({
      title: "Watch for motion blur",
      detail:
        `${verySlow} photos (${pct(verySlow)}%) were shot slower than 1/30 s, down to ${shutterLabel(slowest)}. ` +
        `Stabilisation steadies the camera, not the people. For moving subjects use 1/125 s ` +
        `(shutter priority, S) and let ISO rise.`,
    });
  }
  for (const l of lenses) {
    if (!l.maxAperture || !l.medianF || l.count < 10) continue;
    const stops = 2 * Math.log2(l.medianF / l.maxAperture);
    const lensSlow = (byLens.get(l.lens) ?? []).filter(
      (p) => (p.meta?.exposureS ?? 0) > SLOW_SHUTTER_S * 1.001,
    ).length;
    if (stops >= 1.5 && lensSlow >= l.count * 0.25) {
      tips.push({
        title: `Open up the ${l.lens}`,
        detail:
          `It can do f/${l.maxAperture} but was used around f/${l.medianF.toFixed(1)} ` +
          `(${stops.toFixed(1)} stops less light) while ${lensSlow} of its ${l.count} photos ` +
          `were slower than 1/60 s. Indoors, f/${l.maxAperture}-2.8 buys a faster shutter.`,
      });
    }
  }
  if (analysed >= 10 && overexposed >= Math.max(3, analysed * 0.1)) {
    tips.push({
      title: "Highlights are clipping",
      detail:
        `${overexposed} of ${analysed} photos have over 5% blown-out pixels. Try -0.7 EV ` +
        `exposure compensation against bright screens and windows, or turn on zebras.`,
    });
  }

  return {
    measured: withExif.length,
    slow,
    verySlow,
    slowest: times.length ? Math.max(...times) : undefined,
    isoMax,
    atIsoMax: atIsoMaxPhotos.length,
    lenses,
    bursts: groups.length,
    framesInBursts: groups.reduce((a, g) => a + g.length, 0),
    analysed,
    overexposed,
    underexposed,
    tips,
  };
}
