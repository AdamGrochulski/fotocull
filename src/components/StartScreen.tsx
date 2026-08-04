import { useAppState, isSourceValid, isDestValid } from "../state/appStore";
import { baseName } from "../lib/paths";
import type { DirStatus, FolderRole } from "../types/fs";
import "./StartScreen.css";

/**
 * Ekran startowy (Etap 1): wybór folderu źródłowego i docelowego + walidacja.
 * Skan nośnika (Etap 2) rusza dopiero po wybraniu obu poprawnych folderów.
 */
export function StartScreen() {
  const { loading, canProceed } = useAppState();

  return (
    <div className="start-screen">
      <header className="start-screen__brand">
        <h1 className="start-screen__title">fotocull</h1>
        <p className="start-screen__tagline">
          Szybka selekcja zdjęć z karty SD — akceptuj, odrzucaj, kopiuj.
        </p>
      </header>

      <section className="folder-grid">
        <FolderCard role="source" />
        <FolderCard role="dest" />
      </section>

      <button
        className="start-screen__proceed"
        disabled={!canProceed || loading}
        title={
          canProceed
            ? "Skanuj nośnik"
            : "Najpierw wybierz poprawny folder źródłowy i docelowy"
        }
      >
        Skanuj nośnik →
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
  const label = isSource ? "Folder źródłowy (karta SD)" : "Folder docelowy";
  const buttonLabel = dir ? "Zmień…" : "Wybierz…";

  return (
    <div className={`folder-card ${dir ? (valid ? "is-valid" : "is-invalid") : ""}`}>
      <div className="folder-card__head">
        <span className="folder-card__label">{label}</span>
        <button className="folder-card__btn" onClick={() => selectFolder(role)}>
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
        <div className="folder-card__empty">Nie wybrano.</div>
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

  let reason = "Nieprawidłowy folder.";
  if (!status.exists) reason = "Ścieżka nie istnieje.";
  else if (!status.isDir) reason = "To nie jest katalog.";
  else if (role === "source" && !status.readable)
    reason = "Brak uprawnień do odczytu.";
  else if (role === "dest" && !status.writable)
    reason = "Brak uprawnień do zapisu.";

  return <div className="folder-card__msg is-err">✕ {reason}</div>;
}
