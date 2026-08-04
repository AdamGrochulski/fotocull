import { useEffect, useRef, useState } from "react";
import { useAppState } from "../state/appStore";
import { loadImageUrl } from "../lib/image";
import { analyzeImage, type ImageAnalysis } from "../lib/analyze";
import { PhotoViewer } from "./PhotoViewer";
import type { Photo } from "../types/photo";
import "./ReviewScreen.css";

export function ReviewScreen() {
  const { photos, reviewIndex } = useAppState();

  // Past the last photo → review is complete.
  if (reviewIndex >= photos.length) {
    return <ReviewComplete />;
  }

  return <ReviewCard photo={photos[reviewIndex]} />;
}

function ReviewCard({ photo }: { photo: Photo }) {
  const { photos, reviewIndex, decisions, decideCurrent, reviewPrev, backToResult } =
    useAppState();

  const existing = decisions[reviewIndex];
  const hasArw = !!photo.arwPath;
  const hasJpg = !!photo.jpgPath;

  const [includeArw, setIncludeArw] = useState(existing?.includeArw ?? false);
  const [newName, setNewName] = useState(existing?.newName ?? "");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // Sync inputs when the photo changes (also when stepping back to an edited one).
  useEffect(() => {
    setIncludeArw(existing?.includeArw ?? false);
    setNewName(existing?.newName ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewIndex]);

  // Load the JPG preview; revoke the object URL on change/unmount.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setImgUrl(null);
    setImgError(false);
    if (photo.jpgPath) {
      loadImageUrl(photo.jpgPath)
        .then((u) => {
          if (cancelled) {
            URL.revokeObjectURL(u);
            return;
          }
          url = u;
          setImgUrl(u);
        })
        .catch(() => !cancelled && setImgError(true));
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [photo.jpgPath]);

  // Quality analysis (blur + exposure), computed in Rust off the UI thread.
  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    if (!photo.jpgPath) {
      setAnalyzing(false);
      return;
    }
    setAnalyzing(true);
    analyzeImage(photo.jpgPath)
      .then((a) => !cancelled && setAnalysis(a))
      .catch(() => !cancelled && setAnalysis(null))
      .finally(() => !cancelled && setAnalyzing(false));
    return () => {
      cancelled = true;
    };
  }, [photo.jpgPath]);

  function accept() {
    decideCurrent("accept", { includeArw, newName });
  }
  function reject() {
    decideCurrent("reject", { includeArw, newName });
  }

  // Keyboard: ← reject, → accept, Backspace prev. Ignored while typing a name.
  const acceptRef = useRef(accept);
  const rejectRef = useRef(reject);
  acceptRef.current = accept;
  rejectRef.current = reject;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        acceptRef.current();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        rejectRef.current();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        reviewPrev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="review">
      <header className="review-top">
        <button className="fc-btn" onClick={backToResult}>
          ← Results
        </button>
        <div className="review-counter">
          <span className="review-counter__now">{reviewIndex + 1}</span>
          <span className="review-counter__sep">/</span>
          <span>{photos.length}</span>
        </div>
        <button
          className="fc-btn"
          onClick={reviewPrev}
          disabled={reviewIndex === 0}
          title="Previous (Backspace)"
        >
          Undo
        </button>
      </header>

      <div className="review-progress">
        <i style={{ width: `${(reviewIndex / photos.length) * 100}%` }} />
      </div>

      {hasJpg ? (
        imgError ? (
          <div className="review-stage">
            <div className="review-noimg">Could not load JPG preview.</div>
          </div>
        ) : imgUrl ? (
          <PhotoViewer src={imgUrl} label={photo.baseName} />
        ) : (
          <div className="review-stage">
            <div className="review-loading">
              <div className="scan-spinner" aria-hidden />
            </div>
          </div>
        )
      ) : (
        <div className="review-stage">
          <div className="review-noimg">
            ARW only — no JPG preview.
            <br />
            Accepting will copy the RAW file.
          </div>
        </div>
      )}

      <div className="review-meta">
        <span className="review-name">{photo.baseName}</span>
        <span className="review-meta__right">
          <QualityReadout analysis={analysis} analyzing={analyzing} hasJpg={hasJpg} />
          <span className="review-chips">
            <span className={`fc-chip ${hasJpg ? "" : "is-off"}`}>JPG</span>
            <span className={`fc-chip ${hasArw ? "fc-chip--raw" : "is-off"}`}>ARW</span>
          </span>
        </span>
      </div>

      <div className="review-controls">
        <label className={`review-toggle ${hasArw ? "" : "is-disabled"}`}>
          <input
            type="checkbox"
            checked={hasArw ? includeArw : false}
            disabled={!hasArw}
            onChange={(e) => setIncludeArw(e.currentTarget.checked)}
          />
          <span>Copy ARW too</span>
          {!hasArw && <span className="review-toggle__hint">(no ARW)</span>}
        </label>

        <input
          className="fc-input review-rename"
          type="text"
          value={newName}
          placeholder={`Rename… (default: ${photo.baseName})`}
          onChange={(e) => setNewName(e.currentTarget.value)}
        />
      </div>

      <div className="review-actions">
        <button className="fc-btn fc-btn--reject review-btn" onClick={reject}>
          ← Reject
        </button>
        <button className="fc-btn fc-btn--primary review-btn" onClick={accept}>
          Accept →
        </button>
      </div>
    </div>
  );
}

