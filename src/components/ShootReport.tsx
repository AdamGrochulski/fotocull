import { useMemo } from "react";
import { getPreview, usePreviewsVersion } from "../lib/previews";
import { shootReport, shutterLabel } from "../lib/report";
import type { Photo } from "../types/photo";
import "./ShootReport.css";

/** Fewer photos than this say too little about how a shoot went. */
const MIN_PHOTOS = 10;

/**
 * How the camera behaved over the shoot (shutter, ISO ceiling, lens use,
 * clipping) and what to change next time. Read from EXIF and the cached
 * previews; nothing here is a verdict on single photos.
 */
export function ShootReport({ photos }: { photos: Photo[] }) {
  const version = usePreviewsVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const r = useMemo(() => shootReport(photos, getPreview), [photos, version]);
  if (r.measured < MIN_PHOTOS) return null;
  const pct = (k: number) => Math.round((k / r.measured) * 100);

  return (
    <section className="report" aria-label="Shoot report">
      <header className="report-head">
        <h3>Shoot report</h3>
        <span className="report-head__sub">from the EXIF of {r.measured} photos</span>
      </header>

      <div className="report-figures">
        <Figure
          value={`${pct(r.slow)}%`}
          label="slower than 1/60 s"
          warn={r.slow > r.measured * 0.25}
          note={r.slowest ? `slowest ${shutterLabel(r.slowest)}` : undefined}
        />
        <Figure
          value={r.isoMax ? `ISO ${r.isoMax}` : "n/a"}
          label="highest ISO"
          note={r.isoMax ? `${r.atIsoMax} photos at it` : undefined}
        />
        <Figure
          value={String(r.bursts)}
          label="bursts"
          note={`${r.framesInBursts} frames in them`}
        />
        <Figure
          value={r.analysed ? String(r.overexposed) : "…"}
          label="overexposed"
          warn={r.analysed > 0 && r.overexposed > r.analysed * 0.1}
          note={r.analysed < photos.length ? `${r.analysed}/${photos.length} checked` : "all checked"}
        />
      </div>

      {r.lenses.length > 0 && (
        <ul className="report-lenses">
          {r.lenses.map((l) => (
            <li key={l.lens}>
              <span className="report-lenses__name">{l.lens}</span>
              <span>{l.count} photos</span>
              {l.medianF && (
                <span>
                  mostly f/{l.medianF.toFixed(1)}
                  {l.maxAperture ? ` (opens to f/${l.maxAperture})` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {r.tips.length > 0 ? (
        <ul className="report-tips">
          {r.tips.map((t) => (
            <li key={t.title}>
              <strong>{t.title}.</strong> {t.detail}
            </li>
          ))}
        </ul>
      ) : (
        <p className="report-ok">Exposure looks under control for this shoot.</p>
      )}
    </section>
  );
}

function Figure({
  value,
  label,
  note,
  warn,
}: {
  value: string;
  label: string;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div className={`report-figure ${warn ? "is-warn" : ""}`}>
      <div className="report-figure__value">{value}</div>
      <div className="report-figure__label">{label}</div>
      {note && <div className="report-figure__note">{note}</div>}
    </div>
  );
}
