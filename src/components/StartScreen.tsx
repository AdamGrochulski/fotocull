import { useAppState, isSourceValid, isDestValid } from "../state/appStore";
import { baseName } from "../lib/paths";
import type { DirStatus, FolderRole } from "../types/fs";
import { UpdateBanner } from "./UpdateBanner";
import "./StartScreen.css";

/**
 * Start screen (Stage 1): source and destination folder selection + validation.
 * The media scan (Stage 2) only starts once both valid folders are chosen.
 */
export function StartScreen() {
  const { loading, canProceed, startScan, scanError } = useAppState();

  return (
    <div className="start-screen">
      <header className="start-screen__brand">
        <h1 className="start-screen__title">fotocull</h1>
        <p className="start-screen__tagline">
          Fast photo culling from your SD card — keep, reject, copy.
        </p>
      </header>

      <UpdateBanner />

      <section className="folder-grid">
        <FolderCard role="source" />
        <FolderCard role="dest" />
      </section>

      {scanError && <div className="start-screen__error">Scan error: {scanError}</div>}

      <button
        className="fc-btn fc-btn--primary start-screen__proceed"
        disabled={!canProceed || loading}
        onClick={startScan}
        title={
          canProceed
            ? "Scan media"
            : "First choose a valid source and destination folder"
        }
      >
        Scan media →
      </button>
    </div>
  );
}

function FolderCard({ role }: { role: FolderRole }) {
  const { sourceDir, destDir, sourceStatus, destStatus, selectFolder } =
    useAppState();

  const isSource = role === "source";
  const dir = isSource ? sourceDir : destDir;
  const status = isSource ? sourceStatus : destStatus;
  const valid = isSource ? isSourceValid(status) : isDestValid(status);
  const label = isSource ? "Source folder (SD card)" : "Destination folder";
  const buttonLabel = dir ? "Change…" : "Choose…";

  return (
    <div className={`folder-card ${dir ? (valid ? "is-valid" : "is-invalid") : ""}`}>
      <div className="folder-card__head">
        <span className="folder-card__label">{label}</span>
        <button className="fc-btn" onClick={() => selectFolder(role)}>
          {buttonLabel}
        </button>
      </div>

      {dir ? (
        <>
          <div className="folder-card__name" title={dir}>
            {baseName(dir)}
          </div>
          <div className="folder-card__path" title={dir}>
            {dir}
          </div>
          <ValidationMsg role={role} status={status} />
        </>
      ) : (
        <div className="folder-card__empty">Not selected.</div>
      )}
    </div>
  );
}

function ValidationMsg({
  role,
  status,
}: {
  role: FolderRole;
  status: DirStatus | null;
}) {
  if (!status) return null;

  const valid = role === "source" ? isSourceValid(status) : isDestValid(status);
  if (valid) {
    return <div className="folder-card__msg is-ok">✓ OK</div>;
  }

  let reason = "Invalid folder.";
  if (!status.exists) reason = "Path does not exist.";
  else if (!status.isDir) reason = "Not a folder.";
  else if (role === "source" && !status.readable)
    reason = "No read permission.";
  else if (role === "dest" && !status.writable)
    reason = "No write permission.";

  return <div className="folder-card__msg is-err">✕ {reason}</div>;
}