function ReviewComplete() {
  const { photos, destDir, decisions, reviewPrev, copyStage, copyProgress, runCopy } =
    useAppState();

  const accepted = decisions.filter((d) => d?.kind === "accept").length;
  const rejected = decisions.filter((d) => d?.kind === "reject").length;
  const withArw = decisions.filter((d) => d?.kind === "accept" && d.includeArw).length;
  const renamed = decisions.filter((d) => d?.kind === "accept" && d.newName).length;

  return (
    <div className="review review--done">
      <h2>Review complete</h2>
      <p className="review-done-sub">Reviewed all {photos.length} photo(s).</p>

      <div className="scan-stats">
        <Stat label="Accepted" value={accepted} />
        <Stat label="Rejected" value={rejected} />
        <Stat label="With ARW" value={withArw} />
        <Stat label="Renamed" value={renamed} />
      </div>

      {copyStage === "idle" && (
        <>
          <p className="review-note">
            Accepted photos will be copied to <code>{destDir}</code> and recorded in
            the manifest. The source is never touched.
          </p>
          <div className="review-done-actions">
            <button className="fc-btn" onClick={reviewPrev}>
              ← Back to last photo
            </button>
            <button
              className="fc-btn fc-btn--primary"
              onClick={runCopy}
              disabled={accepted === 0}
              title={accepted === 0 ? "Nothing accepted to copy" : "Copy accepted"}
            >
              Copy {accepted} accepted →
            </button>
          </div>
        </>
      )}

      {copyStage === "copying" && (
        <div className="review-copying">
          <div className="scan-spinner" aria-hidden />
          <span>
            Copying {copyProgress?.done ?? 0} / {copyProgress?.total ?? accepted}…
          </span>
        </div>
      )}
    </div>
  );
}

/** Compact exposure readout, from the Rust `analyze_image` command.
 * Sharpness is judged by eye via focus peaking, so no blur label here. */
function QualityReadout({
  analysis,
  analyzing,
  hasJpg,
}: {
  analysis: ImageAnalysis | null;
  analyzing: boolean;
  hasJpg: boolean;
}) {
  if (!hasJpg) return null;
  if (analyzing && !analysis) {
    return <span className="review-quality review-quality--wait">analyzing…</span>;
  }
  if (!analysis) return null;

  const expTone = analysis.exposureLabel === "ok" ? "good" : "warn";

  return (
    <span className="review-quality">
      <span
        className={`review-metric review-metric--${expTone}`}
        title={`Clipped highlights ${analysis.overexposedPct.toFixed(1)}% · shadows ${analysis.underexposedPct.toFixed(1)}%`}
      >
        {analysis.exposureLabel}
      </span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="scan-stat">
      <div className="scan-stat__value">{value}</div>
      <div className="scan-stat__label">{label}</div>
    </div>
  );
}
