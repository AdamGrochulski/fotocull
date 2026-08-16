import { useAppState } from "../state/appStore";
import { openFolder } from "../lib/fs";
import "./SummaryScreen.css";

export function SummaryScreen() {
  const {
    destDir,
    decisions,
    videoDecisions,
    copyReport,
    videoReport,
    resetToSetup,
    startScan,
  } = useAppState();

  const accepted = decisions.filter((d) => d?.kind === "accept").length;
  const rejected = decisions.filter((d) => d?.kind === "reject").length;
  const withArw = decisions.filter((d) => d?.kind === "accept" && d.includeArw).length;
  const renamed = decisions.filter((d) => d?.kind === "accept" && d.newName).length;

  const videosAccepted = videoDecisions.filter((d) => d?.kind === "accept").length;
  const hadVideos = videoDecisions.some((d) => d !== undefined);

  const totalCopied = (copyReport?.copied ?? 0) + (videoReport?.copied ?? 0);
  const totalFiles = (copyReport?.filesCopied ?? 0) + (videoReport?.filesCopied ?? 0);
  const errors = [...(copyReport?.errors ?? []), ...(videoReport?.errors ?? [])];

  return (
    <div className="summary">
      <header className="summary-head">
        <div className="summary-mark" aria-hidden>
          ✓
        </div>
        <h1>Session complete</h1>
        <p className="summary-sub">
          Copied {totalCopied} item(s) — {totalFiles} file(s).
        </p>
      </header>

      <div className="scan-stats summary-stats">
        <Stat label="Accepted" value={accepted} />
        <Stat label="Rejected" value={rejected} />
        <Stat label="With ARW" value={withArw} />
        <Stat label="Renamed" value={renamed} />
        {hadVideos && <Stat label="Videos kept" value={videosAccepted} />}
      </div>

      <div className="summary-dest">
        <span className="fc-label">Saved to</span>
        <code className="summary-path">{destDir}</code>
        <button
          className="fc-btn"
          onClick={() => destDir && openFolder(destDir)}
          disabled={!destDir}
        >
          Open folder
        </button>
      </div>

      {errors.length > 0 && (
        <div className="summary-errors">
          <strong>{errors.length} error(s) during copy:</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="summary-actions">
        <button className="fc-btn" onClick={startScan}>
          Scan again
        </button>
        <button className="fc-btn fc-btn--primary" onClick={resetToSetup}>
          New session
        </button>
      </div>

      <p className="summary-note">
        “Scan again” re-scans the same source — already-copied photos are now
        hidden via the manifest.
      </p>
    </div>
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
